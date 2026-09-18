// analyzers/index.js — starts/stops the three analyzer bridges based on
// analyzer_config, and keeps a small in-memory log ring buffer + running
// status per analyzer for the Admin -> Analyzer Settings screen to show
// ("is it actually connected right now" matters a lot on a hospital floor
// where nobody wants to guess).

'use strict';

const { db } = require('../db');
const swelabBridge = require('./swelabBridge');
const microlabBridge = require('./microlabBridge');
const ichromaBridge = require('./ichromaBridge');

const BRIDGES = {
  swelab_alfa: swelabBridge,
  microlab_300: microlabBridge,
  ichroma_ii: ichromaBridge
};

const MAX_LOG_LINES = 200;
const running = new Map(); // analyzer_key -> { handle, logs: [] }

function log(key, message) {
  const entry = { at: new Date().toISOString(), message };
  let state = running.get(key);
  if (!state) { state = { handle: null, logs: [] }; running.set(key, state); }
  state.logs.push(entry);
  if (state.logs.length > MAX_LOG_LINES) state.logs.shift();
  console.log(`[analyzer:${key}]`, message);
}

async function stopAnalyzer(key) {
  const state = running.get(key);
  if (state && state.handle) {
    try { await state.handle.stop(); } catch (err) { log(key, `error stopping: ${err.message}`); }
    state.handle = null;
  }
}

async function startAnalyzer(key, config) {
  const bridge = BRIDGES[key];
  if (!bridge) { log(key, `unknown analyzer key — nothing to start`); return; }
  await stopAnalyzer(key); // idempotent: restarting with new config always stops the old handle first
  try {
    const handle = bridge.start(config, (msg) => log(key, msg));
    let state = running.get(key);
    if (!state) { state = { handle: null, logs: [] }; running.set(key, state); }
    state.handle = handle;
  } catch (err) {
    log(key, `failed to start: ${err.message}`);
  }
}

// Called once at server boot: starts every analyzer whose config row has
// enabled=1. Analyzers are OFF by default (see migration v15's seed) so a
// hospital that hasn't wired anything up yet sees no bridges running and no
// confusing connection-refused noise in the log.
async function startEnabledAnalyzers() {
  const rows = db.prepare('SELECT * FROM analyzer_config').all();
  for (const row of rows) {
    if (!row.enabled) continue;
    let config = {};
    try { config = JSON.parse(row.config_json || '{}'); } catch { /* fall back to empty config */ }
    await startAnalyzer(row.analyzer_key, config);
  }
}

function getStatus(key) {
  const state = running.get(key);
  const liveStatus = state && state.handle ? state.handle.status() : { listening: false };
  // "running" mirrors listening rather than just handle-existence: a
  // not-yet-configured folder watcher or a serial bridge that can't run on
  // this OS still returns a handle (so stop() is always safe to call), but
  // it isn't actually doing anything, and the Admin screen should say so.
  return { ...liveStatus, running: liveStatus.listening === true };
}

function getLogs(key) {
  const state = running.get(key);
  return state ? state.logs : [];
}

module.exports = { startAnalyzer, stopAnalyzer, startEnabledAnalyzers, getStatus, getLogs, BRIDGES };
