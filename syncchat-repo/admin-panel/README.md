# SyncChat Admin Panel

A standalone admin application for the SyncChat random-chat app. **It is a separate codebase and a separate running process** — it is not imported by, bundled with, or deployed as part of the main app. The only thing the two share is the SQLite database file on disk; the admin panel reads and writes it directly.

## What it does
- **Dashboard** — live counts: total/banned/premium users, conversations, messages, reports, active ads/plans.
- **Users** — search, ban / unban, grant or remove premium, per account.
- **Reports** — every report filed against a user (reason: incorrect gender, inappropriate, fraud, or other + optional details), who filed it, and whether it resulted in a ban. Includes a "Reverse Ban" action for handling bad-faith reports.
- **Ads** — create/edit/delete ad slots (title, body, image URL, link URL, placement: onboarding gate / in-chat banner / history panel, enabled toggle). *Note: the main app doesn't render these yet — this manages the data layer; wiring actual ad display into the main app's UI is a follow-up.*
- **Premium Plans** — create/edit/delete subscription tiers (name, price, currency, billing interval, feature list, enabled toggle). *Note: this manages plan definitions; actual payment processing (Stripe etc.) isn't wired up — that's a real integration to add when you're ready to charge people.*
- **Monetization** — toggle "auto-ban on report" (on by default, matching the main app's stated policy) and toggle/adjust each earning method independently: banner ads, premium subscriptions, pay-per-minute video (adjustable rate), coin/gifting (adjustable price), referral program (adjustable bonus). These are groundwork switches the main app can check via the shared `settings` table as each feature gets built out — flipping them here doesn't yet turn on features the main app hasn't implemented (e.g. there's no in-app payment flow yet), except **auto-ban on report**, which the main app actively checks live.

## Setup
```bash
cd admin-panel
npm install
npm start
```
Runs on `http://localhost:4000` by default.

On first visit, since no admin account exists yet, you'll be prompted to create one (username + password, 8+ characters). This only works once — after the first admin is created, that endpoint refuses to create another (add more admins directly in the `admins` table if you need multiple).

## Configuration
Environment variables:
- `ADMIN_PORT` — port to run on (default `4000`)
- `DB_PATH` — path to the shared SQLite file (default: `../random-chat/server/data/syncchat.db`, i.e. assumes this folder sits next to `random-chat/`)

Example running it against a database on a different machine/path:
```bash
DB_PATH=/var/data/syncchat.db ADMIN_PORT=4000 npm start
```

## Deployment note
In production, run this on a different host/port than the main app, and put it behind its own access control (VPN, IP allowlist, or at minimum don't expose port 4000 publicly) — this panel can ban any account and change monetization settings, so it shouldn't be reachable by the general public at all.
