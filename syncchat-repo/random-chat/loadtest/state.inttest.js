// loadtest/state.inttest.js — live integration test of the shared-state
// layer against a REAL Redis. Run with:
//   REDIS_URL=redis://127.0.0.1:6399 node loadtest/state.inttest.js
// Exercises sessions, presence, blocklists, atomic matchmaking (including
// country/nearby scoping and block filtering), pairing, and the janitor.
process.env.STATE_PREFIX = process.env.STATE_PREFIX || 'test' + Math.floor(Math.random() * 1e6);
const state = require('../server/state');

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const entry = (gender, over = {}) => ({
  gender, lookingFor: 'any', countryMode: 'random', country: null,
  lat: null, lon: null, detectedCountry: null, userId: null, queuedAt: Date.now(), ...over
});

(async () => {
  await state.init({ io: null, db: null });
  console.log('state.init OK, driver connected');

  // ---- sessions ----
  const tok = await state.createSession('user-1');
  ok(await state.getSessionUser(tok) === 'user-1', 'session roundtrip');
  ok(await state.getSessionUser('nope') === null, 'unknown session => null');

  // ---- oauth pkce ----
  await state.oauthStateSet('st1', { provider: 'google', verifier: 'v' }, 300);
  ok((await state.oauthStateTake('st1') || {}).verifier === 'v', 'oauth state take');
  ok(await state.oauthStateTake('st1') === null, 'oauth state consumed once');

  // ---- block/mute ----
  await state.setBlocklist('u1', ['u2', 'u3']);
  const blk = await state.blocksOf('u1');
  ok(blk.has('u2') && blk.size === 2, 'blocklist roundtrip');
  await state.setMutelist('u1', ['u9']);
  ok((await state.mutesOf('u1')).has('u9'), 'mutelist roundtrip');
  ok(await state.isBlockedPair('u1', 'u3') === true, 'isBlockedPair true');
  ok(await state.isBlockedPair('u1', 'u4') === false, 'isBlockedPair false');

  // ---- presence ----
  await state.setOnline('u1', 'sock-a');
  let o = await state.onlineSocketOf('u1');
  ok(o && o.socketId === 'sock-a', 'onlineSocketOf');
  ok(await state.isOnline('u1') === true, 'isOnline true');
  const m = await state.onlineSockets(['u1', 'u-ghost']);
  ok(m.get('u1') && m.get('u1').socketId === 'sock-a' && m.get('u-ghost') === null, 'onlineSockets batch');
  await state.setOffline('u1', 'WRONG-SOCKET');
  ok(await state.isOnline('u1') === true, 'setOffline wrong socket keeps presence');
  await state.setOffline('u1', 'sock-a');
  // bust the local cache the same way a fresh read would
  await new Promise(r => setTimeout(r, 5));
  ok((await state.onlineSockets(['u1'])).get('u1') === null, 'setOffline removes presence');

  // ---- matchmaking: basic cross-gender match ----
  const me = entry('male', { userId: 'm1' });
  const her = entry('female', { userId: 'f1' });
  await state.enqueue('sock-F', her);
  const match = await state.findMatch('sock-M', me);
  ok(match && match.candidateId === 'sock-F', 'basic match found', JSON.stringify(match));
  ok(match && match.entry && match.entry.uid === 'f1', 'match returns candidate entry');
  ok(await state.pairOf('sock-M') === 'sock-F', 'pairOf M -> F');
  ok(await state.pairOf('sock-F') === 'sock-M', 'pairOf F -> M');
  ok(await state.pairUserOf('sock-M') === 'f1', 'pairUserOf M -> f1');
  ok(!state.localQueued.has('sock-M') && !state.localQueued.has('sock-F'), 'matched sockets leave localQueued');

  // claiming a busy pair must fail atomically
  ok(await state.claimPair('sock-M', 'sock-X', 'm1', 'x') === false, 'claimPair busy socket rejected');

  // release
  const ex = await state.releasePair('sock-M');
  ok(ex === 'sock-F', 'releasePair returns partner');
  ok(await state.pairOf('sock-F') === null, 'release clears both sides');

  // ---- conv mapping ----
  await state.convSet('sock-M', 'conv-1');
  ok(await state.convOf('sock-M') === 'conv-1', 'convSet/convOf');

  // ---- matchmaking: no candidate => queued ----
  const lonely = entry('male', { userId: 'm-lonely' });
  const none = await state.findMatch('sock-L', lonely);
  ok(none === null, 'no candidate => null (queued)');
  ok(state.localQueued.has('sock-L'), 'queued socket tracked locally');

  // ---- matchmaking: block filtering (seeker blocked candidate) ----
  await state.setBlocklist('m-blocker', ['f-blocked']);
  await state.dequeue('sock-L'); // clear the lonely male
  await state.enqueue('sock-F2', entry('female', { userId: 'f-blocked' }));
  const blockedMatch = await state.findMatch('sock-B', entry('male', { userId: 'm-blocker' }));
  ok(blockedMatch === null, 'seeker-blocked candidate not matched');
  ok(state.localQueued.has('sock-B'), 'blocked seeker still queued');

  // reverse direction: candidate blocks seeker (checked in JS, requeue expected)
  await state.setBlocklist('f-guarded', ['m-rejected']);
  await state.dequeue('sock-B');
  ok(!state.localQueued.has('sock-B'), 'dequeue clears localQueued');
  await state.enqueue('sock-F3', entry('female', { userId: 'f-guarded' }));
  const rev = await state.findMatch('sock-R', entry('male', { userId: 'm-rejected' }));
  // sock-F2 is older (enqueued first) but is matched-eligible only for non-blockers;
  // m-rejected CAN match f-blocked (not blocked that direction), so we accept either
  // outcome as long as f-guarded was NOT chosen.
  ok(!rev || rev.candidateId !== 'sock-F3', 'reverse-blocked candidate skipped/requeued');
  if (rev) {
    ok(rev.candidateId === 'sock-F2', 'older eligible candidate picked');
    await state.releasePair('sock-R');
  }
  // f-guarded should still be waiting in the queue
  const qAfter = await state.findMatch('sock-R2', entry('male', { userId: 'm-any2' }));
  ok(qAfter && qAfter.candidateId === 'sock-F3', 'requeued candidate survives for others');
  if (qAfter) await state.releasePair('sock-R2');

  // ---- matchmaking: country scoping ----
  const inFemale = entry('female', { userId: 'f-in', countryMode: 'india' });
  await state.enqueue('sock-IN', inFemale);
  const usMale = entry('male', { userId: 'm-us', detectedCountry: 'US' });
  const cs1 = await state.findMatch('sock-US', usMale);
  ok(cs1 === null, 'india-mode female not matched to US male');
  await state.dequeue('sock-US');
  const inMale = entry('male', { userId: 'm-in', detectedCountry: 'IN' });
  const cs2 = await state.findMatch('sock-IN-M', inMale);
  ok(cs2 && cs2.candidateId === 'sock-IN', 'india-mode female matched to IN male');
  if (cs2) await state.releasePair('sock-IN-M');

  // ---- matchmaking: nearby scoping ----
  const nearbyF = entry('female', { userId: 'f-near', countryMode: 'nearby', lat: 28.6139, lon: 77.2090 }); // Delhi
  await state.enqueue('sock-NEAR', nearbyF);
  const farM = entry('male', { userId: 'm-far', countryMode: 'nearby', lat: 19.0760, lon: 72.8777 }); // Mumbai ~1150km
  const nb1 = await state.findMatch('sock-FAR', farM);
  ok(nb1 === null, 'nearby: 1150km apart not matched');
  await state.dequeue('sock-FAR');
  const nearM = entry('male', { userId: 'm-near', countryMode: 'nearby', lat: 28.6200, lon: 77.2100 }); // ~1km
  const nb2 = await state.findMatch('sock-NEAR-M', nearM);
  ok(nb2 && nb2.candidateId === 'sock-NEAR', 'nearby: 1km apart matched');
  if (nb2) await state.releasePair('sock-NEAR-M');

  // ---- janitor: dead-instance queue entries are reaped ----
  const deadSock = 'sock-DEADINST';
  const { createClient } = require('redis');
  const raw = createClient({ url: process.env.REDIS_URL });
  await raw.connect();
  const prefix = process.env.STATE_PREFIX;
  await raw.hSet(`${prefix}:qentry`, deadSock, JSON.stringify({ g: 'female', m: 'india', qa: Date.now(), inst: 'ghost-inst' }));
  await raw.zAdd(`${prefix}:q:female`, { score: Date.now(), value: deadSock });
  ok((await state.janitorQueues(), await raw.zScore(`${prefix}:q:female`, deadSock)) === null, 'janitor reaps dead-instance queue entry');
  await raw.quit();

  // ---- leader lock ----
  ok(await state.acquireLock('test-lock', 30) === true, 'first lock acquire wins');
  ok(await state.acquireLock('test-lock', 30) === false, 'second lock acquire blocked');

  // ---- sweep: partner on dead instance ----
  await state.claimPair('sock-alive', 'sock-ghost', 'ua', 'ug');
  const raw2 = createClient({ url: process.env.REDIS_URL });
  await raw2.connect();
  await raw2.hSet(`${prefix}:sockinst`, 'sock-ghost', 'ghost-inst');
  await raw2.quit();
  const dead = await state.sweepLocalPairs(['sock-alive']);
  ok(dead.includes('sock-alive'), 'sweepLocalPairs detects partner on dead instance');
  for (const s of dead) await state.releasePair(s);

  await state.shutdown();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('INTTEST ERROR:', e); process.exit(1); });
