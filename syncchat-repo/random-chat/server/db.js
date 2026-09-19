// ============================================================================
// STAGE 1 OF 2 — this file now talks to Postgres (via Supabase's Supavisor
// pooler) + Upstash Redis instead of SQLite. It is NOT deployable by itself:
// every function below is now async (Postgres/Redis are network calls, SQLite
// wasn't), but index.js still calls them synchronously. Stage 2 updates
// index.js to `await` every call. Do not deploy until that's done.
// ============================================================================
require('dotenv').config(); // loads .env locally; on Render, real env vars are used and this is a harmless no-op
const crypto = require('crypto');
const { Pool } = require('pg');
const { Redis } = require('@upstash/redis');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — use the Supabase "Transaction" pooler connection string (port 6543).');
}
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set.');
}

// Supavisor (Supabase's pooler) speaks the Postgres wire protocol, so the
// regular `pg` driver works unchanged — just point DATABASE_URL at the
// pooled connection string instead of the direct one.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10 // keep small — Supavisor is what actually manages the real fan-out
});
pool.on('error', (err) => console.error('Unexpected Postgres pool error:', err));

async function query(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

// ---- Cache-aside layer (Layer 2 — replaces the old in-process Map cache;
// this one is shared across every server instance, not just one process) ----
const CACHE_TTL_SEC = 60;
async function cacheGet(key) {
  try { return await redis.get(key); } catch (e) { console.error('Redis get failed:', e.message); return null; }
}
async function cacheSet(key, value) {
  try { await redis.set(key, value, { ex: CACHE_TTL_SEC }); } catch (e) { console.error('Redis set failed:', e.message); }
}
async function cacheDel(key) {
  try { await redis.del(key); } catch (e) { console.error('Redis del failed:', e.message); }
}
const userKey = (id) => `user:${id}`;
const convoKey = (id) => `convo:${id}`;

// Batches the highest-frequency, lowest-value write (bumping a
// conversation's last-activity timestamp on every single message) instead
// of hitting Postgres per message. Flushed on a timer and on shutdown.
const pendingTouches = new Map(); // convId -> timestamp
let touchFlushTimer = null;
async function flushTouches() {
  if (touchFlushTimer) { clearTimeout(touchFlushTimer); touchFlushTimer = null; }
  if (pendingTouches.size === 0) return;
  const batch = Array.from(pendingTouches.entries());
  pendingTouches.clear();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [convId, ts] of batch) {
      await client.query('UPDATE conversations SET last_message_at = $1 WHERE id = $2', [ts, convId]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Batched touch flush failed:', e.message);
  } finally {
    client.release();
  }
  await Promise.all(batch.map(([convId]) => cacheDel(convoKey(convId))));
}
function queueTouchConversation(convId, ts) {
  pendingTouches.set(convId, ts);
  cacheDel(convoKey(convId)); // fire and forget — the flush above also clears it once written
  if (!touchFlushTimer) touchFlushTimer = setTimeout(flushTouches, 750);
}
async function flushPendingWrites() {
  await flushTouches();
}

// ---- Schema (idempotent — safe to run on every boot) ----
async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      username_lower TEXT NOT NULL UNIQUE,
      email TEXT,
      email_lower TEXT,
      phone TEXT,
      phone_hash TEXT,
      salt TEXT,
      hash TEXT,
      gender TEXT,
      oauth_provider TEXT,
      oauth_id TEXT,
      created_at BIGINT NOT NULL,
      is_premium INTEGER NOT NULL DEFAULT 0,
      is_banned INTEGER NOT NULL DEFAULT 0,
      last_country TEXT,
      display_name TEXT,
      bio TEXT,
      photo TEXT,
      last_lat DOUBLE PRECISION,
      last_lon DOUBLE PRECISION,
      location_updated_at BIGINT,
      birth_date TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_id)
      WHERE oauth_provider IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email_lower)
      WHERE email_lower IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_hash ON users(phone_hash)
      WHERE phone_hash IS NOT NULL;

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_a TEXT NOT NULL,
      user_b TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      last_message_at BIGINT,
      disappearing_mode TEXT NOT NULL DEFAULT 'none'
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_user_a ON conversations(user_a);
    CREATE INDEX IF NOT EXISTS idx_conversations_user_b ON conversations(user_b);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT,
      audio TEXT,
      ts BIGINT NOT NULL,
      seen_at BIGINT,
      deleted_for_everyone INTEGER NOT NULL DEFAULT 0,
      hidden_for TEXT,
      reply_to_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conversation_id, ts DESC);

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL,
      reported_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      details TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported_id);

    CREATE TABLE IF NOT EXISTS ads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT,
      image_url TEXT,
      link_url TEXT,
      placement TEXT NOT NULL DEFAULT 'gate',
      enabled INTEGER NOT NULL DEFAULT 1,
      impressions INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS premium_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      interval TEXT NOT NULL DEFAULT 'monthly',
      features TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY,
      from_user TEXT NOT NULL,
      to_user TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL,
      responded_at BIGINT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fr_pair ON friend_requests(from_user, to_user);
    CREATE INDEX IF NOT EXISTS idx_fr_to_status ON friend_requests(to_user, status);
    CREATE INDEX IF NOT EXISTS idx_fr_from_status ON friend_requests(from_user, status);

    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL,
      following_id TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (follower_id, following_id)
    );
    CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);

    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    -- Web Push subscriptions (new — for closed-tab/app notifications).
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

    -- Optional, encouraged-but-not-required YouTube channel link, shown on
    -- a user's public profile so other people can spot-check they're a
    -- real person and not a fraud/bot account.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS youtube_link TEXT;

    -- Public reviews left on a user's profile by people they've actually
    -- chatted with (gated via the conversations table). One review per
    -- reviewer/reviewed pair — later reviews from the same person update
    -- their existing one rather than stacking up.
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      reviewer_id TEXT NOT NULL,
      reviewed_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      tag TEXT NOT NULL DEFAULT 'genuine',
      comment TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      report_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(reviewer_id, reviewed_id)
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_reviewed ON reviews(reviewed_id);

    CREATE TABLE IF NOT EXISTS review_reports (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL,
      reporter_id TEXT NOT NULL,
      reason TEXT,
      created_at BIGINT NOT NULL,
      UNIQUE(review_id, reporter_id)
    );

    -- One-way block: blocker never gets matched with blocked again, and the
    -- current chat between them (if any) is ended immediately.
    CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY,
      blocker_id TEXT NOT NULL,
      blocked_id TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(blocker_id, blocked_id)
    );
    CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blocker_id);
    CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

    -- One-way mute: silences sound/badge notifications from muted_user_id,
    -- everywhere in the app, until unmuted.
    CREATE TABLE IF NOT EXISTS muted_users (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      muted_user_id TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE(user_id, muted_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_muted_users_user ON muted_users(user_id);
  `);

  const DEFAULT_SETTINGS = {
    auto_ban_on_report: true,
    country_match_defaults: { mode: 'india', country: null },
    monetization_methods: {
      banner_ads: { enabled: false, label: 'Banner Ads', note: 'Shown on the onboarding/gate screen and history panel.' },
      premium_subscription: { enabled: false, label: 'Premium Subscription', note: 'Recurring plans, managed under Premium Plans.' },
      pay_per_minute_video: { enabled: false, rateCents: 0, label: 'Pay-per-Minute Video', note: 'Charge per minute of video chat.' },
      coin_gifting: { enabled: false, coinPriceCents: 0, label: 'Coins / Gifting', note: 'In-app currency users can send each other or spend on perks.' },
      referral_program: { enabled: false, bonusCents: 0, label: 'Referral Program', note: 'Reward for inviting new users.' }
    }
  };
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, JSON.stringify(value)]);
  }
}
// Kicked off immediately; index.js's startup should await `db.ready` before
// listening (see Stage 2) so the app never serves a request before the
// schema exists.
const ready = initSchema().catch((e) => { console.error('Schema init failed:', e); process.exit(1); });

// ---- Users ----
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._]{1,28}[a-z0-9])?$/;
function normalizeUsername(raw) { return String(raw || '').trim().toLowerCase(); }
function usernameFormatError(username) {
  const u = normalizeUsername(username);
  if (u.length < 3) return 'Username must be at least 3 characters.';
  if (u.length > 30) return 'Username must be 30 characters or fewer.';
  if (!USERNAME_RE.test(u)) return 'Use only letters, numbers, periods and underscores.';
  return null;
}
async function isUsernameAvailable(username) {
  const u = normalizeUsername(username);
  if (usernameFormatError(u)) return false;
  const row = await queryOne(`SELECT 1 FROM users WHERE username_lower = $1`, [u]);
  return !row;
}

const MIN_AGE_YEARS = 18;
function birthDateError(birthDate) {
  const s = String(birthDate || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return 'Enter your date of birth.';
  const [, y, mo, d] = m.map(Number);
  const dob = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(dob.getTime()) || dob.getUTCFullYear() !== y || dob.getUTCMonth() !== mo - 1 || dob.getUTCDate() !== d) {
    return 'Enter a valid date of birth.';
  }
  const now = new Date();
  if (dob > now) return 'Enter a valid date of birth.';
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const hadBirthdayThisYear = (now.getUTCMonth() > dob.getUTCMonth()) ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() >= dob.getUTCDate());
  if (!hadBirthdayThisYear) age -= 1;
  if (age < MIN_AGE_YEARS) return `You must be at least ${MIN_AGE_YEARS} to use SyncChat.`;
  return null;
}

function normalizePhoneHash(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '').slice(-10);
  if (digits.length < 7) return null;
  return crypto.createHash('sha256').update(digits).digest('hex');
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
}

async function createUser({ email, password, gender = null, phone, username, displayName, birthDate, youtubeLink }) {
  email = email ? String(email).trim() : '';
  phone = phone ? String(phone).trim() : '';
  if (!email && !phone) throw new Error('Enter a mobile number or email address.');
  const emailLower = email ? email.toLowerCase() : null;
  if (emailLower && await queryOne(`SELECT 1 FROM users WHERE email_lower = $1`, [emailLower])) {
    throw new Error('An account with that email already exists.');
  }
  const ageErr = birthDateError(birthDate);
  if (ageErr) throw new Error(ageErr);
  let phoneHash = null;
  if (phone) {
    phoneHash = normalizePhoneHash(phone);
    if (!phoneHash) throw new Error('Enter a valid phone number.');
    if (await queryOne(`SELECT 1 FROM users WHERE phone_hash = $1`, [phoneHash])) {
      throw new Error('An account with that phone number already exists.');
    }
  }
  const usernameLower = normalizeUsername(username);
  const fmtErr = usernameFormatError(usernameLower);
  if (fmtErr) throw new Error(fmtErr);
  if (await queryOne(`SELECT 1 FROM users WHERE username_lower = $1`, [usernameLower])) {
    throw new Error('That username is already taken.');
  }
  const name = String(displayName || '').trim().slice(0, 50);
  if (!name) throw new Error('Enter your name.');
  const { salt, hash } = hashPassword(password);
  const id = crypto.randomUUID();
  const ytLink = isValidYoutubeUrl(youtubeLink) ? String(youtubeLink).trim().slice(0, 300) : null;
  await query(
    `INSERT INTO users (id, username, username_lower, email, email_lower, phone, phone_hash, salt, hash, gender, oauth_provider, oauth_id, created_at, display_name, birth_date, youtube_link)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,$11,$12,$13,$14)`,
    [id, username, usernameLower, email || null, emailLower, phone || null, phoneHash, salt, hash, gender, Date.now(), name, String(birthDate).trim(), ytLink]
  );
  return getUser(id);
}

async function findUserByUsername(username) {
  return queryOne(`SELECT * FROM users WHERE username_lower = $1`, [normalizeUsername(username)]);
}
async function findUserByEmail(email) {
  return queryOne(`SELECT * FROM users WHERE email_lower = $1`, [String(email || '').trim().toLowerCase()]);
}
async function findUserByIdentifier(identifier) {
  const id = String(identifier || '').trim();
  if (id.includes('@')) return findUserByEmail(id);
  return findUserByUsername(id);
}
async function findUsersByPhoneHashes(hashes) {
  if (!hashes || hashes.length === 0) return [];
  return query(`SELECT * FROM users WHERE phone_hash = ANY($1::text[])`, [hashes]);
}

async function getUser(id) {
  if (!id) return null;
  const cached = await cacheGet(userKey(id));
  if (cached) return cached;
  const user = await queryOne(`SELECT * FROM users WHERE id = $1`, [id]);
  if (user) await cacheSet(userKey(id), user);
  return user;
}
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id, username: user.username, displayName: user.display_name || user.username,
    bio: user.bio || '', photoUrl: user.photo || null, gender: user.gender || null,
    youtubeLink: user.youtube_link || null,
    hasBirthDate: !!user.birth_date, hasPhone: !!user.phone_hash, isPremium: !!user.is_premium
  };
}

async function findOrCreateOAuthUser({ provider, providerId, email, displayName }) {
  let user = await queryOne(`SELECT * FROM users WHERE oauth_provider = $1 AND oauth_id = $2`, [provider, providerId]);
  if (user) return user;
  const emailLower = email ? String(email).trim().toLowerCase() : null;
  const id = crypto.randomUUID();
  let usernameLower = normalizeUsername((displayName || 'user').replace(/[^a-z0-9._]/gi, '').slice(0, 20) || 'user');
  if (usernameFormatError(usernameLower)) usernameLower = 'user';
  let candidate = usernameLower;
  let n = 0;
  while (await queryOne(`SELECT 1 FROM users WHERE username_lower = $1`, [candidate])) {
    n += 1;
    candidate = `${usernameLower}${n}`;
  }
  await query(
    `INSERT INTO users (id, username, username_lower, email, email_lower, oauth_provider, oauth_id, created_at, display_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, candidate, candidate, email || null, emailLower, provider, providerId, Date.now(), displayName || candidate]
  );
  return getUser(id);
}

async function setGender(userId, gender) {
  const rows = await query(`UPDATE users SET gender = $1 WHERE id = $2 AND gender IS NULL RETURNING id`, [gender, userId]);
  if (rows.length > 0) await cacheDel(userKey(userId));
  return rows.length > 0;
}
async function setPhone(userId, phone) {
  const phoneHash = normalizePhoneHash(phone);
  if (!phoneHash) throw new Error('Enter a valid phone number.');
  if (await queryOne(`SELECT 1 FROM users WHERE phone_hash = $1`, [phoneHash])) {
    throw new Error('An account with that phone number already exists.');
  }
  const rows = await query(`UPDATE users SET phone = $1, phone_hash = $2 WHERE id = $3 AND phone_hash IS NULL RETURNING id`, [phone.trim(), phoneHash, userId]);
  if (rows.length > 0) await cacheDel(userKey(userId));
  return rows.length > 0;
}
async function setBirthDate(userId, birthDate) {
  const err = birthDateError(birthDate);
  if (err) throw new Error(err);
  await query(`UPDATE users SET birth_date = $1 WHERE id = $2 AND birth_date IS NULL`, [String(birthDate).trim(), userId]);
  await cacheDel(userKey(userId));
}

// ---- Conversations ----
async function findOrCreateConversation(idA, idB) {
  const existing = await queryOne(
    `SELECT * FROM conversations WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)`,
    [idA, idB]
  );
  if (existing) return existing;
  const convo = { id: crypto.randomUUID(), user_a: idA, user_b: idB, created_at: Date.now(), last_message_at: null, disappearing_mode: 'none' };
  await query(`INSERT INTO conversations (id, user_a, user_b, created_at, last_message_at) VALUES ($1,$2,$3,$4,NULL)`, [convo.id, idA, idB, convo.created_at]);
  return convo;
}
async function getConversation(convId) {
  const cached = await cacheGet(convoKey(convId));
  if (cached) return cached;
  const convo = await queryOne(`SELECT * FROM conversations WHERE id = $1`, [convId]);
  if (convo) await cacheSet(convoKey(convId), convo);
  return convo;
}
async function listConversationsForUser(userId) {
  return query(
    `SELECT * FROM conversations WHERE user_a = $1 OR user_b = $1 ORDER BY COALESCE(last_message_at, created_at) DESC`,
    [userId]
  );
}
function otherUserId(convo, userId) { return convo.user_a === userId ? convo.user_b : convo.user_a; }

// ---- Messages ----
const DISAPPEARING_MODES = new Set(['none', '24h', 'on_view']);
const DISAPPEARING_24H_MS = 24 * 60 * 60 * 1000;

async function addMessage(convId, { senderId, type, text, audio, replyToId }) {
  const msg = {
    id: crypto.randomUUID(), conversation_id: convId, sender_id: senderId, type,
    text: text ?? null, audio: audio ?? null, ts: Date.now(), reply_to_id: replyToId || null
  };
  await query(
    `INSERT INTO messages (id, conversation_id, sender_id, type, text, audio, ts, reply_to_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [msg.id, msg.conversation_id, msg.sender_id, msg.type, msg.text, msg.audio, msg.ts, msg.reply_to_id]
  );
  queueTouchConversation(convId, msg.ts);
  return msg;
}

async function shapeMessage(row, viewerId, disappearingMode) {
  const hiddenFor = row.hidden_for ? JSON.parse(row.hidden_for) : [];
  if (hiddenFor.includes(viewerId)) return null;
  const lazyExpired = disappearingMode === '24h' && !row.deleted_for_everyone && (Number(row.ts) + DISAPPEARING_24H_MS <= Date.now());
  const deleted = !!row.deleted_for_everyone || lazyExpired;
  let replyPreview = null;
  if (row.reply_to_id) {
    const replied = await queryOne(`SELECT * FROM messages WHERE id = $1`, [row.reply_to_id]);
    if (replied && !replied.deleted_for_everyone) {
      replyPreview = { id: replied.id, senderId: replied.sender_id, text: replied.type === 'voice' ? 'Voice message' : replied.text };
    }
  }
  return {
    id: row.id, type: deleted ? 'text' : row.type,
    text: deleted ? null : row.text, audio: deleted ? null : row.audio,
    ts: Number(row.ts), mine: row.sender_id === viewerId, deleted,
    seenAt: row.seen_at ? Number(row.seen_at) : null, replyTo: replyPreview
  };
}

// Keyset (cursor) pagination — pass `beforeTs` to page backwards through
// history instead of an OFFSET, which stays fast no matter how deep into a
// long chat history you page. Returns oldest-first (same shape callers
// already expect from the old getMessages).
async function getMessages(convId, viewerId, { beforeTs = null, limit = 50 } = {}) {
  const convo = await getConversation(convId);
  const mode = convo ? convo.disappearing_mode : 'none';
  const rows = beforeTs
    ? await query(`SELECT * FROM messages WHERE conversation_id = $1 AND ts < $2 ORDER BY ts DESC LIMIT $3`, [convId, beforeTs, limit])
    : await query(`SELECT * FROM messages WHERE conversation_id = $1 ORDER BY ts DESC LIMIT $2`, [convId, limit]);
  const shaped = await Promise.all(rows.map(row => shapeMessage(row, viewerId, mode)));
  return shaped.filter(Boolean).reverse();
}

async function getLastMessage(convId) {
  return queryOne(`SELECT * FROM messages WHERE conversation_id = $1 AND deleted_for_everyone = 0 ORDER BY ts DESC LIMIT 1`, [convId]);
}
async function getUnreadCount(convId, viewerId) {
  const row = await queryOne(
    `SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = $1 AND sender_id != $2 AND seen_at IS NULL AND deleted_for_everyone = 0`,
    [convId, viewerId]
  );
  return row ? Number(row.cnt) : 0;
}
async function setDisappearingMode(convId, mode) {
  if (!DISAPPEARING_MODES.has(mode)) throw new Error('Invalid disappearing-messages mode.');
  await query(`UPDATE conversations SET disappearing_mode = $1 WHERE id = $2`, [mode, convId]);
  await cacheDel(convoKey(convId));
  return mode;
}
async function markSeen(convId, viewerId) {
  const convo = await getConversation(convId);
  const rows = await query(
    `SELECT * FROM messages WHERE conversation_id = $1 AND sender_id != $2 AND seen_at IS NULL AND deleted_for_everyone = 0`,
    [convId, viewerId]
  );
  const now = Date.now();
  const seenIds = [];
  const deletedIds = [];
  for (const row of rows) {
    await query(`UPDATE messages SET seen_at = $1 WHERE id = $2 AND seen_at IS NULL`, [now, row.id]);
    seenIds.push(row.id);
    if (convo && convo.disappearing_mode === 'on_view') {
      await query(`UPDATE messages SET deleted_for_everyone = 1, text = NULL, audio = NULL WHERE id = $1`, [row.id]);
      deletedIds.push(row.id);
    }
  }
  return { seenIds, deletedIds };
}
async function deleteMessageForMe(messageId, userId) {
  const row = await queryOne(`SELECT * FROM messages WHERE id = $1`, [messageId]);
  if (!row) return false;
  const hiddenFor = row.hidden_for ? JSON.parse(row.hidden_for) : [];
  if (!hiddenFor.includes(userId)) hiddenFor.push(userId);
  await query(`UPDATE messages SET hidden_for = $1 WHERE id = $2`, [JSON.stringify(hiddenFor), messageId]);
  return true;
}
async function deleteMessageForEveryone(messageId, userId) {
  const row = await queryOne(`SELECT * FROM messages WHERE id = $1`, [messageId]);
  if (!row) throw new Error('Message not found.');
  if (row.sender_id !== userId) throw new Error('You can only delete your own messages for everyone.');
  await query(`UPDATE messages SET deleted_for_everyone = 1, text = NULL, audio = NULL WHERE id = $1`, [messageId]);
  return row.conversation_id;
}
async function sweepExpiredMessages() {
  const rows = await query(
    `SELECT m.id, m.conversation_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.disappearing_mode = '24h' AND m.deleted_for_everyone = 0 AND m.ts <= $1`,
    [Date.now() - DISAPPEARING_24H_MS]
  );
  const cleared = [];
  for (const row of rows) {
    await query(`UPDATE messages SET deleted_for_everyone = 1, text = NULL, audio = NULL WHERE id = $1`, [row.id]);
    cleared.push({ conversationId: row.conversation_id, id: row.id });
  }
  return cleared;
}
async function deleteAllConversationsForUser(userId) {
  const convos = await listConversationsForUser(userId);
  for (const c of convos) {
    await query(`DELETE FROM messages WHERE conversation_id = $1`, [c.id]);
    await query(`DELETE FROM conversations WHERE id = $1`, [c.id]);
    await cacheDel(convoKey(c.id));
    pendingTouches.delete(c.id);
  }
  return convos.map(c => ({ id: c.id, otherUserId: otherUserId(c, userId) }));
}
// "Clear chat" for a single conversation — removes it (and its messages)
// entirely, same behavior as deleteAllConversationsForUser but scoped to
// one thread. Caller is responsible for checking the requester is a member.
async function deleteConversation(conversationId) {
  await query(`DELETE FROM messages WHERE conversation_id = $1`, [conversationId]);
  await query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
  await cacheDel(convoKey(conversationId));
  pendingTouches.delete(conversationId);
}

// ---- Blocks ----
// One-directional: blockerId never wants to see blockedId again. Matching
// should treat this as mutual (skip the pair either way round).
async function blockUser(blockerId, blockedId) {
  await query(
    `INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
    [crypto.randomUUID(), blockerId, blockedId, Date.now()]
  );
}
async function unblockUser(blockerId, blockedId) {
  await query(`DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [blockerId, blockedId]);
}
async function isBlockedByMe(blockerId, blockedId) {
  const row = await queryOne(`SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [blockerId, blockedId]);
  return !!row;
}
async function getBlockedUserIds(blockerId) {
  const rows = await query(`SELECT blocked_id FROM blocks WHERE blocker_id = $1`, [blockerId]);
  return rows.map(r => r.blocked_id);
}

// ---- Mutes ----
// One-directional: userId doesn't want notifications from mutedUserId.
async function muteUser(userId, mutedUserId) {
  await query(
    `INSERT INTO muted_users (id, user_id, muted_user_id, created_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, muted_user_id) DO NOTHING`,
    [crypto.randomUUID(), userId, mutedUserId, Date.now()]
  );
}
async function unmuteUser(userId, mutedUserId) {
  await query(`DELETE FROM muted_users WHERE user_id = $1 AND muted_user_id = $2`, [userId, mutedUserId]);
}
async function isMuted(userId, mutedUserId) {
  const row = await queryOne(`SELECT 1 FROM muted_users WHERE user_id = $1 AND muted_user_id = $2`, [userId, mutedUserId]);
  return !!row;
}
async function getMutedUserIds(userId) {
  const rows = await query(`SELECT muted_user_id FROM muted_users WHERE user_id = $1`, [userId]);
  return rows.map(r => r.muted_user_id);
}

// ---- Reports & bans ----
async function addReport({ reporterId, reportedId, reason, details }) {
  const report = { id: crypto.randomUUID(), reporter_id: reporterId, reported_id: reportedId, reason, details: details ?? null, created_at: Date.now() };
  await query(
    `INSERT INTO reports (id, reporter_id, reported_id, reason, details, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [report.id, report.reporter_id, report.reported_id, report.reason, report.details, report.created_at]
  );
  return report;
}
async function banUser(userId) {
  await query(`UPDATE users SET is_banned = 1 WHERE id = $1`, [userId]);
  await cacheDel(userKey(userId));
}
async function isUserBanned(userId) {
  const u = await getUser(userId);
  return !!(u && u.is_banned);
}

// ---- Settings ----
async function getSetting(key, fallback = null) {
  const row = await queryOne(`SELECT value FROM settings WHERE key = $1`, [key]);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

// ---- Friends / friend requests ----
async function sendFriendRequest(fromId, toId) {
  if (fromId === toId) throw new Error("Can't add yourself as a friend.");
  const reverse = await queryOne(`SELECT * FROM friend_requests WHERE from_user = $1 AND to_user = $2`, [toId, fromId]);
  if (reverse && reverse.status === 'accepted') return { status: 'accepted' };
  if (reverse && reverse.status === 'pending') {
    await query(`UPDATE friend_requests SET status = 'accepted', responded_at = $1 WHERE id = $2`, [Date.now(), reverse.id]);
    return { status: 'accepted' };
  }
  const existing = await queryOne(`SELECT * FROM friend_requests WHERE from_user = $1 AND to_user = $2`, [fromId, toId]);
  if (existing && existing.status === 'accepted') return { status: 'accepted' };
  if (existing && existing.status === 'pending') return { status: 'pending' };
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO friend_requests (id, from_user, to_user, status, created_at, responded_at)
     VALUES ($1,$2,$3,'pending',$4,NULL)
     ON CONFLICT (from_user, to_user) DO UPDATE SET status = 'pending', created_at = $4, responded_at = NULL`,
    [id, fromId, toId, Date.now()]
  );
  return { status: 'pending' };
}
async function respondFriendRequest(requestId, byUserId, action) {
  const req = await queryOne(`SELECT * FROM friend_requests WHERE id = $1`, [requestId]);
  if (!req || req.to_user !== byUserId || req.status !== 'pending') return null;
  const status = action === 'accept' ? 'accepted' : 'rejected';
  await query(`UPDATE friend_requests SET status = $1, responded_at = $2 WHERE id = $3`, [status, Date.now(), requestId]);
  return { ...req, status };
}
async function unfriend(userA, userB) {
  await query(
    `DELETE FROM friend_requests WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)`,
    [userA, userB]
  );
}
async function friendStatusBetween(viewerId, otherId) {
  const out = await queryOne(`SELECT * FROM friend_requests WHERE from_user = $1 AND to_user = $2`, [viewerId, otherId]);
  if (out) {
    if (out.status === 'accepted') return 'friends';
    if (out.status === 'pending') return 'pending_outgoing';
  }
  const inc = await queryOne(`SELECT * FROM friend_requests WHERE from_user = $1 AND to_user = $2`, [otherId, viewerId]);
  if (inc) {
    if (inc.status === 'accepted') return 'friends';
    if (inc.status === 'pending') return 'pending_incoming';
  }
  return 'none';
}
async function areFriends(userA, userB) {
  return (await friendStatusBetween(userA, userB)) === 'friends';
}
async function listIncomingRequests(userId) {
  const rows = await query(`SELECT * FROM friend_requests WHERE to_user = $1 AND status = 'pending' ORDER BY created_at DESC`, [userId]);
  return rows.map(r => ({ ...r, otherUser: r.from_user }));
}
async function listFriendIds(userId) {
  const rows = await query(
    `SELECT * FROM friend_requests WHERE (from_user = $1 OR to_user = $1) AND status = 'accepted' ORDER BY responded_at DESC`,
    [userId]
  );
  return rows.map(r => (r.from_user === userId ? r.to_user : r.from_user));
}

// ---- Follows ----
async function followUser(followerId, targetId) {
  if (followerId === targetId) throw new Error("You can't follow yourself.");
  await query(`INSERT INTO follows (follower_id, following_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [followerId, targetId, Date.now()]);
}
async function unfollowUser(followerId, targetId) {
  await query(`DELETE FROM follows WHERE follower_id = $1 AND following_id = $2`, [followerId, targetId]);
}
async function isFollowing(followerId, targetId) {
  return !!(await queryOne(`SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2`, [followerId, targetId]));
}
async function getFollowCounts(userId) {
  const followers = await queryOne(`SELECT COUNT(*) AS cnt FROM follows WHERE following_id = $1`, [userId]);
  const following = await queryOne(`SELECT COUNT(*) AS cnt FROM follows WHERE follower_id = $1`, [userId]);
  return { followers: Number(followers.cnt), following: Number(following.cnt) };
}

async function searchUsers(queryStr, excludeUserId, limit = 20) {
  const like = `%${queryStr.trim().toLowerCase().replace(/[%_]/g, '')}%`;
  return query(
    `SELECT * FROM users WHERE username_lower LIKE $1 AND id != $2 AND is_banned = 0 ORDER BY username_lower ASC LIMIT $3`,
    [like, excludeUserId, limit]
  );
}

async function setLastCountry(userId, country) {
  if (!country) return;
  await query(`UPDATE users SET last_country = $1 WHERE id = $2`, [country, userId]);
  await cacheDel(userKey(userId));
}

const PROFILE_NAME_MAX = 50;
const PROFILE_BIO_MAX = 280;
const PROFILE_PHOTO_MAX_CHARS = 1_500_000;

function isValidYoutubeUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, '');
    return host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
  } catch {
    return false;
  }
}

async function updateProfile(userId, { displayName, bio, photo, youtubeLink } = {}) {
  const name = typeof displayName === 'string' ? displayName.trim().slice(0, PROFILE_NAME_MAX) : '';
  const bioText = typeof bio === 'string' ? bio.trim().slice(0, PROFILE_BIO_MAX) : '';
  let photoData = null;
  if (typeof photo === 'string' && photo.startsWith('data:image/')) {
    if (photo.length > PROFILE_PHOTO_MAX_CHARS) throw new Error('Photo is too large.');
    photoData = photo;
  }
  // Optional and encouraged, not required — an empty string clears it,
  // undefined leaves the existing value untouched.
  let youtubeUpdate;
  if (youtubeLink === undefined) {
    youtubeUpdate = undefined;
  } else if (!youtubeLink || !String(youtubeLink).trim()) {
    youtubeUpdate = null;
  } else if (isValidYoutubeUrl(youtubeLink)) {
    youtubeUpdate = String(youtubeLink).trim().slice(0, 300);
  } else {
    throw new Error('That doesn\u2019t look like a valid YouTube link.');
  }
  await query(
    `UPDATE users SET display_name = $1, bio = $2, photo = COALESCE($3, photo), youtube_link = COALESCE($4, youtube_link) WHERE id = $5`,
    [name || null, bioText || null, photoData, youtubeUpdate === undefined ? null : youtubeUpdate, userId]
  );
  // COALESCE above can't distinguish "clear it" from "leave it" when we
  // pass null for both, so handle explicit clearing separately.
  if (youtubeUpdate === null) {
    await query(`UPDATE users SET youtube_link = NULL WHERE id = $1`, [userId]);
  }
  await cacheDel(userKey(userId));
  return getUser(userId);
}

async function setLastLocation(userId, lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || Number.isNaN(lat) || Number.isNaN(lon)) return;
  await query(`UPDATE users SET last_lat = $1, last_lon = $2, location_updated_at = $3 WHERE id = $4`, [lat, lon, Date.now(), userId]);
  await cacheDel(userKey(userId));
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function findNearbyUsers(lat, lon, radiusKm, excludeId) {
  const degLat = radiusKm / 111;
  const degLon = radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const rows = await query(
    `SELECT * FROM users WHERE id != $1 AND is_banned = 0 AND last_lat BETWEEN $2 AND $3 AND last_lon BETWEEN $4 AND $5 LIMIT 200`,
    [excludeId, lat - degLat, lat + degLat, lon - degLon, lon + degLon]
  );
  return rows
    .map(u => ({ user: u, km: haversineKm(lat, lon, u.last_lat, u.last_lon) }))
    .filter(r => r.km <= radiusKm)
    .sort((a, b) => a.km - b.km)
    .map(r => r.user);
}

const SUGGEST_NEARBY_RADIUS_KM = 50;

async function suggestFriends(userId, limit = 20) {
  const myFriends = new Set(await listFriendIds(userId));
  const mutualCount = new Map();
  for (const fid of myFriends) {
    for (const ffid of await listFriendIds(fid)) {
      if (ffid === userId || myFriends.has(ffid)) continue;
      mutualCount.set(ffid, (mutualCount.get(ffid) || 0) + 1);
    }
  }
  const ranked = [...mutualCount.entries()].sort((a, b) => b[1] - a[1]);
  const seen = new Set();
  const picks = [];
  for (const [id, count] of ranked) {
    if (picks.length >= limit) break;
    seen.add(id);
    picks.push({ id, reason: 'mutual', mutualCount: count });
  }
  const me = await getUser(userId);
  if (picks.length < limit && me && me.last_lat != null && me.last_lon != null) {
    for (const row of await findNearbyUsers(me.last_lat, me.last_lon, SUGGEST_NEARBY_RADIUS_KM, userId)) {
      if (picks.length >= limit) break;
      if (seen.has(row.id) || myFriends.has(row.id)) continue;
      seen.add(row.id);
      picks.push({ id: row.id, reason: 'nearby', mutualCount: 0 });
    }
  }
  if (picks.length < limit && me && me.last_country) {
    const rows = await query(`SELECT * FROM users WHERE last_country = $1 AND id != $2 AND is_banned = 0 LIMIT 50`, [me.last_country, userId]);
    for (const row of rows) {
      if (picks.length >= limit) break;
      if (seen.has(row.id) || myFriends.has(row.id)) continue;
      seen.add(row.id);
      picks.push({ id: row.id, reason: 'nearby', mutualCount: 0 });
    }
  }
  const results = [];
  for (const p of picks) {
    const u = await getUser(p.id);
    if (!u) continue;
    const status = await friendStatusBetween(userId, p.id);
    if (status === 'friends') continue;
    results.push({ ...publicUser(u), friendStatus: status, reason: p.reason, mutualCount: p.mutualCount });
  }
  return results;
}

// ---- Push notification subscriptions (new) ----
async function savePushSubscription(userId, subscription) {
  const { endpoint, keys } = subscription;
  await query(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $2, p256dh = $4, auth = $5`,
    [crypto.randomUUID(), userId, endpoint, keys.p256dh, keys.auth, Date.now()]
  );
}
async function removePushSubscription(endpoint) {
  await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}
async function getPushSubscriptionsForUser(userId) {
  return query(`SELECT * FROM push_subscriptions WHERE user_id = $1`, [userId]);
}

// ---- Profile reviews ----
// Left by people the reviewed user has actually chatted with (checked
// against the conversations table). Public: rating + tag + comment +
// reviewer's username. One review per reviewer/reviewed pair; leaving a
// new one updates the existing one rather than stacking duplicates.
const REVIEW_TAGS = ['genuine', 'fake', 'suspicious'];
const REVIEW_COMMENT_MAX = 500;

async function hasChattedWith(userIdA, userIdB) {
  const row = await queryOne(
    `SELECT 1 FROM conversations WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)`,
    [userIdA, userIdB]
  );
  return !!row;
}

async function upsertReview(reviewerId, reviewedId, { rating, tag, comment } = {}) {
  if (reviewerId === reviewedId) throw new Error("You can't review yourself.");
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) throw new Error('Rating must be between 1 and 5.');
  const t = REVIEW_TAGS.includes(tag) ? tag : 'genuine';
  const c = typeof comment === 'string' ? comment.trim().slice(0, REVIEW_COMMENT_MAX) : '';
  const chatted = await hasChattedWith(reviewerId, reviewedId);
  if (!chatted) throw new Error('You can only review people you\u2019ve chatted with.');
  const now = Date.now();
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO reviews (id, reviewer_id, reviewed_id, rating, tag, comment, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     ON CONFLICT (reviewer_id, reviewed_id)
     DO UPDATE SET rating = $4, tag = $5, comment = $6, updated_at = $7`,
    [id, reviewerId, reviewedId, r, t, c || null, now]
  );
}

async function getReviewsForUser(reviewedId, { limit = 50 } = {}) {
  const rows = await query(
    `SELECT r.*, u.username AS reviewer_username, u.display_name AS reviewer_display_name, u.photo AS reviewer_photo
     FROM reviews r JOIN users u ON u.id = r.reviewer_id
     WHERE r.reviewed_id = $1
     ORDER BY r.updated_at DESC LIMIT $2`,
    [reviewedId, limit]
  );
  return rows.map(row => ({
    id: row.id,
    rating: row.rating,
    tag: row.tag,
    comment: row.comment || '',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    reviewer: { id: row.reviewer_id, username: row.reviewer_username, displayName: row.reviewer_display_name || row.reviewer_username, photoUrl: row.reviewer_photo || null }
  }));
}

async function getReviewSummary(reviewedId) {
  const row = await queryOne(
    `SELECT COUNT(*) AS cnt, COALESCE(AVG(rating), 0) AS avg,
            COUNT(*) FILTER (WHERE tag = 'genuine') AS genuine_count,
            COUNT(*) FILTER (WHERE tag = 'fake') AS fake_count,
            COUNT(*) FILTER (WHERE tag = 'suspicious') AS suspicious_count
     FROM reviews WHERE reviewed_id = $1`,
    [reviewedId]
  );
  return {
    count: Number(row.cnt),
    average: Math.round(Number(row.avg) * 10) / 10,
    tagCounts: { genuine: Number(row.genuine_count), fake: Number(row.fake_count), suspicious: Number(row.suspicious_count) }
  };
}

async function getMyReviewFor(reviewerId, reviewedId) {
  const row = await queryOne(`SELECT * FROM reviews WHERE reviewer_id = $1 AND reviewed_id = $2`, [reviewerId, reviewedId]);
  if (!row) return null;
  return { id: row.id, rating: row.rating, tag: row.tag, comment: row.comment || '' };
}

async function reportReview(reviewId, reporterId, reason) {
  const review = await queryOne(`SELECT * FROM reviews WHERE id = $1`, [reviewId]);
  if (!review) throw new Error('Review not found.');
  const inserted = await query(
    `INSERT INTO review_reports (id, review_id, reporter_id, reason, created_at)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (review_id, reporter_id) DO NOTHING RETURNING id`,
    [crypto.randomUUID(), reviewId, reporterId, String(reason || '').trim().slice(0, 300) || null, Date.now()]
  );
  if (inserted.length) {
    await query(`UPDATE reviews SET report_count = report_count + 1 WHERE id = $1`, [reviewId]);
  }
}

module.exports = {
  ready,
  createUser, findUserByUsername, findUserByEmail, findUserByIdentifier, isUsernameAvailable, usernameFormatError, getUser, publicUser,
  findOrCreateOAuthUser, setGender, setPhone, setBirthDate, findUsersByPhoneHashes,
  findOrCreateConversation, getConversation, listConversationsForUser, otherUserId,
  addMessage, getMessages, getLastMessage, getUnreadCount,
  setDisappearingMode, markSeen, deleteMessageForMe, deleteMessageForEveryone,
  sweepExpiredMessages, deleteAllConversationsForUser, deleteConversation,
  addReport, banUser, isUserBanned,
  getSetting,
  searchUsers, sendFriendRequest, respondFriendRequest, unfriend,
  friendStatusBetween, areFriends, listIncomingRequests, listFriendIds,
  followUser, unfollowUser, isFollowing, getFollowCounts,
  setLastCountry, suggestFriends,
  updateProfile, setLastLocation, findNearbyUsers,
  verifyPassword, flushPendingWrites,
  savePushSubscription, removePushSubscription, getPushSubscriptionsForUser,
  hasChattedWith, upsertReview, getReviewsForUser, getReviewSummary, getMyReviewFor, reportReview,
  blockUser, unblockUser, isBlockedByMe, getBlockedUserIds,
  muteUser, unmuteUser, isMuted, getMutedUserIds
};
