'use strict';

/**
 * Read/write access to lab_results for the clinical app: recent results
 * for a patient chart, the unacknowledged panic-value worklist, and
 * doctor acknowledgment of a panic result.
 */

const { openLimsDb } = require('./limsDb');

let db = null;

function getDb() {
  if (!db) {
    db = openLimsDb();
  }
  return db;
}

/** Close the underlying connection. Mainly useful for tests and graceful shutdown. */
function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Fetch a patient's most recent lab results (any flag), newest first.
 *
 * @param {string} patientId
 * @param {number} [limit=10]
 * @returns {object[]}
 */
function getRecentLabResults(patientId, limit = 10) {
  if (!patientId) {
    throw new Error('getRecentLabResults requires a patientId');
  }
  return getDb()
    .prepare(
      `SELECT lr.*, sl.port AS source_port, sl.received_at AS log_received_at
       FROM lab_results lr
       JOIN serial_logs sl ON sl.id = lr.serial_log_id
       WHERE lr.patient_id = ?
       ORDER BY lr.resulted_at DESC, lr.id DESC
       LIMIT ?`,
    )
    .all(patientId, limit);
}

/**
 * All panic-flagged (is_panic = 1) results a doctor has not yet
 * acknowledged, oldest first so the most overdue alert surfaces first.
 *
 * @returns {object[]}
 */
function getUnreadPanicResults() {
  return getDb()
    .prepare(
      `SELECT * FROM lab_results
       WHERE is_panic = 1 AND acknowledged = 0
       ORDER BY resulted_at ASC, id ASC`,
    )
    .all();
}

/**
 * Record that a doctor has acknowledged a panic-flagged result.
 *
 * @param {number} resultId
 * @param {string} userId Identifier of the acknowledging clinician.
 * @returns {object} The updated lab_results row.
 */
function acknowledgePanicResult(resultId, userId) {
  if (!userId) {
    throw new Error('acknowledgePanicResult requires a userId');
  }
  const database = getDb();
  const info = database
    .prepare(
      `UPDATE lab_results
       SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND is_panic = 1`,
    )
    .run(userId, resultId);

  if (info.changes === 0) {
    throw new Error(`No unacknowledged panic-flagged lab_results row with id=${resultId} was found`);
  }

  return database.prepare('SELECT * FROM lab_results WHERE id = ?').get(resultId);
}

module.exports = {
  getRecentLabResults,
  getUnreadPanicResults,
  acknowledgePanicResult,
  closeDb,
};
