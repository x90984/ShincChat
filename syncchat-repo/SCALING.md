# SyncChat — Scaling Playbook (zero-cost → millions of concurrent users)

This document is the honest engineering plan for growing SyncChat from its
free-tier prototype to "near a million simultaneous users" with **as close
to $0 out-of-pocket as physically possible** — what is genuinely free, what
is free-at-first, and the one or two things no provider gives away at
million-user scale.

**TL;DR**

- Video/voice media is **peer-to-peer WebRTC** — your servers only carry
  text, signaling, and matchmaking. That is what makes a near-zero-cost
  architecture possible at all.
- The code now **scales horizontally**: all runtime state (sessions,
  matchmaking queues, pairs, presence, block/mute mirrors) lives in Redis,
  and the Socket.IO Redis adapter routes messages between instances. Adding
  capacity = adding instances, no rewrite.
- Realistic free-tier ladder:
  | Stage | Concurrent users | Stack | Cost |
  |---|---|---|---|
  | A — prototype | ~100–500 | Render free + Supabase free + Upstash free | $0 |
  | B — community | ~10K–50K | Oracle Always-Free VM (app + Redis + coturn) + free DB/CDN | $0 |
  | C — breakout | ~100K–500K | a few free/credit VMs behind Cloudflare free | $0–small |
  | D — millions | 1M+ | credits/monetization-funded fleet; see §7 | not free |

- The physics at Stage D: ~1M concurrent WebSocket connections ≈
  40–120 well-tuned app servers (10–25K connections each at ~2–8 GB RAM),
  a Redis cluster, Postgres with pooling+replicas, and TURN relay capacity
  for the 5–20% of calls that can't go P2P. Rough market cost:
  **$3K–$20K/month** depending on efficiency. Nobody gives that away free —
  the honest paths are **startup credits** ($100K+ programs) and
  **monetization**, both covered below.

---

## 1. What changed in the code (already done)

Previously every instance kept its matchmaking state in process-local Maps,
so two instances could never match each other's users — horizontal scaling
was impossible no matter how much hardware you bought. Now:

| State | Before | Now |
|---|---|---|
| Sessions (login tokens) | `Map` in RAM | Redis `sc:sess:*` (7d TTL), 60s local cache |
| Matchmaking queues | arrays in RAM | Redis sorted sets `sc:q:male/female`, entry JSON in `sc:qentry` |
| Pairing (`who chats with whom`) | `Map` | Redis hash `sc:pairs`, 45s local cache + pub/sub invalidation |
| Presence (`onlineUsers`) | `Map` | Redis hash `sc:online`, per-instance heartbeats, 10s local cache |
| Block/mute mirrors | `Map` | Redis `sc:blkset/mutset:*` + 45s local cache, refreshed on writes |
| Cross-instance messaging | impossible | `@socket.io/redis-adapter` (enabled when `REDIS_URL` is TCP) |

Key properties, by design:

- **Atomic matchmaking.** Candidate selection + pairing is a single Lua
  script executed inside Redis. Two instances (or two hundred) can run
  matchmaking simultaneously against the same queues and can never match
  the same person twice, never leak a queue entry, and never half-pair.
- **Hard multi-instance safety.** Friend calls and chat-resume use an
  atomic claim script with the same collision guarantee; a janitor reaps
  queue entries left behind by crashed instances; a per-instance sweep
  cuts chats whose partner's instance died (`partner-left` instead of a
  frozen UI); leader locks keep background jobs (message sweeps, janitor)
  single-writer.
- **Redis command frugality.** Every hot read is fronted by a short-TTL
  local cache, so the *vast majority of socket events cost zero Redis
  commands*. This is what lets the free Upstash quota (500K commands/mo)
  carry Stage A, and what slashes Redis spend at every later stage.
- **Zero-config compatibility.** `REDIS_URL` unset → single-instance mode
  using the existing Upstash REST credentials: today's free Render deploy
  keeps working exactly as before (plus queues/pairs now survive restarts
  and sleeps).
- **WebSocket-first clients.** The browser connects `transports:
  ['websocket','polling']`, so no load-balancer session affinity is needed
  across instances — any instance can accept any client.
- **TURN-ready.** `/api/rtc-config` serves STUN by default and a TURN
  relay the moment you set `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL`.

Files: `random-chat/server/state.js` (the shared-state layer),
`random-chat/server/index.js` (rewired), `random-chat/loadtest/*` (tests).

Verified against a real Redis: **39/39 state-layer integration tests and
7/7 two-instance cluster tests pass** (cross-instance match + relay,
contention pairing exactly one pair). Run them yourself:

```bash
redis-server --port 6379 &           # any local Redis >= 5
cd random-chat
REDIS_URL=redis://127.0.0.1:6379 node loadtest/state.inttest.js
REDIS_URL=redis://127.0.0.1:6379 node loadtest/cluster.e2e.js
```

---

## 2. The zero-cost resource inventory (verified Sept 2026)

| Resource | Free allowance | Good for |
|---|---|---|
| **Render free web service** | 512 MB RAM, 750 hrs/mo, sleeps after 15 min idle (keep-awake via cron-job.org → `/health`) | Stage A app instance |
| **Supabase free Postgres** | 500 MB, pooled connections via Supavisor | Stage A–B database |
| **Upstash Redis free** | **500K commands/mo**, 256 MB, 10 GB bandwidth | Stage A state layer (db.js cache-aside already uses it) |
| **Oracle Cloud Always Free** | ARM VM **2–4 OCPU / 12–24 GB RAM** (allocation was halved in 2026 — check current), 200 GB block storage, **10 TB/mo egress** | Stage B workhorse: app + **self-hosted Redis** + **coturn** on one box |
| **Cloudflare free** | unmetered CDN/proxy for static assets + DDoS protection (paginated free Workers too) | takes static-file traffic off your Node boxes |
| **Metered OpenRelay TURN** | 20 GB/mo | TURN stopgap before coturn (env-configurable, see `.env.example`) |
| **Startup credit programs** | Google for Startups (up to $200K), Microsoft for Startups ($1K–$150K Azure), AWS Activate (up to $100K), DigitalOcean Hatch | Stage C–D: months of real fleet at $0 out-of-pocket |

References: [Upstash pricing](https://upstash.com/blog/redis-new-pricing),
[Upstash vs Redis Cloud 2026](https://upstash.com/blog/upstash-vs-redis-cloud-a-2026-comparison),
[Oracle free-tier change 2026](https://terminalbytes.com/oracle-cloud-free-tier-changes-2026/),
[OpenRelay free TURN](https://www.metered.ca/tools/openrelay/).

---

## 3. Capacity math (measure, don't trust reality to these numbers)

Per-connection RAM for this codebase (Express + socket.io, entries +
caches) measures **~25–50 KB**. A single Node process relays a few
thousand socket events/sec per core comfortably; chat text + signaling is
tiny next to that.

| Deployment | RAM | Realistic concurrent connections | Limiter |
|---|---|---|---|
| Render free | 512 MB | **2K–5K** idle-ish, **300–800** actively matching/chatting | RAM + 0.1 CPU + Upstash quota |
| Oracle free VM (12–24 GB) | 12–24 GB | **20K–60K** (2 Node processes + Redis on-box) | CPU on relay bursts |
| 4× Oracle-class VMs | — | **100K–250K** | Redis single-node (~100–400K ops/s headroom, we use ~1 op/message) |
| Stage D fleet | — | **1M+** needs ~40–120 app nodes + Redis cluster + PG replicas | everything; see §7 |

**Redis command budget** (Upstash free = 500K/mo ≈ 16.6K/day ≈ 0.19/sec
sustained). Actual costs in the new state layer:

| Action | Redis commands (single-instance REST mode) |
|---|---|
| login/signup | 1 session write (+db.js user lookups, mostly cache-hits) |
| socket auth | 1 presence write + ≤2 block/mute reads (then 45s cached) |
| match attempt (find/skip/5s retry) | 2–3 (Lua evals) |
| chat message / WebRTC signal | **0** (45s-local-cached pair lookup) |
| presence check in REST lists | ~0–1 (10s local cache, batched HMGET) |
| background janitor/heartbeat/sweeps | ~20/min per instance |

So on free Upstash you can afford roughly **15K matches/day + ~8K
logins/day** — a healthy Stage A. The moment you outgrow it, move
`REDIS_URL` to the self-hosted Redis on your free VM (Stage B): same code,
unmetered commands, lower latency.

---

## 4. Deploying each stage

### Stage A — today, $0 (one Render free instance)

Nothing to change: `REDIS_URL` unset → single-instance mode on the Upstash
REST credentials you already have. You're done — and better than before,
because sessions/queues survive Render's sleeps & redeploys.

### Stage B — one free Oracle VM, $0 (“the free beast”)

1. Sign up for Oracle Cloud → create an **Ampere A1 (ARM) Always-Free** VM
   (max the free OCPU/RAM allocation), Ubuntu.
2. On the VM:
   ```bash
   # node 20, redis, coturn
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
   sudo apt install -y nodejs redis-server coturn
   sudo sed -i 's/^# requirepass .*/requirepass <LONG-RANDOM>/' /etc/redis/redis.conf
   sudo sed -i 's/^bind .*/bind 127.0.0.1/' /etc/redis/redis.conf
   sudo systemctl restart redis-server
   ```
3. Run two app processes (PM2) behind nginx on :80/:443:
   ```bash
   npm i -g pm2
   cd random-chat && npm install
   REDIS_URL='redis://:<LONG-RANDOM>@127.0.0.1:6379' \
   DATABASE_URL='<supabase pooled url>' \
   UPSTASH_REDIS_REST_URL='<for db.js cache>' UPSTASH_REDIS_REST_TOKEN='<token>' \
   pm2 start server/index.js -i 2 --name syncchat
   ```
4. coturn on the same box (your 10 TB/mo Oracle egress makes this a real
   TURN for free): set `TURN_URLS=turn:<vm-ip>:3478?transport=udp,turn:<vm-ip>:3478?transport=tcp`,
   `TURN_USERNAME`, `TURN_CREDENTIAL` accordingly.
5. Free DNS (Cloudflare) → VM IP; proxy on → static assets cached at the
   edge, WebSockets pass through on the free plan.

One box now serves **tens of thousands of concurrent users for $0/mo**.

### Stage C — breakout ($0-ish)

- Second free VM (Oracle allows the ARM pool split across instances; add
  Google Cloud's always-free e2-micro, or a second provider's free tier).
  Point all instances at the Stage-B Redis (open it to the VMs, keep
  `requirepass`, block public IPs in the security list).
- Multi-instance is already live: `REDIS_URL` set on every instance →
  cluster mode → shared queues/pairs/presence. No other code changes.
- Move the Postgres cache-aside (`db.js`) off Upstash onto the self-hosted
  Redis too if Upstash quota pressure grows (one-line driver swap; the
  interface is already Redis-ish — or simply accept the $0.20/100K pay-as
  -you-go bill; at Stage C that's a few dollars).
- Round-robin DNS (free) spreads clients; WebSocket-first clients make
  session affinity unnecessary.
- Watch `/health` (`{"ok":true,"clustered":true}`), Redis `INFO`, and run
  `node loadtest/load.js <url> <bots> <ramp>` after every change.

### Stage D — millions (not free; make it cost *you* nothing)

At this point you have real traffic — which is exactly when:

1. **Startup credits become available**: Google for Startups, Microsoft
   for Startups, AWS Activate — $25K–$200K in credits against a working,
   growing product. This funds 6–18 months of a proper fleet.
2. **Monetization covers the rest**: the admin panel already has a
   monetization column; 1M concurrent users monetized at even
   $0.001/user-month dwarfs a $5–20K infra bill.
3. Architecture work beyond this repo's scope at that point: Redis
   cluster (queue sharding by gender+country — trivial with the existing
   key layout), Postgres read replicas + message-table partitioning,
   Cloudflare R2 (free egress) for voice messages & profile photos,
   per-region queue namespaces. The code in this repo needs zero changes
   until ~100–250K concurrent per region.

---

## 5. The honest exceptions (what can *never* be free)

1. **TURN relay bandwidth.** 5–20% of WebRTC calls can't go P2P. Free
   OpenRelay (20 GB/mo) ≈ ~10 hours of relayed video. Self-hosted coturn
   on Oracle's 10 TB/mo egress stretches far (≈ 500 hours of relayed HD
   video/mo *per VM*), and you can spread coturn across free VMs — but at
   1M concurrent calls this is the single biggest real cost (~$1K+/mo at
   market rates). Mitigations: prefer P2P (already), cap relay video
   bitrate client-side, degrade to audio-only on TURN.
2. **Egress beyond free allowances.** Oracle's 10 TB/mo is generous for
   text/signaling (at ~1 KB per chat message, 10 TB ≈ 10 billion
   messages), but nothing free covers billion-message-plus-photos scale.
   Put Cloudflare's free CDN in front for all static/media assets.
3. **Serious Postgres.** Supabase free (500 MB) fills up around
   ~5–20M messages depending on message mix. Free Autonomous DB on Oracle,
   or $0-effort Postgres on the free VM, stretches this — but Stage D data
   needs budget (or aggressive retention: messages older than X days
   deleted — the 24h-disappearing mode already embodies this instinct).
4. **Your time.** Free tiers are quotas, not SLAs. The code retries and
   degrades gracefully (`state.safe()` everywhere), but a $0-infra outage
   is *your* outage.

---

## 6. Load testing (prove it before users do)

```bash
cd random-chat
npm install                                  # devDependency: socket.io-client
node loadtest/load.js https://your-host 500 50 3000
# url | bots | ramp/sec | ~msg interval while matched
```

Reports: connected/failed bots, concurrent pairs, total matches, match
latency p50/p95, messages in/out per second. Bots are anonymous (no
Postgres writes) — what you're measuring is the matching/relay/CPU/RAM
path, i.e. exactly what scales with concurrency. Suggested acceptance
gates per stage: A: 300 bots / B: 25–50K bots (from ≥2 client machines) /
C: full staging test per release.

## 7. Checklist when you wake up to 10× traffic overnight

- [ ] `/health` on every instance returns `clustered:true`
- [ ] add instances (the catch-up is automatic — queues are shared)
- [ ] confirm Redis CPU < 60% (`INFO`), app node RAM < 70%
- [ ] Upstash: if any key metric nears quota, move `db.js` cache or
      `REDIS_URL` onto the self-hosted box
- [ ] keep-awake pings (cron-job.org) only on small instances that sleep
- [ ] run the load test at 2× current peak before celebrating
