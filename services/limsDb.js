'use strict';

/**
 * Shared SQLite connection helper for the LIMS integration layer.
 *
 * Both services/limsService.js (on-demand reads/writes) and
 * services/limsWatcher.js (live sync) open their own connection through
 * this module rather than sharing one handle, since better-sqlite3
 * connections are cheap and each caller has a different lifecycle
 * (request-scoped vs. long-lived). Both connections point at the same
 * WAL-mode database file that the Python LIMS daemon writes to, so reads
 * here never block the daemon's inserts.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'al_noor_clinical.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'lims_daemon', 'schema.sql');

const LEGACY_COLUMN_MIGRATIONS = {
  acknowledged: 'ALTER TABLE lab_results ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0',
  acknowledged_by: 'ALTER TABLE lab_results ADD COLUMN acknowledged_by TEXT',
  acknowledged_at: 'ALTER TABLE lab_results ADD COLUMN acknowledged_at TEXT',
};

/**
 * Open a connection to the shared LIMS SQLite database, ensuring the
 * schema (and any columns added after a database file was first created)
 * exist. Safe to call from a fresh database, one the Python daemon
 * already created, or one already migrated -- every statement here is
 * idempotent.
 *
 * @param {string} [dbPath] Defaults to LIMS_DB_PATH env var, then al_noor_clinical.db.
 * @returns {import('better-sqlite3').Database}
 */
function openLimsDb(dbPath) {
  const resolvedPath = dbPath || process.env.LIMS_DB_PATH || DEFAULT_DB_PATH;
  const db = new Database(resolvedPath, { fileMustExist: false });

  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  migrateLegacyColumns(db);

  return db;
}

function migrateLegacyColumns(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(lab_results)').all().map((row) => row.name));
  for (const [column, statement] of Object.entries(LEGACY_COLUMN_MIGRATIONS)) {
    if (!existing.has(column)) {
      db.exec(statement);
    }
  }
}

module.exports = { openLimsDb, DEFAULT_DB_PATH };
