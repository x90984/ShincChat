# SyncChat

Gender-matched random chat (text + video) with built-in blurred verification,
live voice, voice messages, friends, and profiles.

This repo has two independent apps:

- **`random-chat/`** — the live site everyone uses. See `random-chat/README.md`
  for local setup.
- **`admin-panel/`** — an internal tool for managing users, bans, reports,
  and monetization settings. See `admin-panel/README.md`. It's a completely
  separate process from the main app; the two only share a SQLite file on
  disk.

## Scaling

The app is horizontally scalable — matchmaking, pairing, presence, and
sessions all live in Redis, and instances share load automatically when
`REDIS_URL` is set. See **[SCALING.md](./SCALING.md)** for the zero-cost
growth plan, capacity math, load-testing tools, and the honest limits of
free infrastructure.

## Deploying to Render via GitHub

See **[DEPLOY.md](./DEPLOY.md)** for the full step-by-step walkthrough —
pushing this repo to GitHub, connecting it to Render, environment variables,
and notes on persisting data across deploys.
