// loadtest/mini-server.js — minimal replica of index.js's matching flow,
// used by cluster.e2e.js to verify two real server instances sharing one
// Redis can match and relay cross-instance. Run directly:
//   REDIS_URL=redis://127.0.0.1:6399 PORT=8401 node loadtest/mini-server.js
const http = require('http');
const { Server } = require('socket.io');
const state = require('../server/state');

const PORT = parseInt(process.env.PORT || '8401', 10);
const server = http.createServer();
const io = new Server(server);
const localEntries = new Map();

io.on('connection', (socket) => {
  socket.on('find-partner', ({ gender }) => {
    (async () => {
      if (!['male', 'female'].includes(gender)) return;
      if (process.env.DEBUG_MATCH) console.log(`  [dbg] find-partner ${gender} from ${socket.id}`);
      localEntries.set(socket.id, {
        gender, lookingFor: 'any', countryMode: 'random', country: null,
        lat: null, lon: null, detectedCountry: null, userId: null, queuedAt: Date.now(),
      });
      await state.dequeue(socket.id);
      const m = await state.findMatch(socket.id, localEntries.get(socket.id));
      if (process.env.DEBUG_MATCH) console.log(`  [dbg] findMatch(${socket.id}) =>`, m ? `MATCH ${m.candidateId}` : "queued");
      if (m) {
        io.to(socket.id).emit('matched', { partner: m.candidateId });
        io.to(m.candidateId).emit('matched', { partner: socket.id });
      }
    })().catch((e) => console.error('find-partner failed:', e));
  });

  socket.on('chat-message', ({ text }) => {
    state.pairOf(socket.id)
      .then((p) => { if (p) io.to(p).emit('chat-message', { text }); })
      .catch(() => {});
  });

  socket.on('disconnect', () => {
    localEntries.delete(socket.id);
    state.dequeue(socket.id).catch(() => {});
    state.releasePair(socket.id).catch(() => {});
  });
});

setInterval(() => {
  (async () => {
    for (const socketId of [...state.localQueued]) {
      if (!io.sockets.sockets.get(socketId)) { state.localQueued.delete(socketId); continue; }
      const entry = localEntries.get(socketId);
      if (!entry) { state.localQueued.delete(socketId); continue; }
      const m = await state.findMatch(socketId, entry);
      if (process.env.DEBUG_MATCH) console.log(`  [dbg] retry findMatch(${socketId}) =>`, m ? `MATCH ${m.candidateId}` : "queued");
      if (m) {
        io.to(socketId).emit('matched', { partner: m.candidateId });
        io.to(m.candidateId).emit('matched', { partner: socketId });
      }
    }
  })().catch(() => {});
}, 1000);

state.init({ io, db: null }).then(() => {
  server.listen(PORT, () => console.log(`mini-server up on ${PORT} (instance ${state.INSTANCE_ID})`));
}).catch((e) => { console.error('mini-server boot failed:', e); process.exit(1); });
