// loadtest/cluster.e2e.js — end-to-end CLUSTER test: boots TWO mini-server
// instances against one Redis, then connects socket.io clients to different
// instances and asserts they can match + chat with each other, and that
// concurrent same-gender contention pairs exactly one cross-instance pair.
//
//   REDIS_URL=redis://127.0.0.1:6399 node loadtest/cluster.e2e.js
const { spawn } = require('child_process');
const path = require('path');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6399';
const PREFIX = 'e2e' + Math.floor(Math.random() * 1e6);
const P1 = 8411, P2 = 8412;

let passed = 0, failed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
};

function startWorker(port) {
  const child = spawn(process.execPath, [path.join(__dirname, 'mini-server.js')], {
    env: { ...process.env, REDIS_URL, PORT: String(port), STATE_PREFIX: PREFIX },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [w${port}] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`  [w${port} ERR] ${d}`));
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`);
      if (res.status === 200) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

function connect(port) {
  const { io } = require('socket.io-client');
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting '${event}'`)), timeoutMs);
    socket.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

(async () => {
  console.log('Booting two mini-server instances...');
  const w1 = startWorker(P1);
  const w2 = startWorker(P2);
  const cleanup = () => { w1.kill('SIGKILL'); w2.kill('SIGKILL'); };
  process.on('exit', cleanup);

  ok(await waitForHealth(P1), 'worker 1 up');
  ok(await waitForHealth(P2), 'worker 2 up');

  // ---- Test 1: cross-instance match + relay ----
  const a = await connect(P1);
  const b = await connect(P2);
  const matchA = once(a, 'matched', 8000);
  const matchB = once(b, 'matched', 8000);
  a.emit('find-partner', { gender: 'male' });
  b.emit('find-partner', { gender: 'female' });
  const [mA, mB] = await Promise.all([matchA, matchB]).catch((e) => {
    ok(false, `cross-instance match (${e.message})`);
    return [null, null];
  });
  if (mA && mB) {
    ok(true, 'cross-instance match (client on instance A matched client on B)');
    ok(mA.partner === b.id && mB.partner === a.id, 'match partners are the two real clients');
    const got = once(b, 'chat-message', 5000);
    a.emit('chat-message', { text: 'hello across instances' });
    const msg = await got.catch(() => null);
    ok(msg && msg.text === 'hello across instances', 'cross-instance message relay via Redis adapter');
  }
  a.disconnect(); b.disconnect();
  await sleep(500);

  // ---- Test 2: contention — 2 males (one per instance) + 1 female pair exactly once ----
  const m1 = await connect(P1);
  const m2 = await connect(P2);
  const f1 = await connect(P1);
  const results = { m1: null, m2: null, f1: null };
  m1.on('matched', (d) => { results.m1 = d; });
  m2.on('matched', (d) => { results.m2 = d; });
  f1.on('matched', (d) => { results.f1 = d; });
  m1.emit('find-partner', { gender: 'male' });
  m2.emit('find-partner', { gender: 'male' });
  await sleep(300); // let both males queue on different instances
  f1.emit('find-partner', { gender: 'female' });
  await sleep(4000);
  const maleMatches = [results.m1, results.m2].filter(Boolean).length;
  ok(maleMatches === 1, `exactly one of the two contending males matched (got ${maleMatches})`);
  ok(!!results.f1 === (maleMatches === 1), 'female matched exactly when one male did');
  if (results.f1 && results.maleMatchedPartner) { /* informational */ }
  m1.disconnect(); m2.disconnect(); f1.disconnect();
  await sleep(300);

  cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('E2E ERROR:', e); process.exit(1); });
