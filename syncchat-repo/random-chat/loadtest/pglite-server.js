// loadtest/pglite-server.js — dev/preview Postgres that needs no cloud
// account. Boots PGlite (real Postgres compiled to WebAssembly) and serves
// it over the Postgres wire protocol on 127.0.0.1:5544, so the app's `pg`
// driver + DATABASE_URL work unchanged:
//
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5544/postgres
//
// Packages are sandbox-only: npm install --no-save @electric-sql/pglite @electric-sql/pglite-socket
// Data persists under server/data/pglite (already git-ignored).
const path = require('path');

(async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

  const dataDir = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', 'server', 'data', 'pglite');
  const port = parseInt(process.env.PGLITE_PORT || '5544', 10);

  const db = new PGlite(dataDir);
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  console.log(`pglite-postgres ready on 127.0.0.1:${port} (data: ${dataDir})`);

  const stop = () => server.stop().then(() => db.close()).then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})().catch((e) => { console.error('pglite boot failed:', e); process.exit(1); });
