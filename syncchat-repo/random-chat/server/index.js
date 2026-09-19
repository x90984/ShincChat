require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const geoip = require('geoip-lite');
const db = require('./db');
const oauth = require('./oauth');
const state = require('./state');

// ---- Country/location matching helpers (JS mirror of MATCH_LUA — used
// for local entry bookkeeping; the authoritative check runs atomically
// inside Redis so queues are shared across instances) ----
function getClientIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return socket.handshake.address || null;
}

function detectCountry(socket) {
  const ip = getClientIp(socket);
  if (!ip) return null;
  const lookup = geoip.lookup(ip);
  return lookup ? lookup.country : null;
}

const VALID_COUNTRY_MODES = ['nearby', 'india', 'random', 'country'];

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8e6 });

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const userId = token ? await state.getSessionUser(token) : null;
    const user = userId ? await db.getUser(userId) : null;
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    if (user.is_banned) return res.status(403).json({ error: 'This account has been permanently banned.' });
    req.userId = userId;
    next();
  } catch (e) {
    console.error('requireAuth error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}

// Wraps an async Express handler so a thrown/rejected error becomes a 500
// instead of crashing the process or hanging the request — every route
// below now awaits database calls, so this replaces the implicit safety
// SQLite's synchronous calls used to have (an uncaught throw there still
// unwound normally; an unhandled rejection here would not).
function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((e) => {
      console.error('Route error:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    });
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.get('/health', (req, res) => res.json({ ok: true, instance: state.INSTANCE_ID, clustered: state.isClustered() })); // for cron-job.org keep-awake pings

// ---- WebRTC config: STUN default, optional TURN relay via env (TURN_URLS,
// TURN_USERNAME, TURN_CREDENTIAL — comma-separated URLs). Lets the operator
// plug in a free TURN (OpenRelay / self-hosted coturn) without code edits —
// TURN is what makes calls work for users behind strict NATs and it's the
// one media-path that costs money beyond ~20 GB/mo, so it stays opt-in. ----
app.get('/api/rtc-config', (req, res) => {
  const stunUrls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map(s => s.trim()).filter(Boolean);
  const iceServers = [{ urls: stunUrls }];
  const turnUrls = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (turnUrls.length) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME || undefined,
      credential: process.env.TURN_CREDENTIAL || undefined,
    });
  }
  res.json({ iceServers });
});

app.get('/api/check-username', asyncRoute(async (req, res) => {
  const u = String(req.query.u || '');
  const formatErr = db.usernameFormatError(u);
  const available = !formatErr && await db.isUsernameAvailable(u);
  res.json({ available, error: formatErr || null });
}));

app.post('/api/signup', asyncRoute(async (req, res) => {
  const { fullName, username, identifier, password, birthDate, youtubeLink } = req.body || {};
  if (!fullName || !String(fullName).trim()) {
    return res.status(400).json({ error: 'Enter your name.' });
  }
  if (!username || !String(username).trim()) {
    return res.status(400).json({ error: 'Choose a username.' });
  }
  const idTrimmed = String(identifier || '').trim();
  if (!idTrimmed) {
    return res.status(400).json({ error: 'Enter a mobile number or email address.' });
  }
  const isEmail = idTrimmed.includes('@');
  const email = isEmail ? idTrimmed : null;
  const phone = isEmail ? null : idTrimmed;
  if (isEmail && !EMAIL_RE.test(idTrimmed)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!isEmail && idTrimmed.replace(/\D/g, '').length < 7) {
    return res.status(400).json({ error: 'Enter a valid mobile number or email address.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  try {
    const user = await db.createUser({ email, password, phone, username, displayName: fullName, birthDate, youtubeLink });
    const token = await state.createSession(user.id);
    res.json({ token, user: db.publicUser(user) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const { identifier, password } = req.body || {};
  const user = await db.findUserByIdentifier(identifier || '');
  if (!user || !user.hash || !db.verifyPassword(password || '', user.salt, user.hash)) {
    return res.status(401).json({ error: 'Incorrect username, email, phone or password.' });
  }
  if (user.is_banned) {
    return res.status(403).json({ error: 'This account has been permanently banned.' });
  }
  const token = await state.createSession(user.id);
  res.json({ token, user: db.publicUser(user) });
}));

// Social login (Google) — mounts /auth/google, /auth/google/callback, /api/oauth-providers.
oauth.mount(app, db, {
  createSession: (userId) => state.createSession(userId),
  oauthState: {
    set: (key, data, ttlSec) => state.oauthStateSet(key, data, ttlSec),
    take: (key) => state.oauthStateTake(key),
  },
});

app.get('/api/me', requireAuth, asyncRoute(async (req, res) => {
  res.json({ user: db.publicUser(await db.getUser(req.userId)) });
}));

app.post('/api/set-gender', requireAuth, asyncRoute(async (req, res) => {
  const { gender } = req.body || {};
  if (!['male', 'female'].includes(gender)) {
    return res.status(400).json({ error: 'Select male or female.' });
  }
  const user = await db.getUser(req.userId);
  if (user.gender) {
    return res.status(400).json({ error: 'Gender is already set on this account.' });
  }
  await db.setGender(req.userId, gender);
  res.json({ user: db.publicUser(await db.getUser(req.userId)) });
}));

app.post('/api/set-phone', requireAuth, asyncRoute(async (req, res) => {
  const { phone } = req.body || {};
  if (!phone || String(phone).replace(/\D/g, '').length < 7) {
    return res.status(400).json({ error: 'Enter a valid phone number.' });
  }
  const user = await db.getUser(req.userId);
  if (user.phone_hash) {
    return res.status(400).json({ error: 'Phone number is already set on this account.' });
  }
  try {
    await db.setPhone(req.userId, phone);
    res.json({ user: db.publicUser(await db.getUser(req.userId)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/set-birthdate', requireAuth, asyncRoute(async (req, res) => {
  const { birthDate } = req.body || {};
  const user = await db.getUser(req.userId);
  if (user.birth_date) {
    return res.status(400).json({ error: 'Date of birth is already set on this account.' });
  }
  try {
    await db.setBirthDate(req.userId, birthDate);
    res.json({ user: db.publicUser(await db.getUser(req.userId)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/contacts/match', requireAuth, asyncRoute(async (req, res) => {
  const { hashes } = req.body || {};
  if (!Array.isArray(hashes) || hashes.length === 0) return res.json({ matches: [] });
  const capped = hashes.slice(0, 2000).filter(h => typeof h === 'string');
  const users = await db.findUsersByPhoneHashes(capped, req.userId);
  const onlineMap = await state.onlineSockets(users.map(u => u.id));
  const matches = [];
  for (const u of users) {
    const friendStatus = await db.friendStatusBetween(req.userId, u.id);
    if (friendStatus === 'friends') continue;
    matches.push({ ...db.publicUser(u), online: onlineMap.get(u.id) !== null, friendStatus });
  }
  res.json({ matches });
}));

// ---- Chat history ----
app.get('/api/history', requireAuth, asyncRoute(async (req, res) => {
  const rawConvos = await db.listConversationsForUser(req.userId);
  const conversations = [];
  for (const c of rawConvos) {
    const partnerId = db.otherUserId(c, req.userId);
    const partner = await db.getUser(partnerId);
    const last = await db.getLastMessage(c.id);
    const unreadCount = await db.getUnreadCount(c.id, req.userId);
    conversations.push({
      conversationId: c.id,
      partner: partner ? db.publicUser(partner) : { id: partnerId, username: 'Deleted user', gender: null },
      online: await state.isOnline(partnerId),
      lastMessage: last ? { type: last.type, text: last.text, ts: Number(last.ts), mine: last.sender_id === req.userId } : null,
      unreadCount,
      updatedAt: c.last_message_at || c.created_at
    });
  }
  res.json({ conversations });
}));

app.get('/api/history/:conversationId/messages', requireAuth, asyncRoute(async (req, res) => {
  const convo = await db.getConversation(req.params.conversationId);
  if (!convo || !userInConversation(convo, req.userId)) return res.status(404).json({ error: 'Not found' });
  const beforeTs = req.query.before ? Number(req.query.before) : null;
  const messages = await db.getMessages(convo.id, req.userId, { beforeTs });
  res.json({ messages, disappearingMode: convo.disappearing_mode });
}));

app.post('/api/history/:conversationId/disappearing', requireAuth, asyncRoute(async (req, res) => {
  const convo = await db.getConversation(req.params.conversationId);
  if (!convo || !userInConversation(convo, req.userId)) return res.status(404).json({ error: 'Not found' });
  try {
    const mode = await db.setDisappearingMode(convo.id, req.body && req.body.mode);
    const otherId = db.otherUserId(convo, req.userId);
    const other = await state.onlineSocketOf(otherId);
    if (other) io.to(other.socketId).emit('disappearing-changed', { conversationId: convo.id, mode });
    res.json({ mode });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/history/delete-all', requireAuth, asyncRoute(async (req, res) => {
  const cleared = await db.deleteAllConversationsForUser(req.userId);
  const onlineMap = await state.onlineSockets(cleared.map(c => c.otherUserId));
  for (const { id, otherUserId: otherId } of cleared) {
    const other = onlineMap.get(otherId);
    if (other) io.to(other.socketId).emit('conversation-deleted', { conversationId: id });
  }
  res.json({ deletedCount: cleared.length });
}));

// "Clear chat" — wipes one conversation's history (both sides), used from
// the top-bar "more" (⋮) menu while chatting with someone.
app.post('/api/history/:conversationId/clear', requireAuth, asyncRoute(async (req, res) => {
  const convo = await db.getConversation(req.params.conversationId);
  if (!convo || !userInConversation(convo, req.userId)) return res.status(404).json({ error: 'Not found' });
  const otherId = db.otherUserId(convo, req.userId);
  await db.deleteConversation(convo.id);
  const other = await state.onlineSocketOf(otherId);
  if (other) io.to(other.socketId).emit('conversation-deleted', { conversationId: convo.id });
  res.json({ ok: true });
}));

// Bundle for the "Reviews" popup — your 10 most recent chat partners, each
// with their public reviews and your past messages with them, in one call.
app.get('/api/history/recent-partners', requireAuth, asyncRoute(async (req, res) => {
  const rawConvos = (await db.listConversationsForUser(req.userId)).slice(0, 10);
  const partners = [];
  for (const c of rawConvos) {
    const partnerId = db.otherUserId(c, req.userId);
    const partner = await db.getUser(partnerId);
    if (!partner) continue;
    const [reviews, summary, messages, online] = await Promise.all([
      db.getReviewsForUser(partnerId),
      db.getReviewSummary(partnerId),
      db.getMessages(c.id, req.userId, { limit: 50 }),
      state.isOnline(partnerId)
    ]);
    partners.push({
      conversationId: c.id,
      partner: { ...db.publicUser(partner), online },
      reviews, summary, messages
    });
  }
  res.json({ partners });
}));

// ---- Block / mute (one-directional, act on the CURRENT user's list) ----
app.post('/api/users/:id/block', requireAuth, asyncRoute(async (req, res) => {
  if (req.params.id === req.userId) return res.status(400).json({ error: "You can't block yourself." });
  await db.blockUser(req.userId, req.params.id);
  refreshBlockCache(req.userId).catch(() => {});
  // A block always ends any chat currently in progress with that person.
  const mine = await state.onlineSocketOf(req.userId);
  if (mine && await state.pairOf(mine.socketId) && await state.pairUserOf(mine.socketId) === req.params.id) {
    disconnectPartner(mine.socketId);
    removeFromQueues(mine.socketId);
  }
  res.json({ ok: true });
}));
app.post('/api/users/:id/unblock', requireAuth, asyncRoute(async (req, res) => {
  await db.unblockUser(req.userId, req.params.id);
  refreshBlockCache(req.userId).catch(() => {});
  res.json({ ok: true });
}));
app.post('/api/users/:id/mute', requireAuth, asyncRoute(async (req, res) => {
  if (req.params.id === req.userId) return res.status(400).json({ error: "You can't mute yourself." });
  await db.muteUser(req.userId, req.params.id);
  refreshMuteCache(req.userId).catch(() => {});
  res.json({ ok: true });
}));
app.post('/api/users/:id/unmute', requireAuth, asyncRoute(async (req, res) => {
  await db.unmuteUser(req.userId, req.params.id);
  refreshMuteCache(req.userId).catch(() => {});
  res.json({ ok: true });
}));

// ---- Users: search + profile ----
app.get('/api/users/search', requireAuth, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) return res.json({ users: [] });
  const rows = await db.searchUsers(q, req.userId, 20);
  const onlineMap = await state.onlineSockets(rows.map(u => u.id));
  const users = [];
  for (const u of rows) {
    users.push({ ...db.publicUser(u), online: onlineMap.get(u.id) !== null, friendStatus: await db.friendStatusBetween(req.userId, u.id) });
  }
  res.json({ users });
}));

app.get('/api/users/:id', requireAuth, asyncRoute(async (req, res) => {
  const user = await db.getUser(req.params.id);
  if (!user || user.is_banned) return res.status(404).json({ error: 'Not found' });
  const isSelf = req.params.id === req.userId;
  const [reviewSummary, online] = await Promise.all([
    db.getReviewSummary(user.id),
    state.isOnline(user.id)
  ]);
  res.json({
    user: {
      ...db.publicUser(user),
      online,
      friendStatus: isSelf ? 'self' : await db.friendStatusBetween(req.userId, user.id),
      ...await db.getFollowCounts(user.id),
      isFollowing: isSelf ? false : await db.isFollowing(req.userId, user.id),
      reviewSummary,
      canReview: isSelf ? false : await db.hasChattedWith(req.userId, user.id),
      isBlocked: isSelf ? false : await db.isBlockedByMe(req.userId, user.id),
      isMuted: isSelf ? false : await db.isMuted(req.userId, user.id)
    }
  });
}));

// ---- Profile reviews (public "genuine/fake/suspicious" ratings) ----
app.get('/api/users/:id/reviews', requireAuth, asyncRoute(async (req, res) => {
  const [reviews, summary, myReview] = await Promise.all([
    db.getReviewsForUser(req.params.id),
    db.getReviewSummary(req.params.id),
    req.params.id === req.userId ? null : db.getMyReviewFor(req.userId, req.params.id)
  ]);
  res.json({ reviews, summary, myReview });
}));

app.post('/api/users/:id/reviews', requireAuth, asyncRoute(async (req, res) => {
  const { rating, tag, comment } = req.body || {};
  try {
    await db.upsertReview(req.userId, req.params.id, { rating, tag, comment });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/reviews/:reviewId/report', requireAuth, asyncRoute(async (req, res) => {
  try {
    await db.reportReview(req.params.reviewId, req.userId, req.body && req.body.reason);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// ---- Follows ----
app.post('/api/users/:id/follow', requireAuth, asyncRoute(async (req, res) => {
  if (req.params.id === req.userId) return res.status(400).json({ error: "You can't follow yourself." });
  const target = await db.getUser(req.params.id);
  if (!target || target.is_banned) return res.status(404).json({ error: 'Not found' });
  await db.followUser(req.userId, req.params.id);
  res.json({ ...await db.getFollowCounts(req.params.id), isFollowing: true });
}));
app.post('/api/users/:id/unfollow', requireAuth, asyncRoute(async (req, res) => {
  await db.unfollowUser(req.userId, req.params.id);
  res.json({ ...await db.getFollowCounts(req.params.id), isFollowing: false });
}));

// ---- Profile ----
app.post('/api/profile', requireAuth, asyncRoute(async (req, res) => {
  const { displayName, bio, photo, youtubeLink } = req.body || {};
  try {
    const user = await db.updateProfile(req.userId, { displayName, bio, photo, youtubeLink });
    res.json({ user: db.publicUser(user) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/location', requireAuth, asyncRoute(async (req, res) => {
  const { lat, lon } = req.body || {};
  if (typeof lat !== 'number' || typeof lon !== 'number') return res.status(400).json({ error: 'lat/lon required.' });
  await db.setLastLocation(req.userId, lat, lon);
  res.json({ ok: true });
}));

// ---- Suggested friends ----
app.get('/api/users/suggestions', requireAuth, asyncRoute(async (req, res) => {
  const raw = await db.suggestFriends(req.userId, 20);
  const onlineMap = await state.onlineSockets(raw.map(u => u.id));
  const suggestions = raw.map(u => ({ ...u, online: onlineMap.get(u.id) !== null }));
  res.json({ suggestions });
}));

// ---- Friends ----
app.get('/api/friends', requireAuth, asyncRoute(async (req, res) => {
  const ids = await db.listFriendIds(req.userId);
  const onlineMap = await state.onlineSockets(ids);
  const friends = [];
  for (const id of ids) {
    const u = await db.getUser(id);
    if (u) friends.push({ ...db.publicUser(u), online: onlineMap.get(id) !== null });
  }
  res.json({ friends });
}));

app.get('/api/friends/requests', requireAuth, asyncRoute(async (req, res) => {
  const rows = await db.listIncomingRequests(req.userId);
  const requests = [];
  for (const r of rows) {
    const u = await db.getUser(r.otherUser);
    requests.push({ id: r.id, createdAt: r.created_at, from: u ? db.publicUser(u) : { id: r.otherUser, username: 'Deleted user', displayName: 'Deleted user' } });
  }
  res.json({ requests });
}));

app.post('/api/friends/request', requireAuth, asyncRoute(async (req, res) => {
  const { userId: toUserId } = req.body || {};
  const target = toUserId && await db.getUser(toUserId);
  if (!target || target.is_banned) return res.status(404).json({ error: 'User not found.' });
  try {
    const result = await db.sendFriendRequest(req.userId, toUserId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/friends/requests/:id/accept', requireAuth, asyncRoute(async (req, res) => {
  const result = await db.respondFriendRequest(req.params.id, req.userId, 'accept');
  if (!result) return res.status(404).json({ error: 'Request not found.' });
  res.json({ status: result.status });
}));

app.post('/api/friends/requests/:id/reject', requireAuth, asyncRoute(async (req, res) => {
  const result = await db.respondFriendRequest(req.params.id, req.userId, 'reject');
  if (!result) return res.status(404).json({ error: 'Request not found.' });
  res.json({ status: result.status });
}));

app.delete('/api/friends/:userId', requireAuth, asyncRoute(async (req, res) => {
  await db.unfriend(req.userId, req.params.userId);
  res.json({ ok: true });
}));

app.get('/api/match-settings', asyncRoute(async (req, res) => {
  const defaults = await db.getSetting('country_match_defaults', { mode: 'india', country: null });
  res.json({ defaults });
}));

// ---- Push notification subscriptions (new) ----
app.post('/api/push/subscribe', requireAuth, asyncRoute(async (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'Invalid subscription.' });
  }
  await db.savePushSubscription(req.userId, subscription);
  res.json({ ok: true });
}));
app.post('/api/push/unsubscribe', requireAuth, asyncRoute(async (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) await db.removePushSubscription(endpoint);
  res.json({ ok: true });
}));

function userInConversation(convo, userId) {
  return convo.user_a === userId || convo.user_b === userId;
}

// ---- Matching state ---------------------------------------------------------
// Only per-instance data stays in these Maps:
//   socketUser   — this instance's own sockets -> userId (set on socket auth)
//   localEntries — this instance's own sockets' matching entries
// Everything shared (queues, pairs, presence, sessions, block/mute mirrors)
// lives in state.js → Redis, so any instance can see and match anyone.
const socketUser = new Map();
const localEntries = new Map();

async function refreshBlockCache(userId) {
  await state.setBlocklist(userId, await db.getBlockedUserIds(userId));
}
async function refreshMuteCache(userId) {
  await state.setMutelist(userId, await db.getMutedUserIds(userId));
}

function oppositeOf(gender) {
  return gender === 'male' ? 'female' : 'male';
}

async function startConversation(socketIdA, socketIdB, resumed, conversationId, entryA, entryB) {
  const userIdA = socketUser.get(socketIdA) || (entryA && entryA.userId) || await state.socketUserOf(socketIdA) || null;
  const userIdB = socketUser.get(socketIdB) || (entryB && entryB.userId) || await state.socketUserOf(socketIdB) || null;
  const convo = conversationId
    ? await db.getConversation(conversationId)
    : (userIdA && userIdB ? await db.findOrCreateConversation(userIdA, userIdB) : null);
  if (convo) {
    await state.convSet(socketIdA, convo.id);
    await state.convSet(socketIdB, convo.id);
  }

  const roomId = crypto.randomUUID();
  if (!entryA || !entryB) return; // should never happen — callers always build entries

  const [mutesA, mutesB] = await Promise.all([
    userIdA ? state.mutesOf(userIdA) : new Set(),
    userIdB ? state.mutesOf(userIdB) : new Set(),
  ]);
  const aMutedB = !!(userIdB && mutesA.has(userIdB));
  const bMutedA = !!(userIdA && mutesB.has(userIdA));

  io.to(socketIdA).emit('matched', {
    roomId, initiator: true, partnerGender: entryB.gender, resumed: !!resumed,
    conversationId: convo ? convo.id : null, partnerId: userIdB || null, partnerMuted: aMutedB
  });
  io.to(socketIdB).emit('matched', {
    roomId, initiator: false, partnerGender: entryA.gender, resumed: !!resumed,
    conversationId: convo ? convo.id : null, partnerId: userIdA || null, partnerMuted: bMutedA
  });

  // socketsJoin works for remote sockets too once the Redis adapter is on.
  io.in(socketIdA).socketsJoin(roomId);
  io.in(socketIdB).socketsJoin(roomId);
}

// One matchmaking attempt for a LOCAL socket. state.findMatch does the
// atomic queue pop + pair claim in Redis; on success we just notify both
// sides (io.to reaches remote instances via the adapter in cluster mode).
async function tryMatch(socketId) {
  const entry = localEntries.get(socketId);
  if (!entry) return false;
  if (await state.pairOf(socketId)) { state.localQueued.delete(socketId); return false; }

  const match = await state.findMatch(socketId, entry);
  if (!match) return false;

  await startConversation(socketId, match.candidateId, false, null, entry, match.entry);
  return true;
}

// Periodically re-try matching for THIS instance's queued sockets (every
// instance drains the shared queue in parallel; the Lua matcher is atomic,
// so the same user can never be matched twice).
setInterval(() => {
  (async () => {
    for (const socketId of [...state.localQueued]) {
      try {
        if (!io.sockets.sockets.get(socketId)) { state.localQueued.delete(socketId); continue; }
        await tryMatch(socketId);
      } catch (e) {
        console.error('retry match failed:', e);
      }
    }
  })().catch(() => {});
}, 5000);

// Housekeeping for 24h-disappearing conversations. Leader-locked so only one
// instance runs the sweep in cluster mode.
setInterval(async () => {
  try {
    if (!await state.acquireLock('sweeper', 75)) return;
    const cleared = await db.sweepExpiredMessages();
    for (const { conversationId, id } of cleared) {
      const convo = await db.getConversation(conversationId);
      if (!convo) continue;
      const onlineMap = await state.onlineSockets([convo.user_a, convo.user_b]);
      for (const u of [convo.user_a, convo.user_b]) {
        const o = onlineMap.get(u);
        if (o) io.to(o.socketId).emit('message-deleted', { messageId: id });
      }
    }
  } catch (e) {
    console.error('sweepExpiredMessages failed:', e);
  }
}, 60 * 1000);

// Janitor: drop queued entries left behind by a crashed instance, and cut
// local sockets whose partner's instance died (so their UI goes back to
// searching instead of hanging in a dead chat).
setInterval(async () => {
  try {
    const eager = [];
    for (const socketId of io.sockets.sockets.keys()) eager.push(socketId);
    const dead = await state.sweepLocalPairs(eager);
    for (const socketId of dead) {
      io.to(socketId).emit('partner-left');
      await state.releasePair(socketId);
    }
    if (await state.acquireLock('janitor', 75)) {
      await state.janitorQueues();
    }
  } catch (e) {
    console.error('janitor failed:', e);
  }
}, 60 * 1000);

// Queue-level removal only. localEntries survive (like the old `users` Map)
// so skip/find-partner re-search instantly with the same country settings;
// entries are dropped only when the socket disconnects.
function removeFromQueues(socketId) {
  return state.dequeue(socketId);
}

function disconnectPartner(socketId) {
  return state.releasePair(socketId).then((partnerId) => {
    if (partnerId) io.to(partnerId).emit('partner-left');
  }).catch(e => console.error('disconnectPartner failed:', e));
}

io.on('connection', (socket) => {

  const detectedCountry = detectCountry(socket);

  socket.on('auth', ({ token }) => {
    (async () => {
      const userId = await state.getSessionUser(token);
      const user = userId ? await db.getUser(userId) : null;
      if (!user) {
        socket.emit('auth-error');
        return;
      }
      if (user.is_banned) {
        socket.emit('banned');
        socket.disconnect(true);
        return;
      }
      socketUser.set(socket.id, userId);
      await state.setOnline(userId, socket.id);
      await db.setLastCountry(userId, detectedCountry);
      await Promise.all([refreshBlockCache(userId), refreshMuteCache(userId)]);
    })().catch(e => console.error('auth handler failed:', e));
  });

  function buildEntry(gender, lookingFor, { countryMode, country, lat, lon } = {}) {
    const mode = VALID_COUNTRY_MODES.includes(countryMode) ? countryMode : 'random';
    return {
      gender,
      lookingFor,
      countryMode: mode,
      country: mode === 'country' && typeof country === 'string' ? country.toUpperCase().slice(0, 2) : null,
      lat: mode === 'nearby' && typeof lat === 'number' ? lat : null,
      lon: mode === 'nearby' && typeof lon === 'number' ? lon : null,
      detectedCountry,
      userId: socketUser.get(socket.id) || null,
      queuedAt: Date.now()
    };
  }

  socket.on('find-partner', ({ gender, lookingFor, countryMode, country, lat, lon }) => {
    if (!['male', 'female'].includes(gender)) return;
    (async () => {
      localEntries.set(socket.id, buildEntry(gender, lookingFor, { countryMode, country, lat, lon }));
      await removeFromQueues(socket.id);
      await state.releasePair(socket.id).then(p => { if (p) io.to(p).emit('partner-left'); });
      await tryMatch(socket.id);
    })().catch(e => console.error('find-partner failed:', e));
  });

  socket.on('set-country-mode', ({ countryMode, country, lat, lon }) => {
    const entry = localEntries.get(socket.id);
    if (!entry) return;
    const mode = VALID_COUNTRY_MODES.includes(countryMode) ? countryMode : 'random';
    entry.countryMode = mode;
    entry.country = mode === 'country' && typeof country === 'string' ? country.toUpperCase().slice(0, 2) : null;
    entry.lat = mode === 'nearby' && typeof lat === 'number' ? lat : null;
    entry.lon = mode === 'nearby' && typeof lon === 'number' ? lon : null;
    (async () => {
      await state.refreshEntry(socket.id, entry);
      if (!await state.pairOf(socket.id)) await tryMatch(socket.id);
    })().catch(e => console.error('set-country-mode failed:', e));
  });

  socket.on('call-friend', ({ friendUserId }) => {
    (async () => {
      const myUserId = socketUser.get(socket.id);
      if (!myUserId) return socket.emit('call-failed', { reason: 'not-authenticated' });
      if (!friendUserId || !await db.areFriends(myUserId, friendUserId)) {
        return socket.emit('call-failed', { reason: 'not-friends' });
      }
      const friend = await state.onlineSocketOf(friendUserId);
      if (!friend) return socket.emit('call-failed', { reason: 'offline' });
      const friendSocketId = friend.socketId;
      if (await state.pairOf(socket.id) || await state.pairOf(friendSocketId)) return socket.emit('call-failed', { reason: 'busy' });

      const myUser = await db.getUser(myUserId);
      const friendUser = await db.getUser(friendUserId);
      await removeFromQueues(socket.id);
      await state.dequeue(friendSocketId);
      const entryA = buildEntry(myUser.gender, friendUser.gender);
      const entryB = buildEntry(friendUser.gender, myUser.gender);
      // buildEntry fills in the CALLER's identity from closure — correct the
      // friend's entry so matched/presence lookups see the right user/country.
      entryA.userId = myUserId;
      entryB.userId = friendUserId;
      entryB.detectedCountry = friendUser.last_country || null;
      const claimed = await state.claimPair(socket.id, friendSocketId, myUserId, friendUserId);
      if (!claimed) return socket.emit('call-failed', { reason: 'busy' });
      localEntries.set(socket.id, entryA);
      const convo = await db.findOrCreateConversation(myUserId, friendUserId);
      await startConversation(socket.id, friendSocketId, false, convo.id, entryA, entryB);
    })().catch(e => { console.error('call-friend failed:', e); socket.emit('call-failed', { reason: 'server-error' }); });
  });

  socket.on('skip', () => {
    (async () => {
      await state.releasePair(socket.id).then(p => { if (p) io.to(p).emit('partner-left'); });
      await state.dequeue(socket.id);
      const entry = localEntries.get(socket.id);
      if (entry) entry.queuedAt = Date.now();
      await tryMatch(socket.id);
    })().catch(e => console.error('skip failed:', e));
  });

  socket.on('cancel-search', () => {
    removeFromQueues(socket.id).catch(e => console.error('cancel-search failed:', e));
  });

  socket.on('leave-chat', () => {
    disconnectPartner(socket.id);
    removeFromQueues(socket.id).catch(() => {});
  });

  socket.on('resume-chat', ({ conversationId }) => {
    (async () => {
      const myUserId = socketUser.get(socket.id);
      if (!myUserId) return;
      const convo = await db.getConversation(conversationId);
      if (!convo || !userInConversation(convo, myUserId)) {
        socket.emit('resume-failed', { reason: 'not-found' });
        return;
      }
      const partnerId = db.otherUserId(convo, myUserId);
      const partner = await state.onlineSocketOf(partnerId);
      if (!partner) {
        socket.emit('resume-failed', { reason: 'offline' });
        return;
      }
      const partnerSocketId = partner.socketId;
      if (await state.pairOf(socket.id) || await state.pairOf(partnerSocketId)) {
        socket.emit('resume-failed', { reason: 'busy' });
        return;
      }
      const partnerUser = await db.getUser(partnerId);
      const myUser = await db.getUser(myUserId);
      await removeFromQueues(socket.id);
      await state.dequeue(partnerSocketId);
      const entryA = buildEntry(myUser.gender, partnerUser.gender);
      const entryB = buildEntry(partnerUser.gender, myUser.gender);
      entryA.userId = myUserId;
      entryB.userId = partnerId;
      entryB.detectedCountry = partnerUser.last_country || null;
      const claimed = await state.claimPair(socket.id, partnerSocketId, myUserId, partnerId);
      if (!claimed) {
        socket.emit('resume-failed', { reason: 'busy' });
        return;
      }
      localEntries.set(socket.id, entryA);
      await startConversation(socket.id, partnerSocketId, true, convo.id, entryA, entryB);
    })().catch(e => { console.error('resume-chat failed:', e); socket.emit('resume-failed', { reason: 'server-error' }); });
  });

  const MAX_MESSAGE_LENGTH = 1000;
  socket.on('chat-message', ({ text, replyToId }) => {
    if (typeof text !== 'string') return;
    const trimmed = text.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!trimmed) return;
    (async () => {
      const partnerId = await state.pairOf(socket.id);
      if (!partnerId) return;
      const convId = await state.convOf(socket.id);
      const senderId = socketUser.get(socket.id);

      let payload = { id: null, ts: Date.now(), text: trimmed, replyTo: null };
      if (convId && senderId) {
        const msg = await db.addMessage(convId, { senderId, type: 'text', text: trimmed, replyToId: typeof replyToId === 'string' ? replyToId : null });
        const recent = await db.getMessages(convId, senderId, { limit: 1 });
        const shaped = recent.find(m => m.id === msg.id);
        payload = { id: msg.id, ts: msg.ts, text: trimmed, replyTo: shaped ? shaped.replyTo : null };
      }
      socket.emit('chat-message', { ...payload, self: true });
      io.to(partnerId).emit('chat-message', { ...payload, self: false });
    })().catch(e => console.error('chat-message failed:', e));
  });

  socket.on('delete-message', ({ messageId, mode }) => {
    const userId = socketUser.get(socket.id);
    if (!userId || typeof messageId !== 'string') return;
    (async () => {
      const partnerId = await state.pairOf(socket.id);
      try {
        if (mode === 'everyone') {
          await db.deleteMessageForEveryone(messageId, userId);
          socket.emit('message-deleted', { messageId });
          if (partnerId) io.to(partnerId).emit('message-deleted', { messageId });
        } else {
          await db.deleteMessageForMe(messageId, userId);
          socket.emit('message-deleted', { messageId, onlyForMe: true });
        }
      } catch (e) {
        socket.emit('delete-message-failed', { messageId, reason: e.message });
      }
    })();
  });

  socket.on('set-disappearing', ({ mode }) => {
    (async () => {
      const convId = await state.convOf(socket.id);
      if (!convId) return;
      const partnerId = await state.pairOf(socket.id);
      try {
        await db.setDisappearingMode(convId, mode);
        socket.emit('disappearing-changed', { mode });
        if (partnerId) io.to(partnerId).emit('disappearing-changed', { mode });
      } catch (e) { /* invalid mode from a modified client — ignore silently */ }
    })().catch(() => {});
  });

  socket.on('mark-seen', () => {
    (async () => {
      const convId = await state.convOf(socket.id);
      const userId = socketUser.get(socket.id);
      const partnerId = await state.pairOf(socket.id);
      if (!convId || !userId) return;
      const { seenIds, deletedIds } = await db.markSeen(convId, userId);
      if (seenIds.length && partnerId) io.to(partnerId).emit('messages-seen', { messageIds: seenIds });
      for (const messageId of deletedIds) {
        socket.emit('message-deleted', { messageId });
        if (partnerId) io.to(partnerId).emit('message-deleted', { messageId });
      }
    })().catch(e => console.error('mark-seen failed:', e));
  });

  // WebRTC signaling relay
  socket.on('webrtc-offer', (payload) => {
    state.pairOf(socket.id).then(p => { if (p) io.to(p).emit('webrtc-offer', payload); }).catch(() => {});
  });

  socket.on('webrtc-answer', (payload) => {
    state.pairOf(socket.id).then(p => { if (p) io.to(p).emit('webrtc-answer', payload); }).catch(() => {});
  });

  socket.on('webrtc-ice-candidate', (payload) => {
    state.pairOf(socket.id).then(p => { if (p) io.to(p).emit('webrtc-ice-candidate', payload); }).catch(() => {});
  });

  socket.on('verify-request', () => {
    state.pairOf(socket.id).then(p => { if (p) io.to(p).emit('verify-request'); }).catch(() => {});
  });

  // One side viewing the other's profile mid-video-call — tell the other
  // side so it can blur its view of the departed person's video feed.
  socket.on('viewing-profile', (payload) => {
    state.pairOf(socket.id).then(p => { if (p) io.to(p).emit('partner-viewing-profile', { viewing: !!(payload && payload.viewing) }); }).catch(() => {});
  });

  socket.on('verify-video', ({ video }) => {
    state.pairOf(socket.id).then(p => { if (p) io.to(p).emit('verify-video', { video }); }).catch(() => {});
  });

  socket.on('reveal-request', () => {
    state.pairOf(socket.id).then(p => { if (p) io.to(p).emit('reveal-request'); }).catch(() => {});
  });

  socket.on('reveal-response', ({ accepted }) => {
    state.pairOf(socket.id).then(p => { if (p) io.to(p).emit('reveal-response', { accepted }); }).catch(() => {});
  });

  socket.on('switch-mode-request', ({ toMode }) => {
    state.pairOf(socket.id).then(p => { if (p) io.to(p).emit('switch-mode-request', { toMode }); }).catch(() => {});
  });

  socket.on('switch-mode-response', ({ accepted, toMode }) => {
    state.pairOf(socket.id).then(p => { if (p) io.to(p).emit('switch-mode-response', { accepted, toMode }); }).catch(() => {});
  });

  socket.on('voice-request', () => {
    state.pairOf(socket.id).then(p => { if (p) io.to(p).emit('voice-request'); }).catch(() => {});
  });

  socket.on('voice-response', ({ accepted }) => {
    state.pairOf(socket.id).then(p => { if (p) io.to(p).emit('voice-response', { accepted }); }).catch(() => {});
  });

  socket.on('voice-end', () => {
    state.pairOf(socket.id).then(p => { if (p) io.to(p).emit('voice-end'); }).catch(() => {});
  });

  socket.on('voice-message', ({ audio }) => {
    (async () => {
      const partnerId = await state.pairOf(socket.id);
      if (!partnerId) return;
      const convId = await state.convOf(socket.id);
      const senderId = socketUser.get(socket.id);
      let payload = { id: null, ts: Date.now(), audio };
      if (convId && senderId) {
        const msg = await db.addMessage(convId, { senderId, type: 'voice', audio });
        payload = { id: msg.id, ts: msg.ts, audio };
      }
      socket.emit('voice-message', { ...payload, self: true });
      io.to(partnerId).emit('voice-message', { ...payload, self: false });
    })().catch(e => console.error('voice-message failed:', e));
  });

  const VALID_REPORT_REASONS = ['incorrect_gender', 'inappropriate', 'fraud', 'other'];
  socket.on('report', ({ reason, details }) => {
    (async () => {
      const partnerId = await state.pairOf(socket.id);
      if (!partnerId) return;
      const reporterId = socketUser.get(socket.id);
      const reportedId = socketUser.get(partnerId) || await state.pairUserOf(socket.id) || await state.socketUserOf(partnerId);
      if (!reporterId || !reportedId) return;
      const safeReason = VALID_REPORT_REASONS.includes(reason) ? reason : 'other';

      await db.addReport({ reporterId, reportedId, reason: safeReason, details: details ? String(details).slice(0, 500) : null });

      const autoBan = await db.getSetting('auto_ban_on_report', true);
      if (autoBan) {
        await db.banUser(reportedId);
        socket.emit('report-ack', { banned: true });
        const reported = await state.onlineSocketOf(reportedId);
        if (reported) {
          io.to(reported.socketId).emit('banned');
          disconnectPartner(reported.socketId);
          removeFromQueues(reported.socketId);
          io.in(reported.socketId).disconnectSockets(true); // local + remote (adapter) safe
        }
      } else {
        socket.emit('report-ack', { banned: false });
      }
    })().catch(e => console.error('report handler failed:', e));
  });

  // ---- Block / mute (real-time counterparts to the REST endpoints above,
  // used from the in-chat "more" (⋮) menu so a Block ends the live chat
  // immediately without waiting on a page refresh). ----
  socket.on('block-user', ({ userId: targetUserId } = {}) => {
    const myUserId = socketUser.get(socket.id);
    if (!myUserId || !targetUserId || targetUserId === myUserId) return;
    (async () => {
      await db.blockUser(myUserId, targetUserId);
      await refreshBlockCache(myUserId);
      socket.emit('block-ack', { userId: targetUserId, blocked: true });
      const partnerSocketId = await state.pairOf(socket.id);
      if (partnerSocketId && await state.pairUserOf(socket.id) === targetUserId) {
        disconnectPartner(socket.id);
        removeFromQueues(socket.id);
      }
    })().catch(e => console.error('block-user failed:', e));
  });

  socket.on('unblock-user', ({ userId: targetUserId } = {}) => {
    const myUserId = socketUser.get(socket.id);
    if (!myUserId || !targetUserId) return;
    (async () => {
      await db.unblockUser(myUserId, targetUserId);
      await refreshBlockCache(myUserId);
      socket.emit('block-ack', { userId: targetUserId, blocked: false });
    })().catch(e => console.error('unblock-user failed:', e));
  });

  socket.on('mute-user', ({ userId: targetUserId } = {}) => {
    const myUserId = socketUser.get(socket.id);
    if (!myUserId || !targetUserId || targetUserId === myUserId) return;
    (async () => {
      await db.muteUser(myUserId, targetUserId);
      await refreshMuteCache(myUserId);
      socket.emit('mute-ack', { userId: targetUserId, muted: true });
    })().catch(e => console.error('mute-user failed:', e));
  });

  socket.on('unmute-user', ({ userId: targetUserId } = {}) => {
    const myUserId = socketUser.get(socket.id);
    if (!myUserId || !targetUserId) return;
    (async () => {
      await db.unmuteUser(myUserId, targetUserId);
      await refreshMuteCache(myUserId);
      socket.emit('mute-ack', { userId: targetUserId, muted: false });
    })().catch(e => console.error('unmute-user failed:', e));
  });

  socket.on('disconnect', () => {
    disconnectPartner(socket.id);
    state.dequeue(socket.id).catch(() => {});
    localEntries.delete(socket.id);
    const userId = socketUser.get(socket.id);
    if (userId) state.setOffline(userId, socket.id).catch(() => {});
    state.untrackSocket(socket.id).catch(() => {});
    socketUser.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;

// Wait for the Postgres schema and the shared-state layer to exist before
// accepting any traffic — otherwise the very first requests after a deploy
// could race the schema creation in db.js and fail.
Promise.all([db.ready, state.init({ io, db })]).then(() => {
  server.listen(PORT, () => {
    console.log(`Random chat server running on port ${PORT} (instance ${state.INSTANCE_ID}, ${state.isClustered() ? 'cluster mode' : 'single-instance mode'})`);
  });
}).catch((e) => {
  console.error('Failed to start — database/state not ready:', e);
  process.exit(1);
});

// Flush any batched-but-not-yet-written DB updates before the process
// exits, so a deploy/restart never silently drops a queued write.
function gracefulShutdown() {
  db.flushPendingWrites()
    .catch(e => console.error('Flush on shutdown failed:', e))
    .then(() => state.shutdown().catch(e => console.error('state shutdown failed:', e)))
    .finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
