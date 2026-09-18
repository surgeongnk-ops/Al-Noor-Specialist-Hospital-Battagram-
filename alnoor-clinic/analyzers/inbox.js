// analyzers/inbox.js — shared staging-area writer used by every analyzer
// bridge (swelabBridge, microlabBridge, ichromaBridge).
//
// Safety model (this is the whole point of this file existing): NOTHING an
// analyzer sends is ever written into lab_orders.results directly. Every
// incoming message becomes one analyzer_result_inbox row, auto-matched to a
// paid order by specimen ID when possible, and stays there until a lab
// technician deliberately imports it into the ordinary result-entry screen
// (routes/analyzers.routes.js's /import endpoint, wired into lab.html) where
// it is reviewed, possibly corrected, and saved through the exact same path
// as a manually-typed result — including the pathologist verification gate
// that already exists. A misparsed analyzer message can at worst clutter
// the inbox with a bad row; it can never silently become a patient's report.

'use strict';

const { db } = require('../db');

// Normalizes a raw specimen/sample ID guess for matching: the analyzer might
// echo it back with different case or stray whitespace depending on how the
// operator typed it into the analyzer's own keypad.
function normalizeSpecimenId(raw) {
  return String(raw || '').trim().toUpperCase();
}

// Finds a lab order this specimen ID could belong to. Only orders that have
// actually reached specimen collection are eligible — an analyzer cannot
// meaningfully report a result for an order still sitting at PENDING_PAYMENT
// or PAID (no tube has been run yet), so matching against those would only
// ever be a false positive (e.g. a coincidentally similar ID).
function findOrderBySpecimenId(specimenId) {
  if (!specimenId) return null;
  const norm = normalizeSpecimenId(specimenId);
  return db.prepare(`
    SELECT * FROM lab_orders
    WHERE UPPER(specimen_id) = ?
      AND status IN ('SAMPLE_COLLECTED', 'IN_PROCESS', 'RESULT_ENTERED')
    ORDER BY id DESC LIMIT 1
  `).get(norm) || null;
}

// Records one incoming analyzer message. `parsed` is analyzer-native
// (source_code/source_name/value/unit/ref_range/abnormal_flag per result —
// see hl7.js's extractResults for the canonical shape) — code-to-catalog
// mapping happens later, at import time, via analyzer_test_map, since that
// mapping is exactly the part that needs real-hardware calibration.
function recordInboxEntry({ analyzerKey, rawPayload, parsed, specimenIdGuess }) {
  const order = findOrderBySpecimenId(specimenIdGuess);
  const matchStatus = order ? 'matched' : 'unmatched';
  const info = db.prepare(`
    INSERT INTO analyzer_result_inbox
      (analyzer_key, raw_payload, parsed_json, specimen_id_guess, match_status, matched_order_id, matched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    analyzerKey,
    rawPayload,
    JSON.stringify(parsed || {}),
    specimenIdGuess || null,
    matchStatus,
    order ? order.id : null,
    order ? new Date().toISOString() : null
  );
  return { id: info.lastInsertRowid, matchStatus, order };
}

module.exports = { recordInboxEntry, findOrderBySpecimenId, normalizeSpecimenId };
