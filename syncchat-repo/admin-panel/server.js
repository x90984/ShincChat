// SyncChat Admin Panel — a completely separate application from the main
// random-chat app. It is not imported by, linked to, or deployed as part
// of that app. The ONLY thing the two share is the SQLite database file on
// disk (configurable via DB_PATH), which is how ban/report/monetization
// data written here actually takes effect in the main app.
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || process.env.ADMIN_PORT || 4000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'random-chat', 'server', 'data', 'syncchat.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Make sure the tables this panel needs exist even if the main app hasn't
// created them yet (e.g. fresh checkout, admin panel started first).
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL, username_lower TEXT NOT NULL UNIQUE,
    salt TEXT NOT NULL, hash TEXT NOT NULL, gender TEXT NOT NULL, created_at INTEGER NOT NULL,
    is_premium INTEGER NOT NULL DEFAULT 0, is_banned INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, user_a TEXT NOT NULL, user_b TEXT NOT NULL, created_at INTEGER NOT NULL, last_message_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL, type TEXT NOT NULL,
    text TEXT, audio TEXT, ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, reported_id TEXT NOT NULL, reason TEXT NOT NULL,
    details TEXT, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'auto_banned'
  );
  CREATE TABLE IF NOT EXISTS ads (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, image_url TEXT, link_url TEXT,
    placement TEXT NOT NULL DEFAULT 'gate', enabled INTEGER NOT NULL DEFAULT 1,
    impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS premium_plans (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
    interval TEXT NOT NULL DEFAULT 'monthly', features TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL
  );
`);
// `status` column on reports may not exist yet on a database created by an
// older version of the main app — add it if missing (harmless if present).
try { db.exec(`ALTER TABLE reports ADD COLUMN status TEXT NOT NULL DEFAULT 'auto_banned'`); } catch (e) { /* already exists */ }

const DEFAULT_SETTINGS = {
  auto_ban_on_report: true,
  video_unlock_threshold_per_side: 10,
  // Platform-wide default for the chat app's top-bar country/nearby
  // picker — applies to first-time visitors before they've picked
  // anything themselves. mode: 'nearby' | 'india' | 'random' | 'country';
  // country is only used when mode === 'country' (ISO 3166-1 alpha-2).
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
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value));
}

// ---- Password hashing (same scheme as the main app, duplicated on
// purpose — this codebase is intentionally standalone) ----
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
}

const app = express();
app.set('trust proxy', 1); // Render (and most PaaS hosts) sit behind a TLS-terminating proxy
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Admin auth ----
const sessions = new Map(); // token -> adminId

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const adminId = token && sessions.get(token);
  if (!adminId) return res.status(401).json({ error: 'Not authenticated' });
  req.adminId = adminId;
  next();
}

app.get('/api/admin/bootstrap-status', (req, res) => {
  const count = db.prepare(`SELECT COUNT(*) AS c FROM admins`).get().c;
  res.json({ hasAdmin: count > 0 });
});

// Only works while there are zero admins — prevents anyone from creating
// extra admin accounts through this endpoint later.
app.post('/api/admin/bootstrap', (req, res) => {
  const count = db.prepare(`SELECT COUNT(*) AS c FROM admins`).get().c;
  if (count > 0) return res.status(403).json({ error: 'An admin account already exists. Log in instead.' });
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'Username and an 8+ character password are required.' });
  }
  const { salt, hash } = hashPassword(password);
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO admins (id, username, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, username.trim(), salt, hash, Date.now());
  const token = crypto.randomUUID();
  sessions.set(token, id);
  res.json({ token, username: username.trim() });
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const admin = db.prepare(`SELECT * FROM admins WHERE username = ?`).get((username || '').trim());
  if (!admin || !verifyPassword(password || '', admin.salt, admin.hash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const token = crypto.randomUUID();
  sessions.set(token, admin.id);
  res.json({ token, username: admin.username });
});

// ---- Dashboard ----
app.get('/api/dashboard', requireAdmin, (req, res) => {
  const c = (sql) => db.prepare(sql).get().c;
  res.json({
    totalUsers: c(`SELECT COUNT(*) AS c FROM users`),
    bannedUsers: c(`SELECT COUNT(*) AS c FROM users WHERE is_banned = 1`),
    premiumUsers: c(`SELECT COUNT(*) AS c FROM users WHERE is_premium = 1`),
    totalConversations: c(`SELECT COUNT(*) AS c FROM conversations`),
    totalMessages: c(`SELECT COUNT(*) AS c FROM messages`),
    totalReports: c(`SELECT COUNT(*) AS c FROM reports`),
    activeAds: c(`SELECT COUNT(*) AS c FROM ads WHERE enabled = 1`),
    activePlans: c(`SELECT COUNT(*) AS c FROM premium_plans WHERE enabled = 1`)
  });
});

// ---- Users ----
app.get('/api/users', requireAdmin, (req, res) => {
  const { filter, q } = req.query;
  let sql = `SELECT id, username, gender, created_at, is_premium, is_banned FROM users WHERE 1=1`;
  const params = [];
  if (filter === 'banned') sql += ` AND is_banned = 1`;
  if (filter === 'premium') sql += ` AND is_premium = 1`;
  if (q) { sql += ` AND username_lower LIKE ?`; params.push(`%${q.toLowerCase()}%`); }
  sql += ` ORDER BY created_at DESC LIMIT 200`;
  res.json({ users: db.prepare(sql).all(...params) });
});

app.post('/api/users/:id/ban', requireAdmin, (req, res) => {
  db.prepare(`UPDATE users SET is_banned = 1 WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/users/:id/unban', requireAdmin, (req, res) => {
  db.prepare(`UPDATE users SET is_banned = 0 WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/users/:id/premium', requireAdmin, (req, res) => {
  const { isPremium } = req.body || {};
  db.prepare(`UPDATE users SET is_premium = ? WHERE id = ?`).run(isPremium ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ---- Reports ----
app.get('/api/reports', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.reason, r.details, r.created_at, r.status,
           ru.username AS reporter_username, ru.id AS reporter_id,
           tu.username AS reported_username, tu.id AS reported_id, tu.is_banned AS reported_is_banned
    FROM reports r
    LEFT JOIN users ru ON ru.id = r.reporter_id
    LEFT JOIN users tu ON tu.id = r.reported_id
    ORDER BY r.created_at DESC LIMIT 200
  `).all();
  res.json({ reports: rows });
});

// Admin override: unban someone despite an auto-ban (e.g. a bad-faith report)
app.post('/api/reports/:reportedId/reverse-ban', requireAdmin, (req, res) => {
  db.prepare(`UPDATE users SET is_banned = 0 WHERE id = ?`).run(req.params.reportedId);
  res.json({ ok: true });
});

// ---- Ads ----
app.get('/api/ads', requireAdmin, (req, res) => {
  res.json({ ads: db.prepare(`SELECT * FROM ads ORDER BY created_at DESC`).all() });
});
app.post('/api/ads', requireAdmin, (req, res) => {
  const { title, body, imageUrl, linkUrl, placement, enabled } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO ads (id, title, body, image_url, link_url, placement, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, title, body || null, imageUrl || null, linkUrl || null, placement || 'gate', enabled === false ? 0 : 1, Date.now());
  res.json({ id });
});
app.put('/api/ads/:id', requireAdmin, (req, res) => {
  const { title, body, imageUrl, linkUrl, placement, enabled } = req.body || {};
  db.prepare(`UPDATE ads SET title = ?, body = ?, image_url = ?, link_url = ?, placement = ?, enabled = ? WHERE id = ?`)
    .run(title, body || null, imageUrl || null, linkUrl || null, placement || 'gate', enabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/ads/:id', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM ads WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---- Premium plans ----
app.get('/api/premium-plans', requireAdmin, (req, res) => {
  const plans = db.prepare(`SELECT * FROM premium_plans ORDER BY created_at DESC`).all()
    .map(p => ({ ...p, features: JSON.parse(p.features || '[]') }));
  res.json({ plans });
});
app.post('/api/premium-plans', requireAdmin, (req, res) => {
  const { name, priceCents, currency, interval, features, enabled } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO premium_plans (id, name, price_cents, currency, interval, features, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name, priceCents || 0, currency || 'USD', interval || 'monthly', JSON.stringify(features || []), enabled === false ? 0 : 1, Date.now());
  res.json({ id });
});
app.put('/api/premium-plans/:id', requireAdmin, (req, res) => {
  const { name, priceCents, currency, interval, features, enabled } = req.body || {};
  db.prepare(`UPDATE premium_plans SET name = ?, price_cents = ?, currency = ?, interval = ?, features = ?, enabled = ? WHERE id = ?`)
    .run(name, priceCents || 0, currency || 'USD', interval || 'monthly', JSON.stringify(features || []), enabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/premium-plans/:id', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM premium_plans WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---- Settings / monetization methods ----
app.get('/api/settings', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  const settings = {};
  for (const row of rows) { try { settings[row.key] = JSON.parse(row.value); } catch { settings[row.key] = row.value; } }
  res.json({ settings });
});
app.put('/api/settings/:key', requireAdmin, (req, res) => {
  const { value } = req.body || {};
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(req.params.key, JSON.stringify(value));
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`SyncChat Admin Panel running on port ${PORT}`);
  console.log(`Reading/writing database at: ${DB_PATH}`);
});
