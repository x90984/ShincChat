// loadtest/load.js — concurrency simulator for the matching + relay path.
// Creates N anonymous sockets against a target server, pairs them through
// the real matchmaking flow, then has each pair exchange messages. Reports
// connect/match rates, match latency, and message round-trips.
//
//   npm install            # once (socket.io-client is a devDependency)
//   node loadtest/load.js [url] [bots] [rampPerSec] [msgIntervalMs]
//   node loadtest/load.js https://your-app.onrender.com 200 20 3000
//
// NOTE: anonymous chatting needs no account (find-partner doesn't require
// auth), so this writes nothing to Postgres — but it DOES use the shared
// queue/pairs in Redis: expect a few Redis commands per match.
const { io } = require('socket.io-client');

const TARGET = process.argv[2] || 'http://localhost:3000';
const BOTS = parseInt(process.argv[3] || '100', 10);
const RAMP = parseInt(process.argv[4] || '20', 10);        // new bots per second
const MSG_MS = parseInt(process.argv[5] || '5000', 10);    // per-bot message interval while matched

let connected = 0, connFailed = 0, matched = 0, matchedEver = 0, partnerLefts = 0;
let msgsSent = 0, msgsRecv = 0;
const matchLatencies = [];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function spawnBot(i) {
  const gender = i % 2 === 0 ? 'male' : 'female';
  const socket = io(TARGET, { transports: ['websocket'], reconnection: false });
  let searchingAt = null;
  let msgTimer = null;

  socket.on('connect', () => {
    connected++;
    searchingAt = Date.now();
    socket.emit('find-partner', { gender, lookingFor: 'any', countryMode: 'random' });
  });
  socket.on('connect_error', () => { connFailed++; });
  socket.on('disconnect', () => { connected--; if (msgTimer) { clearInterval(msgTimer); msgTimer = null; } });

  socket.on('matched', () => {
    if (searchingAt) matchLatencies.push(Date.now() - searchingAt);
    searchingAt = null;
    matched++; matchedEver++;
    if (msgTimer) clearInterval(msgTimer);
    msgTimer = setInterval(() => {
      msgsSent++;
      socket.emit('chat-message', { text: `loadtest ping ${Date.now()}` });
    }, MSG_MS + Math.floor(Math.random() * MSG_MS));
  });
  socket.on('chat-message', () => { msgsRecv++; });
  socket.on('partner-left', () => {
    matched--; partnerLefts++;
    if (msgTimer) { clearInterval(msgTimer); msgTimer = null; }
    // Behave like a real client: look for the next partner.
    searchingAt = Date.now();
    setTimeout(() => socket.emit('skip'), 250 + Math.random() * 750);
  });

  // Occasional skip-churn so queues don't stay static.
  setInterval(() => {
    if (searchingAt && Date.now() - searchingAt > 15_000) {
      searchingAt = Date.now();
      socket.emit('skip');
    }
  }, 15_000).unref();
}

let spawned = 0;
const spawner = setInterval(() => {
  const batch = Math.min(RAMP, BOTS - spawned);
  for (let k = 0; k < batch; k++) spawnBot(spawned++);
  if (spawned >= BOTS) clearInterval(spawner);
}, 1000);

setInterval(() => {
  const sorted = [...matchLatencies].sort((a, b) => a - b);
  console.log(
    `[${new Date().toISOString()}] spawned=${spawned} connected=${connected} failed=${connFailed} ` +
    `inChat=${matched} totalMatches=${matchedEver} lefts=${partnerLefts} ` +
    `msgs sent/s=${msgsSent} recv/s=${msgsRecv} ` +
    `matchLatency p50=${percentile(sorted, 50)}ms p95=${percentile(sorted, 95)}ms samples=${sorted.length}`
  );
  msgsSent = 0; msgsRecv = 0;
}, 5000);

console.log(`Load test → ${TARGET} | ${BOTS} bots, ramp ${RAMP}/s, msg every ~${MSG_MS}ms. Ctrl+C to stop.`);
