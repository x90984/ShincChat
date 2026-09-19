// ============================================================================
// state.js — shared runtime state for horizontal scaling.
//
// Replaces the in-process Maps (sessions, waiting queues, pairs, presence)
// with Redis so any number of server instances can share the load. Two
// drivers are supported, chosen automatically:
//
//   REDIS_URL set  → node-redis over TCP (redis:// or rediss://). Enables
//                    the Socket.IO Redis adapter + an invalidation pub/sub
//                    bus, so MULTIPLE INSTANCES work correctly. Any Redis
//                    >= 5 (ZPOPMIN-era syntax not required; we only use
//                    ZADD/ZREM/ZRANGE + EVAL).
//
//   REDIS_URL unset → Upstash REST client (UPSTASH_REDIS_REST_URL/TOKEN,
//                    already required by db.js). SINGLE INSTANCE only — all
//                    shared state still works (queue/pairs even survive
//                    restarts), but there is no pub/sub, so cross-instance
//                    messaging/invalidation is impossible.
//
// All Redis reads that matter are fronted by short-TTL in-process caches,
// which is what keeps the whole system inside Upstash's free 500K
// commands/month budget at small scale and keeps latency ~0 at any scale.
// ============================================================================
const crypto = require('crypto');

const PREFIX = process.env.STATE_PREFIX || 'sc';
const K = {
  sess: (t) => `${PREFIX}:sess:${t}`,
  oauth: (s) => `${PREFIX}:oauth:${s}`,
  online: `${PREFIX}:online`,        // hash: userId -> "<instId>:<socketId>"
  sockinst: `${PREFIX}:sockinst`,    // hash: socketId -> instId
  sockuser: `${PREFIX}:sockuser`,    // hash: socketId -> userId
  pairs: `${PREFIX}:pairs`,          // hash: socketId -> partnerSocketId
  pairuser: `${PREFIX}:pairuser`,    // hash: socketId -> partner's userId
  convmap: `${PREFIX}:convmap`,      // hash: socketId -> conversationId
  queue: (g) => `${PREFIX}:q:${g}`,  // zset: socketId scored by queuedAt
  qentry: `${PREFIX}:qentry`,        // hash: socketId -> entry JSON
  blk: (u) => `${PREFIX}:blkset:${u}`,
  mut: (u) => `${PREFIX}:mutset:${u}`,
  inst: (i) => `${PREFIX}:inst:${i}`,
  lock: (n) => `${PREFIX}:lock:${n}`,
};

const INSTANCE_ID = process.env.INSTANCE_ID || crypto.randomUUID().slice(0, 8);
const SESSION_TTL_SEC = parseInt(process.env.SESSION_TTL_SEC || '604800', 10); // 7d
const BUS_CHANNEL = `${PREFIX}:bus`;

// ---- Small TTL caches (bounded) ------------------------------------------
function makeCache(ttlMs, maxSize) {
  const map = new Map();
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (e.exp < Date.now()) { map.delete(key); return undefined; }
      return e.v;
    },
    set(key, v) {
      if (map.size >= maxSize) {
        // evict oldest inserted (Map iteration order)
        const oldest = map.keys().next();
        if (!oldest.done) map.delete(oldest.value);
      }
      map.set(key, { v, exp: Date.now() + ttlMs });
    },
    del(key) { map.delete(key); },
  };
}
// Sessions: short cache so a Redis hiccup doesn't log everyone out, and so
// hot REST endpoints don't cost a Redis command per request.
const sessCache = makeCache(60_000, 50_000);
const pairCache = makeCache(45_000, 50_000);
const pairUserCache = makeCache(45_000, 50_000);
const convCache = makeCache(60_000, 50_000);
const onlineCache = makeCache(10_000, 50_000);
const instHealth = makeCache(30_000, 1_000);
const blkCache = makeCache(45_000, 50_000);
const mutCache = makeCache(45_000, 50_000);

// Sockets this instance has queued itself (the 5s retry sweep only re-try
// matches for its OWN sockets — every instance drains the shared queue in
// parallel via the atomic Lua matcher).
const localQueued = new Set();

// ---- Driver layer ---------------------------------------------------------
let drv = null;          // unified driver (see makeTcpDriver / makeRestDriver)
let tcpClient = null;    // primary TCP connection (also used for bus publish)
let busSubClient = null; // dedicated TCP connection in subscribe mode
let ioRef = null;
let dbRef = null;
let clustered = false;

function makeTcpDriver(client) {
  return {
    kind: 'tcp',
    get: (k) => client.get(k),
    set: (k, v, exSec) => (exSec ? client.set(k, v, { EX: exSec }) : client.set(k, v)),
    setNX: async (k, v, exSec) => (await client.set(k, v, { EX: exSec, NX: true })) === 'OK',
    getdel: (k) => client.getDel(k),
    del: (...ks) => client.del(ks),
    hget: (k, f) => client.hGet(k, f),
    hset: (k, f, v) => client.hSet(k, f, v),
    hdel: (k, ...fs) => client.hDel(k, fs),
    hmget: async (k, fs) => client.hmGet(k, fs),
    zrange: (k, start, stop) => client.zRange(k, start, stop),
    eval: (script, keys, args) => client.eval(script, { keys, arguments: args }),
  };
}

function makeRestDriver(redis) {
  return {
    kind: 'rest',
    get: (k) => redis.get(k),
    set: (k, v, exSec) => (exSec ? redis.set(k, v, { ex: exSec }) : redis.set(k, v)),
    setNX: async (k, v, exSec) => (await redis.set(k, v, { ex: exSec, nx: true })) === 'OK',
    getdel: (k) => redis.getdel(k),
    del: (...ks) => redis.del(...ks),
    hget: (k, f) => redis.hget(k, f),
    hset: (k, f, v) => redis.hset(k, { [f]: v }),
    hdel: (k, ...fs) => redis.hdel(k, ...fs),
    hmget: async (k, fs) => {
      const obj = await redis.hmget(k, ...fs); // Upstash returns {field: value}
      return fs.map((f) => (obj ? obj[f] : null));
    },
    zrange: (k, start, stop) => redis.zrange(k, start, stop),
    eval: (script, keys, args) => redis.eval(script, keys, args),
  };
}

// Redis errors must degrade the app, never crash a chat handler.
async function safe(promise, fallback, label) {
  try {
    return await promise;
  } catch (e) {
    console.error(`state: ${label} failed:`, e.message);
    return fallback;
  }
}

// ---- Invalidation bus (TCP mode only) -------------------------------------
// Local caches are authoritative for writes made by THIS instance; the bus
// tells OTHER instances to drop/refresh their copies of entries that changed.
function busPublish(msg) {
  if (!tcpClient) return;
  tcpClient.publish(BUS_CHANNEL, JSON.stringify({ ...msg, inst: INSTANCE_ID })).catch(() => {});
}

function onBusMessage(message) {
  let m;
  try { m = JSON.parse(message); } catch { return; }
  if (!m || m.inst === INSTANCE_ID) return; // our own writes already updated local caches
  switch (m.t) {
    case 'pair-set':
      pairCache.set(m.a, m.b); pairCache.set(m.b, m.a);
      if (m.aU !== undefined && m.aU !== null && m.aU !== '') pairUserCache.set(m.b, m.aU);
      if (m.bU !== undefined && m.bU !== null && m.bU !== '') pairUserCache.set(m.a, m.bU);
      break;
    case 'pair-del':
      pairCache.del(m.a); pairCache.del(m.b);
      pairUserCache.del(m.a); pairUserCache.del(m.b);
      convCache.del(m.a); convCache.del(m.b);
      break;
    case 'conv-set': convCache.set(m.s, m.c); break;
    case 'blk': blkCache.del(m.u); break;
    case 'mut': mutCache.del(m.u); break;
    case 'offline': onlineCache.del(m.u); break;
  }
}

// ---- Lua scripts (atomic multi-key operations) -----------------------------
// Matchmaking: scan the oldest of the opposite-gender queue, verify both
// sides' country/location scopes, skip users the seeker blocked, and pop the
// first compatible candidate — atomically, so two instances can never hand
// out the same person.
//
// KEYS[1] = opposite-gender queue zset, KEYS[2] = qentry hash
// ARGV[1] = self entry JSON, ARGV[2] = now (ms), ARGV[3] = self socketId,
// ARGV[4] = block count, ARGV[5..] = userIds the seeker has blocked
// Entry JSON fields (null fields omitted): g, m, c, la, lo, dc, qa, uid, inst
const MATCH_LUA = `
local S = cjson.decode(ARGV[1])
local now = tonumber(ARGV[2])
local selfId = ARGV[3]
local nblk = tonumber(ARGV[4])
local blk = {}
for i = 1, nblk do blk[ARGV[4 + i]] = true end

local function hav(lat1, lon1, lat2, lon2)
  local dLat = math.rad(lat2 - lat1)
  local dLon = math.rad(lon2 - lon1)
  local a = math.sin(dLat / 2) ^ 2 + math.cos(math.rad(lat1)) * math.cos(math.rad(lat2)) * math.sin(dLon / 2) ^ 2
  return 2 * 6371 * math.asin(math.sqrt(a))
end

local function scopeOf(mode, country, lat, lon, dc, qa)
  local el = now - (qa or now)
  if mode == 'india' then
    if el < 20000 then return { t = 'country', c = 'IN' } end
    return { t = 'any' }
  end
  if mode == 'country' then
    if country and el < 20000 then return { t = 'country', c = country } end
    return { t = 'any' }
  end
  if mode == 'nearby' then
    if lat and lon and el < 10000 then return { t = 'nearby', la = lat, lo = lon } end
    if el < 25000 then
      if dc then return { t = 'country', c = dc } end
      return { t = 'any' }
    end
    return { t = 'any' }
  end
  return { t = 'any' }
end

local function allows(sc, otherCountry, otherLat, otherLon)
  if sc.t == 'any' then return true end
  if sc.t == 'country' then return otherCountry ~= nil and otherCountry == sc.c end
  if sc.t == 'nearby' then
    if not otherLat or not otherLon then return false end
    return hav(sc.la, sc.lo, otherLat, otherLon) <= 100
  end
  return false
end

local function otherCountryOf(E)
  if E.dc then return E.dc end
  return E.c
end

local sScope = scopeOf(S.m, S.c, S.la, S.lo, S.dc, S.qa)
local scan = redis.call('ZRANGE', KEYS[1], 0, 63, 'WITHSCORES')
for i = 1, #scan, 2 do
  local id = scan[i]
  local score = scan[i + 1]
  local ej = redis.call('HGET', KEYS[2], id)
  if not ej then
    redis.call('ZREM', KEYS[1], id) -- orphan with no entry: sweep it out
  elseif id ~= selfId then
    local E = cjson.decode(ej)
    local blocked = E.uid and blk[E.uid]
    if not blocked then
      local eScope = scopeOf(E.m, E.c, E.la, E.lo, E.dc, E.qa)
      if allows(sScope, otherCountryOf(E), E.la, E.lo) and allows(eScope, otherCountryOf(S), S.la, S.lo) then
        redis.call('ZREM', KEYS[1], id)
        redis.call('HDEL', KEYS[2], id)
        return { id, ej, score }
      end
    end
  end
end
return {}
`;

// Atomically pair two sockets — fails if either is already paired. Also
// removes both from both queues and their queue entries.
// KEYS: pairs, pairuser, q:male, q:female, qentry. ARGV: a, b, aUser, bUser
const CLAIM_LUA = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end
if redis.call('HEXISTS', KEYS[1], ARGV[2]) == 1 then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2], ARGV[2], ARGV[1])
if ARGV[4] ~= '' then redis.call('HSET', KEYS[2], ARGV[1], ARGV[4]) end
if ARGV[3] ~= '' then redis.call('HSET', KEYS[2], ARGV[2], ARGV[3]) end
redis.call('ZREM', KEYS[3], ARGV[1], ARGV[2])
redis.call('ZREM', KEYS[4], ARGV[1], ARGV[2])
redis.call('HDEL', KEYS[5], ARGV[1], ARGV[2])
return 1
`;

// Unpair one side; returns the partner's socketId (or nil).
// KEYS: pairs, convmap, pairuser. ARGV: socketId
const RELEASE_LUA = `
local p = redis.call('HGET', KEYS[1], ARGV[1])
if not p then return nil end
redis.call('HDEL', KEYS[1], ARGV[1], p)
redis.call('HDEL', KEYS[2], ARGV[1], p)
redis.call('HDEL', KEYS[3], ARGV[1], p)
return p
`;

const ENQUEUE_LUA = `
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
return 1
`;

const DEQUEUE_LUA = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
return 1
`;

// Delete presence only if it still points at the socket that disconnected
// (a second tab must not erase the first when it closes).
const COND_OFFLINE_LUA = `
local v = redis.call('HGET', KEYS[1], ARGV[1])
if v == ARGV[2] then redis.call('HDEL', KEYS[1], ARGV[1]) return 1 end
return 0
`;

const oppGender = (g) => (g === 'male' ? 'female' : 'male');

// Entry JSON only carries non-null fields so Lua cjson never has to deal
// with cjson.null sentinels.
function encodeEntry(e) {
  const o = {};
  if (e.gender) o.g = e.gender;
  if (e.lookingFor) o.lf = e.lookingFor;
  o.m = e.countryMode || 'random';
  if (e.country) o.c = e.country;
  if (e.lat != null) o.la = e.lat;
  if (e.lon != null) o.lo = e.lon;
  if (e.detectedCountry) o.dc = e.detectedCountry;
  o.qa = e.queuedAt || Date.now();
  if (e.userId) o.uid = e.userId;
  o.inst = INSTANCE_ID;
  return JSON.stringify(o);
}

// ---- Sessions --------------------------------------------------------------
async function createSession(userId) {
  const token = crypto.randomUUID();
  await safe(drv.set(K.sess(token), userId, SESSION_TTL_SEC), null, 'createSession');
  sessCache.set(token, userId);
  return token;
}
async function getSessionUser(token) {
  if (!token) return null;
  const cached = sessCache.get(token);
  if (cached !== undefined) return cached;
  const userId = await safe(drv.get(K.sess(token)), null, 'getSessionUser');
  if (userId) sessCache.set(token, userId);
  return userId;
}

// ---- OAuth PKCE state (multi-instance login round-trips) -------------------
async function oauthStateSet(state, data, ttlSec = 300) {
  await safe(drv.set(K.oauth(state), JSON.stringify(data), ttlSec), null, 'oauthStateSet');
}
async function oauthStateTake(state) {
  const raw = await safe(drv.getdel(K.oauth(state)), null, 'oauthStateTake');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---- Block / mute lists ----------------------------------------------------
// Redis string (JSON array) per user, refreshed on login and on every
// block/mute write; local 45s cache in front. Cold-miss falls back to
// Postgres through db.js (only when a db handle was provided at init).
async function listOf(kind, cache, keyFn, dbFn, userId) {
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;
  let ids = null;
  const raw = await safe(drv.get(keyFn(userId)), null, 'listOf');
  if (raw) { try { ids = JSON.parse(raw); } catch { ids = null; } }
  if (!ids && dbRef && dbFn) {
    ids = await dbFn(userId).catch(() => null);
    if (ids) await safe(drv.set(keyFn(userId), JSON.stringify(ids), 300), null, 'listOf backfill');
  }
  const set = new Set(ids || []);
  cache.set(userId, set);
  return set;
}
const blocksOf = (userId) => listOf('blk', blkCache, K.blk, (u) => dbRef.getBlockedUserIds(u), userId);
const mutesOf = (userId) => listOf('mut', mutCache, K.mut, (u) => dbRef.getMutedUserIds(u), userId);

async function setBlocklist(userId, ids) {
  const arr = Array.from(ids || []);
  blkCache.set(userId, new Set(arr));
  await safe(drv.set(K.blk(userId), JSON.stringify(arr), 300), null, 'setBlocklist');
  busPublish({ t: 'blk', u: userId });
}
async function setMutelist(userId, ids) {
  const arr = Array.from(ids || []);
  mutCache.set(userId, new Set(arr));
  await safe(drv.set(K.mut(userId), JSON.stringify(arr), 300), null, 'setMutelist');
  busPublish({ t: 'mut', u: userId });
}
async function isBlockedPair(userIdA, userIdB) {
  if (!userIdA || !userIdB) return false;
  const [a, b] = await Promise.all([blocksOf(userIdA), blocksOf(userIdB)]);
  return a.has(userIdB) || b.has(userIdA);
}

// ---- Presence --------------------------------------------------------------
async function setOnline(userId, socketId) {
  const value = `${INSTANCE_ID}:${socketId}`;
  await safe(drv.hset(K.online, userId, value), null, 'setOnline');
  await safe(drv.hset(K.sockuser, socketId, userId), null, 'setOnline user');
  onlineCache.set(userId, { instanceId: INSTANCE_ID, socketId });
}
async function setOffline(userId, socketId) {
  await safe(drv.eval(COND_OFFLINE_LUA, [K.online], [userId, `${INSTANCE_ID}:${socketId}`]), 0, 'setOffline');
  onlineCache.del(userId);
  busPublish({ t: 'offline', u: userId });
}
async function instAlive(instId) {
  if (instId === INSTANCE_ID) return true;
  const cached = instHealth.get(instId);
  if (cached !== undefined) return cached;
  const v = await safe(drv.get(K.inst(instId)), null, 'instAlive');
  const ok = !!v;
  instHealth.set(instId, ok);
  return ok;
}
async function onlineSocketOf(userId) {
  const cached = onlineCache.get(userId);
  if (cached !== undefined) return cached;
  const v = await safe(drv.hget(K.online, userId), null, 'onlineSocketOf');
  let result = null;
  if (v) {
    const idx = v.indexOf(':');
    const o = { instanceId: v.slice(0, idx), socketId: v.slice(idx + 1) };
    if (await instAlive(o.instanceId)) result = o;
  }
  onlineCache.set(userId, result);
  return result;
}
// Batched check for list endpoints (friends, search, history...).
async function onlineSockets(userIds) {
  const out = new Map();
  const misses = [];
  for (const id of userIds) {
    const c = onlineCache.get(id);
    if (c !== undefined) out.set(id, c);
    else misses.push(id);
  }
  if (misses.length) {
    const rows = await safe(drv.hmget(K.online, misses), misses.map(() => null), 'onlineSockets');
    await Promise.all(misses.map(async (id, i) => {
      const v = rows[i];
      let o = null;
      if (v) {
        const idx = v.indexOf(':');
        const cand = { instanceId: v.slice(0, idx), socketId: v.slice(idx + 1) };
        if (await instAlive(cand.instanceId)) o = cand;
      }
      onlineCache.set(id, o);
      out.set(id, o);
    }));
  }
  return out;
}
const isOnline = async (userId) => (await onlineSocketOf(userId)) !== null;

// ---- Pairs -----------------------------------------------------------------
async function pairOf(socketId) {
  const c = pairCache.get(socketId);
  if (c !== undefined) return c;
  const p = await safe(drv.hget(K.pairs, socketId), null, 'pairOf');
  if (p) pairCache.set(socketId, p);
  return p;
}
async function pairUserOf(socketId) {
  const c = pairUserCache.get(socketId);
  if (c !== undefined) return c;
  const u = await safe(drv.hget(K.pairuser, socketId), null, 'pairUserOf');
  if (u) pairUserCache.set(socketId, u);
  return u;
}
function _notePair(a, b, aUser, bUser) {
  pairCache.set(a, b); pairCache.set(b, a);
  if (aUser) pairUserCache.set(b, aUser);
  if (bUser) pairUserCache.set(a, bUser);
}
// Pair two KNOWN sockets directly (friend call / resume) — atomic claim, so
// a concurrent queue match on another instance can't steal either side.
async function claimPair(a, b, aUser = '', bUser = '') {
  const ok = await safe(
    drv.eval(CLAIM_LUA, [K.pairs, K.pairuser, K.queue('male'), K.queue('female'), K.qentry], [a, b, aUser, bUser]),
    0, 'claimPair');
  if (Number(ok) !== 1) return false;
  localQueued.delete(a); localQueued.delete(b);
  _notePair(a, b, aUser, bUser);
  busPublish({ t: 'pair-set', a, b, aU: aUser, bU: bUser });
  return true;
}
// Unpair; returns the ex-partner's socketId (or null).
async function releasePair(socketId) {
  const partner = await safe(drv.eval(RELEASE_LUA, [K.pairs, K.convmap, K.pairuser], [socketId]), null, 'releasePair');
  pairCache.del(socketId); pairUserCache.del(socketId); convCache.del(socketId);
  if (partner) {
    pairCache.del(partner); pairUserCache.del(partner); convCache.del(partner);
    busPublish({ t: 'pair-del', a: socketId, b: partner });
  }
  return partner;
}
async function convSet(socketId, convId) {
  await safe(drv.hset(K.convmap, socketId, convId), null, 'convSet');
  convCache.set(socketId, convId);
  busPublish({ t: 'conv-set', s: socketId, c: convId });
}
async function convOf(socketId) {
  const c = convCache.get(socketId);
  if (c !== undefined) return c;
  const v = await safe(drv.hget(K.convmap, socketId), null, 'convOf');
  if (v) convCache.set(socketId, v);
  return v;
}

// ---- Matchmaking queue -----------------------------------------------------
async function enqueue(socketId, entry) {
  entry.queuedAt = entry.queuedAt || Date.now();
  await safe(
    drv.eval(ENQUEUE_LUA, [K.queue(entry.gender), K.qentry], [socketId, String(entry.queuedAt), encodeEntry(entry)]),
    null, 'enqueue');
  await safe(drv.hset(K.sockinst, socketId, INSTANCE_ID), null, 'enqueue sockinst');
  localQueued.add(socketId);
}
async function dequeue(socketId) {
  localQueued.delete(socketId);
  await safe(drv.eval(DEQUEUE_LUA, [K.queue('male'), K.queue('female'), K.qentry], [socketId]), null, 'dequeue');
}
// Refresh a queued entry after set-country-mode (harmless if not queued —
// the field is cleaned up by dequeue/disconnect/matcher GC later).
async function refreshEntry(socketId, entry) {
  if (localQueued.has(socketId)) {
    await safe(drv.hset(K.qentry, socketId, encodeEntry(entry)), null, 'refreshEntry');
  }
}
async function _requeueCandidate(socketId, score, entryJson) {
  // Put a popped candidate back with its ORIGINAL position in line.
  const e = JSON.parse(entryJson);
  await safe(drv.eval(ENQUEUE_LUA, [K.queue(e.g === 'male' ? 'male' : 'female'), K.qentry],
    [socketId, String(score), entryJson]), null, 'requeue');
}

// One matchmaking round for a local socket. Returns
// { candidateId, entry } when a pair was formed (pair already claimed
// atomically), or null when the socket was (re)queued to wait.
async function findMatch(socketId, entry) {
  entry.queuedAt = entry.queuedAt || Date.now();
  const opposite = oppGender(entry.gender);
  const blk = entry.userId ? Array.from(await blocksOf(entry.userId)).slice(0, 200) : [];

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await safe(
      drv.eval(MATCH_LUA, [K.queue(opposite), K.qentry],
        [encodeEntry(entry), String(Date.now()), socketId, String(blk.length), ...blk]),
      null, 'findMatch eval');
    if (Array.isArray(res) && res.length >= 3) {
      const [candId, candJson, candScore] = res;
      let candEntry;
      try { candEntry = JSON.parse(candJson); } catch { candEntry = null; }
      if (!candEntry) { await _requeueCandidate(candId, Number(candScore), candJson); continue; }
      // Reverse-direction block (the candidate has blocked the seeker) can't
      // be checked in Lua without shipping every user's blocklist, so it's
      // checked here; on collision the candidate simply goes back in line.
      if (entry.userId && candEntry.uid && (await blocksOf(candEntry.uid)).has(entry.userId)) {
        await _requeueCandidate(candId, Number(candScore), candJson);
        continue;
      }
      const claimed = await safe(
        drv.eval(CLAIM_LUA, [K.pairs, K.pairuser, K.queue('male'), K.queue('female'), K.qentry],
          [socketId, candId, entry.userId || '', candEntry.uid || '']),
        0, 'findMatch claim');
      if (Number(claimed) !== 1) {
        // Beaten to them by another match/call — let them try again fresh.
        await _requeueCandidate(candId, Number(candScore), candJson);
        continue;
      }
      localQueued.delete(socketId);
      localQueued.delete(candId); // same-instance candidate
      _notePair(socketId, candId, entry.userId, candEntry.uid);
      busPublish({ t: 'pair-set', a: socketId, b: candId, aU: entry.userId || '', bU: candEntry.uid || '' });
      return { candidateId: candId, entry: candEntry };
    }
    // Nobody compatible available right now → wait in line.
    await enqueue(socketId, entry);
    return null;
  }
  await enqueue(socketId, entry);
  return null;
}

// ---- Periodic leadership lock (sweeper/janitor singletons) -----------------
async function acquireLock(name, ttlSec) {
  return safe(drv.setNX(K.lock(name), INSTANCE_ID, ttlSec), false, 'acquireLock');
}

// Find local sockets whose partner's instance is dead (crashed instance left
// the pair half-dangling). Returns local socketIds to notify 'partner-left'.
async function sweepLocalPairs(localSocketIds) {
  const dead = [];
  for (const sid of localSocketIds) {
    const partner = await pairOf(sid);
    if (!partner) continue;
    const inst = await safe(drv.hget(K.sockinst, partner), null, 'sweepLocalPairs');
    if (inst && inst !== INSTANCE_ID && !(await instAlive(inst))) {
      dead.push(sid);
    }
  }
  return dead;
}

// Queue hygiene for crashed instances: drop queued entries whose owning
// instance heartbeat is gone. Leader-locked callers only.
async function janitorQueues(scanLimit = 150) {
  for (const g of ['male', 'female']) {
    const members = await safe(drv.zrange(K.queue(g), 0, scanLimit - 1), [], 'janitor zrange');
    for (const sid of members) {
      const raw = await safe(drv.hget(K.qentry, sid), null, 'janitor entry');
      if (!raw) { await safe(drv.eval(DEQUEUE_LUA, [K.queue('male'), K.queue('female'), K.qentry], [sid]), null, 'janitor dequeue'); continue; }
      let e = null;
      try { e = JSON.parse(raw); } catch { /* fall through */ }
      if (!e || (e.inst && e.inst !== INSTANCE_ID && !(await instAlive(e.inst)))) {
        await safe(drv.eval(DEQUEUE_LUA, [K.queue('male'), K.queue('female'), K.qentry], [sid]), null, 'janitor dequeue');
      }
    }
  }
}

async function socketUserOf(socketId) {
  return safe(drv.hget(K.sockuser, socketId), null, 'socketUserOf');
}
async function untrackSocket(socketId) {
  await safe(drv.hdel(K.sockinst, socketId), null, 'untrack sockinst');
  await safe(drv.hdel(K.sockuser, socketId), null, 'untrack sockuser');
}

// ---- Lifecycle ---------------------------------------------------------------
async function init({ io, db }) {
  ioRef = io || null;
  dbRef = db || null;
  const redisUrl = process.env.REDIS_URL || '';

  if (redisUrl) {
    const { createClient } = require('redis');
    const baseOpts = {
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => Math.min(250 * 2 ** retries, 15_000),
      },
    };
    tcpClient = createClient(baseOpts);
    tcpClient.on('error', (e) => console.error('Redis (main) error:', e.message));
    await tcpClient.connect();
    drv = makeTcpDriver(tcpClient);

    if (ioRef) {
      const { createAdapter } = require('@socket.io/redis-adapter');
      const pubClient = tcpClient.duplicate();
      const subClient = tcpClient.duplicate();
      pubClient.on('error', (e) => console.error('Redis (adapter pub) error:', e.message));
      subClient.on('error', (e) => console.error('Redis (adapter sub) error:', e.message));
      await Promise.all([pubClient.connect(), subClient.connect()]);
      ioRef.adapter(createAdapter(pubClient, subClient));
      busSubClient = tcpClient.duplicate();
      busSubClient.on('error', (e) => console.error('Redis (bus) error:', e.message));
      await busSubClient.connect();
      await busSubClient.subscribe(BUS_CHANNEL, onBusMessage);
      clustered = true;
    }
    console.log(`state: TCP Redis driver — cluster-capable (instance ${INSTANCE_ID})`);
  } else {
    // Single-instance mode over Upstash REST (same client db.js already uses).
    const { Redis } = require('@upstash/redis');
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
      throw new Error('state: UPSTASH_REDIS_REST_URL / TOKEN required when REDIS_URL is not set.');
    }
    const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    drv = makeRestDriver(redis);
    console.log(`state: Upstash REST driver — SINGLE INSTANCE mode (set REDIS_URL to scale out) (instance ${INSTANCE_ID})`);
  }

  // Instance heartbeat — the liveness signal janitors and presence checks use.
  await safe(drv.set(K.inst(INSTANCE_ID), '1', 75), null, 'heartbeat seed');
  setInterval(() => {
    safe(drv.set(K.inst(INSTANCE_ID), '1', 75), null, 'heartbeat');
    if (tcpClient) tcpClient.ping().catch(() => {});
  }, 30_000).unref();
}

async function shutdown() {
  await safe(drv.del(K.inst(INSTANCE_ID)), null, 'shutdown del inst');
  if (busSubClient) { await busSubClient.unsubscribe(BUS_CHANNEL).catch(() => {}); }
  // Socket.IO adapter connections close with their owning Server.
  if (tcpClient) await tcpClient.quit().catch(() => {});
}

module.exports = {
  INSTANCE_ID,
  init,
  shutdown,
  isClustered: () => clustered,
  // sessions
  createSession,
  getSessionUser,
  // oauth pkce
  oauthStateSet,
  oauthStateTake,
  // presence
  setOnline,
  setOffline,
  onlineSocketOf,
  onlineSockets,
  isOnline,
  // block/mute
  blocksOf,
  mutesOf,
  setBlocklist,
  setMutelist,
  isBlockedPair,
  // pairs
  pairOf,
  pairUserOf,
  claimPair,
  releasePair,
  convSet,
  convOf,
  sweepLocalPairs,
  // queue
  enqueue,
  dequeue,
  refreshEntry,
  findMatch,
  localQueued,
  // housekeeping
  acquireLock,
  janitorQueues,
  socketUserOf,
  untrackSocket,
};
