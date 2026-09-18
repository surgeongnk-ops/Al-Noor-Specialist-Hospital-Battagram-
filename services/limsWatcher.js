'use strict';

/**
 * Live sync between the Python LIMS daemon and the Node.js clinical app.
 *
 * The daemon writes lab_results in a separate OS process. Rather than lock
 * step polling the table on a tight interval, LimsWatcher primarily reacts
 * to writes on the database's WAL file (every commit touches it), verified
 * with `chokidar`, and falls back to a slower interval poll so a missed or
 * unsupported filesystem event (common on network filesystems/containers)
 * never leaves the app silently stale.
 *
 * Emits:
 *   'started' { dbPath, lastSeenId }
 *   'result'  <lab_results row>            -- every new row, any flag
 *   'panic'   <lab_results row>             -- new row where is_panic = 1
 *   'batch'   <lab_results row[]>           -- one event per detection pass
 *   'error'   <Error>
 */

const { EventEmitter } = require('events');
const chokidar = require('chokidar');

const { openLimsDb, DEFAULT_DB_PATH } = require('./limsDb');

const DEFAULT_POLL_INTERVAL_MS = Number(process.env.LIMS_POLL_INTERVAL_MS) || 2000;

class LimsWatcher extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.dbPath] Defaults to LIMS_DB_PATH env var, then al_noor_clinical.db.
   * @param {number} [options.pollIntervalMs] Fallback poll cadence in ms.
   */
  constructor({ dbPath, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
    super();
    this.dbPath = dbPath || process.env.LIMS_DB_PATH || DEFAULT_DB_PATH;
    this.pollIntervalMs = pollIntervalMs;
    this.db = null;
    this.fsWatcher = null;
    this.pollTimer = null;
    this.lastSeenId = 0;
    this._checking = false;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;

    this.db = openLimsDb(this.dbPath);
    this.lastSeenId = this._getMaxId();

    const walPath = `${this.dbPath}-wal`;
    this.fsWatcher = chokidar.watch(walPath, { ignoreInitial: true, awaitWriteFinish: false });
    this.fsWatcher.on('add', () => this._checkForNewResults());
    this.fsWatcher.on('change', () => this._checkForNewResults());
    this.fsWatcher.on('error', (err) => this.emit('error', err));

    // Guaranteed fallback in case the WAL file's fs events are missed or
    // unsupported (e.g. some containerized/networked filesystems).
    this.pollTimer = setInterval(() => this._checkForNewResults(), this.pollIntervalMs);
    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }

    this.emit('started', { dbPath: this.dbPath, lastSeenId: this.lastSeenId });
  }

  stop() {
    this._running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  _getMaxId() {
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM lab_results').get();
    return row.maxId;
  }

  _checkForNewResults() {
    if (this._checking || !this.db) return;
    this._checking = true;
    try {
      const rows = this.db
        .prepare('SELECT * FROM lab_results WHERE id > ? ORDER BY id ASC')
        .all(this.lastSeenId);

      if (rows.length === 0) return;

      this.lastSeenId = rows[rows.length - 1].id;
      for (const row of rows) {
        this.emit('result', row);
        if (row.is_panic) {
          this.emit('panic', row);
        }
      }
      this.emit('batch', rows);
    } catch (err) {
      this.emit('error', err);
    } finally {
      this._checking = false;
    }
  }
}

module.exports = { LimsWatcher };
