# SyncChat — Verified Random Chat

Gender-matched random chat (text + video) with built-in blurred verification, live voice, and voice messages.

## Run locally
```
npm install
node server/index.js
```
Open http://localhost:3000 in two tabs/devices to test matching.

## Social login (Google / Facebook / X)

The sign-up/login screen shows Google, Facebook, and X buttons. Each one only
works once you've registered a real app with that provider and set its
credentials as environment variables — see the comment at the top of
`server/oauth.js` for exact variable names and the callback URL to register.
Until a provider's client ID is set, its button shows as disabled with a
"not set up yet" tooltip instead of breaking — username/password login
always works regardless.

Gender is no longer asked at signup — it's asked once, right after login,
on the landing screen, and locked after that (same ban policy as before if
it's later reported as inaccurate).

## Deploy
Plain Node.js + Express + Socket.io app — deployable on Render, Railway, Fly.io, a VPS, etc.
1. Push this folder to a repo (or upload directly to your host).
2. Start command: `node server/index.js`.
3. Set `PORT` env var if your host requires it (defaults to 3000).
4. **Use HTTPS in production** — required for camera/mic access and reliable WebRTC.

## Before this handles real public traffic
- Gender verification (blurred clip) is a deterrent, not cryptographic proof.
- No age gate / auth yet — add an 18+ consent screen before going live.
- No content moderation beyond the report system — see below.
- Matching queues, pairs, presence, and sessions live in Redis (`server/state.js`), so the app scales horizontally: set `REDIS_URL` on every instance and users match/chat across instances automatically (Socket.IO Redis adapter + atomic Lua matchmaking; no load-balancer sticky sessions needed — clients connect WebSocket-first). Without `REDIS_URL` it runs single-instance on the Upstash REST credentials. See `../SCALING.md` for the full growth plan and load testing.
- SQLite (WAL mode) handles concurrent reads/writes properly and comfortably supports thousands of concurrent users on one server — swap for Postgres only if you outgrow a single machine (multiple app servers writing to the same database).
- Login sessions are Redis-backed tokens (7-day TTL by default, `SESSION_TTL_SEC`), so restarts/redeploys no longer log everyone out and sessions work across instances.
- WebRTC uses STUN by default; set `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL` to hand browsers a TURN relay (free Metered OpenRelay values are commented in `.env.example`, or self-host coturn) for users behind strict NATs/firewalls who can't connect peer-to-peer.
- Voice messages / verification clips are sent as base64 over the socket connection and stored as base64 in SQLite — fine at moderate scale, but move to object storage (S3, etc.) if voice messages get heavy usage.
- `is_premium` / `is_banned` columns already exist on the `users` table (currently unused) so a future admin panel for premium features, ads, or moderation can be wired in without another database migration.

## Layout & features
- **Accounts & chat history**: sign up / log in (username + password) right when you land. Your account, past conversations, and every text/voice message are stored server-side in a local SQLite database (`server/data/syncchat.db`) — not in the browser — so history follows your login rather than the device. Click the **History** button (top bar, after logging in) to open a Telegram-style side panel of past conversations; click one to reopen it with prior messages restored. If that stranger is currently online, you're paired directly and can keep chatting live; if they're offline, you see the saved messages read-only with a banner explaining they're not currently reachable.
- All controls (Verify, Voice, Switch mode, Skip, Report, Stop) live in the top bar.
- **Reporting**: Report opens a modal with fixed reasons (incorrect/misrepresented gender, inappropriate behavior, fraud/scam, or other + details). By default, any submitted report results in an **immediate permanent ban** of the reported account — they're disconnected on the spot and can't log back in. This is a real, enforced policy (not just logged), backed by the gender self-declaration shown at signup. Reports are stored permanently for review.
- **Admin panel**: a separate, standalone application (`../admin-panel`) manages users/bans, reviews reports (including reversing a ban if a report turns out to be bad-faith), and can turn the auto-ban policy off in favor of manual review. It also manages ads, premium plans, and other monetization settings. It's a different codebase and process from this app — see `admin-panel/README.md`.
- Video mode: two equal, slightly rounded panels (You / Stranger). The stranger's screen only ever shows, one at a time: the blurred preview (Continue/Skip), plain overlaid chat text (no bubble background), the switch-mode Agree/Decline card, and a single fading status toast (for general status like "Connected" or "Partner left"). Verify clips, voice-call cards, and voice messages never appear there — only in the text-chat log.
- Text mode: same shell, no video panels; full chat log with normal bordered bubbles, verify clips, voice-call cards, and voice messages all visible.
- A bordered, slightly rounded panel holds the message list in both modes.
- Verify (text mode): sends a short (~2.5s) blurred video clip automatically to both sides, fixed-size and center-cropped so both clips display identically; unblurring ("reveal") is a separate, consent-gated step.
- Voice (text mode): live audio-only call alongside text, consent-gated; becomes "End Voice" while active, and properly notifies your partner if you switch to video mid-call.
- Hold-to-record voice messages: press and hold the mic icon, release to send (text mode only, hidden in video mode).
- Full-width pill message input under the panels.
