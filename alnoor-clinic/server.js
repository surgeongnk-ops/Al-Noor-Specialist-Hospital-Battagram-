// server.js — Al Noor Clinic System
// Pure Node.js (no external dependencies). Run with: node server.js
// Other PCs on the same network reach it at http://<this-PC's-LAN-IP>:3000
//
// This file is intentionally thin — it wires together the modular route files in
// /routes, serves static frontend files, and handles process lifecycle (startup,
// graceful shutdown). All business logic lives in /routes/*.routes.js.

const http = require('node:http');
const path = require('node:path');
const os = require('node:os');

const { db, closeDatabase } = require('./db');
const { hashPassword } = require('./auth');
const { scheduleDailyBackups } = require('./backup');
const { seedAll } = require('./seed');
const { serveStatic, sendJSON } = require('./middleware');
const { mergeRouters, dispatch } = require('./router');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- bootstrap: default admin + master data seed ----------
const staffCount = db.prepare('SELECT COUNT(*) AS c FROM staff').get().c;
if (staffCount === 0) {
  const { hash, salt, costN } = hashPassword('admin123');
  db.prepare('INSERT INTO staff (staff_id, name, role, password_hash, salt, password_cost_n) VALUES (?, ?, ?, ?, ?, ?)')
    .run('admin', 'System Admin', 'admin', hash, salt, costN);
  console.log('Created default admin account -> staff_id: admin / password: admin123 (change this immediately)');
}
seedAll();

// ---------- assemble all routes ----------
const allRoutes = mergeRouters(
  require('./routes/auth.routes'),
  require('./routes/staff.routes'),
  require('./routes/catalog.routes'),
  require('./routes/patients.routes'),
  require('./routes/doctor.routes'),
  require('./routes/lab.routes'),
  require('./routes/radiology.routes'),
  require('./routes/nursing.routes'),
  require('./routes/procedures.routes'),
  require('./routes/dashboard.routes'),
  require('./routes/admin.routes'),
  require('./routes/pharmacy.routes'),
  require('./routes/reports.routes'),
  require('./routes/billing.routes'),
  require('./routes/export.routes'),
  require('./routes/certificates.routes'),
  require('./routes/analyzers.routes')
);

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = url.pathname;

  // Versioned API alias: /api/v1/foo is treated identically to /api/foo. Every
  // route above is defined once against /api/... — this lets new integrations
  // use the versioned form without duplicating a single route.
  if (pathname.startsWith('/api/v1/')) pathname = '/api/' + pathname.slice('/api/v1/'.length);

  try {
    const handled = await dispatch(allRoutes, req, res, pathname, url);
    if (handled) return;

    if (req.method === 'GET') return serveStatic(req, res, pathname, PUBLIC_DIR);

    sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[unhandled]', err);
    if (!res.headersSent) sendJSON(res, 500, { error: 'Server error' });
  }
});

scheduleDailyBackups();

// Start any analyzer bridges (Swelab TCP/HL7, Microlab serial, i-Chroma
// folder-watch) whose Admin config has them enabled. Off by default — a
// hospital that hasn't wired anything up yet sees no bridges running and no
// connection-refused noise. Failures here are logged, never fatal to the
// rest of the app: a lab tech can always fall back to typing results in by
// hand exactly as before this phase existed.
require('./analyzers').startEnabledAnalyzers().catch(err => {
  console.error('[analyzers] failed to start configured analyzers:', err.message);
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  console.log(`\nAl Noor Clinic System running.`);
  console.log(`On this PC:  http://localhost:${PORT}`);
  Object.values(nets).flat().forEach(net => {
    if (net.family === 'IPv4' && !net.internal) {
      console.log(`On the network (use this on other PCs):  http://${net.address}:${PORT}`);
    }
  });
  console.log('');
});

// ---------- graceful shutdown ----------
// SQLite in WAL mode can leave the database in a slightly inconsistent state
// (from the OS's point of view — the DB itself stays logically correct) if the
// process is killed without closing the handle. This ensures a normal restart
// (PM2 reload, Ctrl+C, a Windows/Linux service stop) always closes cleanly.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] received ${signal}, closing gracefully...`);
  server.close(() => {
    closeDatabase();
    console.log('[shutdown] complete.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[shutdown] forced after timeout.');
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------- last-resort safety net ----------
// Every route handler is already wrapped in asyncHandler (middleware.js), which
// catches errors inside a request and returns a clean sanitized JSON response —
// so in normal operation nothing should ever reach these. They exist purely as
// a backstop against a bug outside that path (a listener added directly to the
// server, a timer callback, a future change that forgets asyncHandler) so a
// single unexpected error logs clearly and the process exits for PM2 to restart
// cleanly, instead of the DB handle being abandoned mid-write or the process
// hanging in a half-broken state indefinitely.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled promise rejection:', reason);
  shutdown('unhandledRejection');
});
