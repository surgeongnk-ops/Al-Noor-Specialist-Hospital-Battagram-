'use strict';

/**
 * Al Noor Specialist Hospital clinical app entry point.
 *
 * The repository had no existing Node.js backend, so this is the minimal
 * Express + Socket.io server the `clinical-app` PM2 process actually runs:
 * it exposes the LIMS REST endpoints and pushes live panic-result alerts
 * to connected front-end workstations over WebSockets. A fuller
 * application should mount its own routes here alongside these.
 */

const http = require('http');
const express = require('express');
const { Server: SocketIOServer } = require('socket.io');

const limsService = require('./services/limsService');
const { LimsWatcher } = require('./services/limsWatcher');
const { buildPanicAlert } = require('./services/alertBuilder');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });

// --- REST API ---------------------------------------------------------

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/lims/patients/:patientId/results', (req, res) => {
  const limit = Number(req.query.limit) || 10;
  try {
    res.json(limsService.getRecentLabResults(req.params.patientId, limit));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/lims/panic-results', (_req, res) => {
  try {
    res.json(limsService.getUnreadPanicResults());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lims/panic-results/:resultId/acknowledge', (req, res) => {
  const { userId } = req.body || {};
  if (!userId) {
    return res.status(400).json({ error: 'userId is required to acknowledge a panic result' });
  }
  try {
    const updated = limsService.acknowledgePanicResult(Number(req.params.resultId), userId);
    io.emit('lims:panic-acknowledged', { resultId: updated.id, acknowledgedBy: userId });
    return res.json(updated);
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
});

// --- Live sync: LIMS watcher -> Socket.io ------------------------------

const watcher = new LimsWatcher();

watcher.on('started', ({ dbPath, lastSeenId }) => {
  console.log(`[limsWatcher] watching ${dbPath} (baseline lab_results id=${lastSeenId})`);
});

watcher.on('result', (row) => {
  io.emit('lims:new-result', row);
});

watcher.on('panic', (row) => {
  io.emit('lims:panic-result', buildPanicAlert(row));
});

watcher.on('error', (err) => {
  console.error('[limsWatcher] error:', err);
});

watcher.start();

io.on('connection', (socket) => {
  console.log(`[socket.io] workstation connected: ${socket.id}`);
});

httpServer.listen(PORT, () => {
  console.log(`Al Noor clinical app listening on port ${PORT}`);
});

function shutdown() {
  console.log('Shutting down clinical-app...');
  watcher.stop();
  limsService.closeDb();
  httpServer.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, httpServer, io };
