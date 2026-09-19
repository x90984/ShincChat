# Deploying to Render via GitHub

This repo is ready to push as-is. The steps below take you from "code on my
computer" to "live URL," start to finish.

## 1. Push this repo to GitHub

If you haven't already, create an empty repository on GitHub (no README, no
`.gitignore` — this project already has both), then from this folder:

```bash
git init
git add -A
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## 2. Create the Render service

You have two options — pick one:

### Option A — Blueprint (recommended, one click)
1. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**.
2. Connect your GitHub account if you haven't, then pick this repo.
3. Render reads `render.yaml` at the repo root and proposes the service(s)
   described in it (the main site, and optionally the admin panel).
4. Review and click **Apply**.

### Option B — Manual web service
1. **New** → **Web Service** → connect this repo.
2. **Root Directory**: `random-chat`
3. **Build Command**: `npm install`
4. **Start Command**: `npm start`
5. **Instance Type**: Free is fine to start.

Either way, Render builds and deploys automatically — you'll get a URL like
`https://syncchat.onrender.com` within a couple of minutes.

## 3. Environment variables

Set these in the service's **Environment** tab (not in a committed `.env`
file — `.gitignore` already excludes those on purpose):

| Variable | Required? | Notes |
|---|---|---|
| `PORT` | No | Render sets this automatically. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | No | Only needed for the "Continue with Google" button. Without them, that button just doesn't appear — email/mobile signup always works. See `random-chat/server/oauth.js` for where to get these and which redirect URI to register with Google. |
| `OAUTH_BASE_URL` | Only if using Google login | Set to your Render URL, e.g. `https://syncchat.onrender.com`. You'll only know the exact URL after the first deploy, so deploy once, copy the URL, then set this and redeploy. |
| `DATA_DIR` | No | Where the SQLite file lives. Only matters if you've attached a persistent disk (next section) — point this at the disk's mount path. |

## 4. Persisting data across deploys (important)

**On Render's free plan, the filesystem is wiped on every deploy and every
time the service restarts/sleeps.** That means without a persistent disk,
every account, chat, and message resets periodically — fine for a demo,
not fine for a real launch.

To fix this, add a **Disk** (Render calls it that) — available on paid
instance types:

1. In the service's **Disks** tab, add a disk (e.g. name `syncchat-data`,
   mount path `/var/data`, size 1GB is plenty to start).
2. Set the `DATA_DIR` environment variable to that same mount path
   (`/var/data`).
3. Redeploy. The SQLite file now lives on the disk and survives restarts.

`render.yaml` already has this disk config written in, just commented out —
uncomment it once you're on a plan that supports disks.

## 5. About the admin panel

The admin panel (`admin-panel/`) reads/writes the *same SQLite file* as the
main app **only when they're on the same filesystem** — which is true when
running both locally, but **not** true on Render: each Render service gets
its own isolated disk, and Render doesn't support attaching one disk to two
services. Deploying `admin-panel` as its own Render service means it'll have
its own separate, empty database — not a view into the live site's real data.

Simplest ways to manage your live site's real data instead:
- Run the admin panel **locally**, pointed at a downloaded copy of the
  production `syncchat.db` file (via `DB_PATH` in `admin-panel/.env`).
- Or, if you need live remote access to it regularly, the real fix is
  migrating from a local SQLite file to a shared network database (Render's
  managed Postgres, for example) that both services connect to over the
  network instead of a file on disk. That's a bigger change than this
  guide covers, but it's the standard path once a single SQLite file
  stops being enough.

## 6. Scaling beyond one instance

The app is horizontally scalable: sessions, matchmaking, pairing, and
presence live in Redis, and a Socket.IO Redis adapter routes messages
between instances. See **[SCALING.md](./SCALING.md)** for the full
zero-cost growth plan (free-tier ladder, capacity math, per-stage
deployment recipes, TURN strategy, and load testing).

Extra environment variables involved:

| Variable | Required? | Notes |
|---|---|---|
| `REDIS_URL` | Only for multi-instance | Standard Redis TCP URL (`rediss://...` for TLS). Enables cluster mode: shared queues/presence + cross-instance messaging. Any Redis ≥ 5 works — Upstash's TCP endpoint, Redis Cloud free, or self-hosted on a free VM. |
| `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` | No | Adds a TURN relay to the browser's ICE config (comma-separated URLs) for calls that can't connect peer-to-peer. Free options: Metered OpenRelay (20 GB/mo) or self-hosted coturn. |
| `SESSION_TTL_SEC` | No | Login token lifetime in seconds (default 604800 = 7 days). |

## 7. Custom domain (optional)

Render's **Settings → Custom Domain** tab walks through adding your own
domain with automatic HTTPS. If you use Google login, remember to update
`OAUTH_BASE_URL` (and the redirect URI registered with Google) to match.

## 8. Redeploying after future changes

Render redeploys automatically on every push to your connected branch —
just `git push` and it picks it up.
