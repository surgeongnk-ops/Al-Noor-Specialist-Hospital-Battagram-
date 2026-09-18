#!/usr/bin/env node
'use strict';

/**
 * End-to-end integration check for the Python LIMS daemon <-> Node.js
 * clinical app bridge. Does NOT require the Python process or a real
 * serial port: it simulates what lims_daemon/db.py does after a
 * successful parse (insert into serial_logs, then lab_results) on a
 * scratch database, then drives the real Node.js services against it.
 *
 * Verifies:
 *   1. A mock insert mimicking Python's parser output lands correctly.
 *   2. LimsWatcher detects the new row and emits a 'panic' event for it.
 *   3. limsService reads (recent results, unread panic worklist) see it.
 *   4. The alert payload built for the front end has the right shape.
 *   5. Acknowledging the result removes it from the unread panic worklist.
 *
 * Run with:  node scripts/test_integration.js
 * Exit code: 0 on success, 1 on failure.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openLimsDb } = require('../services/limsDb');
const { LimsWatcher } = require('../services/limsWatcher');
const { buildPanicAlert } = require('../services/alertBuilder');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lims-integration-'));
  const dbPath = path.join(tmpDir, 'al_noor_clinical.test.db');
  console.log(`[test] scratch database: ${dbPath}`);

  // limsService reads its db path lazily from this env var on first call.
  process.env.LIMS_DB_PATH = dbPath;
  const limsService = require('../services/limsService');

  // --- Step 1: start the watcher on an empty database ----------------
  const watcher = new LimsWatcher({ dbPath, pollIntervalMs: 250 });
  const panicEvent = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for LimsWatcher to emit "panic"')),
      5000,
    );
    watcher.once('panic', (row) => {
      clearTimeout(timeout);
      resolve(row);
    });
    watcher.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  watcher.start();
  console.log('[test] LimsWatcher started, baseline established on empty table');
  await sleep(100);

  // --- Step 2: simulate the Python daemon's post-parse writes ---------
  // Mirrors lims_daemon/db.py: serial_logs insert first, then lab_results,
  // exactly as db.Database.insert_serial_log / insert_lab_result would do
  // for a parsed ASTM "R|1|^^^^Potassium|7.5|mmol/L|3.5-5.1|H||F||" record.
  const writerDb = openLimsDb(dbPath);
  const logInfo = writerDb
    .prepare(
      `INSERT INTO serial_logs (port, baud_rate, protocol_guess, raw_payload, processed, parse_source)
       VALUES (?, ?, ?, ?, 1, 'deterministic')`,
    )
    .run('/dev/ttyUSB0', 9600, 'ASTM', Buffer.from('R|1|^^^^Potassium|7.5|mmol/L|3.5-5.1|H||F||\r'));

  const resultInfo = writerDb
    .prepare(
      `INSERT INTO lab_results (
         serial_log_id, patient_id, sample_id, test_name, value, unit,
         reference_range, flag, is_panic, parse_source, instrument
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'deterministic', 'ASTM')`,
    )
    .run(logInfo.lastInsertRowid, 'PID-99001', 'SID-77001', 'Potassium', '7.5', 'mmol/L', '3.5-5.1', 'PANIC_HIGH');

  const insertedId = resultInfo.lastInsertRowid;
  writerDb.close();
  console.log(`[test] simulated Python daemon insert: lab_results.id=${insertedId}`);

  // --- Step 3: the watcher must detect it, without polling the caller -
  const detected = await panicEvent;
  assert.strictEqual(detected.id, insertedId, 'watcher should report the row that was just inserted');
  assert.strictEqual(detected.is_panic, 1, 'detected row must be panic-flagged');
  assert.strictEqual(detected.test_name, 'Potassium');
  console.log('[test] PASS: LimsWatcher emitted "panic" for the new record');
  watcher.stop();

  // --- Step 4: limsService reads must see the same row -----------------
  const recent = limsService.getRecentLabResults('PID-99001', 5);
  assert.strictEqual(recent.length, 1, 'getRecentLabResults should find exactly one result for the mock patient');
  assert.strictEqual(recent[0].id, insertedId);
  console.log('[test] PASS: getRecentLabResults returns the new result');

  const unreadBefore = limsService.getUnreadPanicResults();
  assert.ok(
    unreadBefore.some((row) => row.id === insertedId),
    'getUnreadPanicResults should list the unacknowledged panic result',
  );
  console.log('[test] PASS: getUnreadPanicResults lists the unacknowledged panic result');

  // --- Step 5: the alert payload sent to the front end must be well-formed
  const alert = buildPanicAlert(detected);
  assert.strictEqual(alert.type, 'lab_panic_result');
  assert.strictEqual(alert.severity, 'critical');
  assert.strictEqual(alert.patientId, 'PID-99001');
  assert.strictEqual(alert.resultId, insertedId);
  assert.ok(alert.message.includes('Potassium'), 'alert message should name the test');
  console.log('[test] PASS: alert payload has the expected shape ->', JSON.stringify(alert));

  // --- Step 6: acknowledging removes it from the unread worklist -------
  const acknowledged = limsService.acknowledgePanicResult(insertedId, 'dr.ahmed');
  assert.strictEqual(acknowledged.acknowledged, 1);
  assert.strictEqual(acknowledged.acknowledged_by, 'dr.ahmed');
  assert.ok(acknowledged.acknowledged_at, 'acknowledged_at should be stamped');

  const unreadAfter = limsService.getUnreadPanicResults();
  assert.ok(
    !unreadAfter.some((row) => row.id === insertedId),
    'acknowledged result must no longer appear in the unread panic worklist',
  );
  console.log('[test] PASS: acknowledgePanicResult clears the row from the unread worklist');

  limsService.closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('\nAll integration checks passed.');
}

main().catch((err) => {
  console.error('\nIntegration test FAILED');
  console.error(err);
  process.exitCode = 1;
});
