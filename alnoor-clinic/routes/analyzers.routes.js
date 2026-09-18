// routes/analyzers.routes.js — Admin configuration for the three lab
// analyzer bridges, plus the Analyzer Inbox (review/match/import/discard)
// that lab staff use to bring an incoming analyzer message into a specific
// order's result-entry screen.
//
// Nothing here writes to lab_orders.results directly — see analyzers/inbox.js
// for the full rationale. The /import endpoint below hands back a pre-fill
// payload the frontend applies to the SAME result-entry form a technician
// would otherwise type into by hand; saving still goes through the existing
// POST /api/lab/orders/:id/results endpoint (lab.routes.js), untouched.
const { createRouter } = require('../router');
const { db, logAudit } = require('../db');
const { sendJSON, sendError, readBody, requireAuth, asyncHandler } = require('../middleware');
const analyzers = require('../analyzers');
const { findOrderBySpecimenId } = require('../analyzers/inbox');
const claudeFallback = require('../analyzers/claudeFallback');

function parseAiSuggested(row) {
  if (!row.ai_suggested_json) return null;
  try { return JSON.parse(row.ai_suggested_json); } catch { return null; }
}

const router = createRouter();

// Small helper for the Analyzer Inbox's manual "Match to Order" action: a
// technician types the specimen ID printed on the tube/label (the one
// reliable thing they always have in hand) rather than needing to know an
// internal numeric order ID.
router.get('/api/analyzers/resolve-specimen', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['admin', 'lab', 'pathologist']); if (!staff) return;
  const specimenId = url.searchParams.get('specimen_id') || '';
  const order = findOrderBySpecimenId(specimenId);
  if (!order) return sendError(res, 404, 'No matching in-progress order found for that specimen ID');
  const patient = db.prepare('SELECT name, mr_number FROM patients WHERE id = ?').get(order.patient_id);
  return sendJSON(res, 200, { order_id: order.id, status: order.status, patient_name: patient?.name, mr_number: patient?.mr_number });
}));

function parseConfigRow(row) {
  let config = {};
  try { config = JSON.parse(row.config_json || '{}'); } catch { /* leave as {} */ }
  return { ...row, config_json: undefined, config, ...analyzers.getStatus(row.analyzer_key) };
}

// ---- Admin: list/configure analyzers ----
router.get('/api/analyzers/config', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const rows = db.prepare('SELECT * FROM analyzer_config ORDER BY display_name').all();
  return sendJSON(res, 200, rows.map(parseConfigRow));
}));

router.get(/^\/api\/analyzers\/config\/([a-z0-9_]+)\/logs$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  return sendJSON(res, 200, analyzers.getLogs(match[1]));
}));

router.put(/^\/api\/analyzers\/config\/([a-z0-9_]+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const key = match[1];
  const row = db.prepare('SELECT * FROM analyzer_config WHERE analyzer_key = ?').get(key);
  if (!row) return sendError(res, 404, 'Unknown analyzer');
  const body = await readBody(req);
  const enabled = body.enabled != null ? (body.enabled ? 1 : 0) : row.enabled;
  const config = body.config != null ? JSON.stringify(body.config) : row.config_json;
  db.prepare(`UPDATE analyzer_config SET enabled = ?, config_json = ?, updated_at = datetime('now') WHERE analyzer_key = ?`)
    .run(enabled, config, key);
  logAudit(staff.staff_id, 'analyzer_config_update', null, `${key}: enabled=${enabled}`);

  // Apply immediately: restart with the new settings if enabled, stop if
  // disabled — a hospital IT person changing a COM port shouldn't have to
  // restart the whole server for it to take effect.
  if (enabled) {
    await analyzers.startAnalyzer(key, JSON.parse(config));
  } else {
    await analyzers.stopAnalyzer(key);
  }
  const updated = db.prepare('SELECT * FROM analyzer_config WHERE analyzer_key = ?').get(key);
  return sendJSON(res, 200, parseConfigRow(updated));
}));

// ---- Test-code mapping (admin) ----
router.get(/^\/api\/analyzers\/([a-z0-9_]+)\/test-map$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin', 'lab', 'pathologist']); if (!staff) return;
  const rows = db.prepare('SELECT * FROM analyzer_test_map WHERE analyzer_key = ? ORDER BY source_code').all(match[1]);
  return sendJSON(res, 200, rows);
}));

router.post(/^\/api\/analyzers\/([a-z0-9_]+)\/test-map$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin', 'lab', 'pathologist']); if (!staff) return;
  const analyzerKey = match[1];
  const { source_code, target_test_name, target_component_name, unit_override } = await readBody(req);
  if (!source_code || !target_test_name) return sendError(res, 400, 'source_code and target_test_name are required');
  db.prepare(`
    INSERT INTO analyzer_test_map (analyzer_key, source_code, target_test_name, target_component_name, unit_override)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(analyzer_key, source_code) DO UPDATE SET
      target_test_name = excluded.target_test_name,
      target_component_name = excluded.target_component_name,
      unit_override = excluded.unit_override
  `).run(analyzerKey, source_code.trim(), target_test_name, target_component_name || null, unit_override || null);
  logAudit(staff.staff_id, 'analyzer_test_map_set', null, `${analyzerKey}: ${source_code} -> ${target_test_name}${target_component_name ? '/' + target_component_name : ''}`);
  return sendJSON(res, 200, { ok: true });
}));

router.del(/^\/api\/analyzers\/test-map\/(\d+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  db.prepare('DELETE FROM analyzer_test_map WHERE id = ?').run(Number(match[1]));
  return sendJSON(res, 200, { ok: true });
}));

// ---- Inbox: list / raw view / match / import / discard ----
router.get('/api/analyzers/inbox', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['admin', 'lab', 'pathologist']); if (!staff) return;
  const status = url.searchParams.get('status');
  const rows = status
    ? db.prepare('SELECT * FROM analyzer_result_inbox WHERE match_status = ? ORDER BY received_at DESC LIMIT 200').all(status)
    : db.prepare('SELECT * FROM analyzer_result_inbox ORDER BY received_at DESC LIMIT 200').all();
  const withOrders = rows.map(r => {
    let order = null;
    if (r.matched_order_id) {
      order = db.prepare(`
        SELECT lo.id, lo.receipt_no, lo.specimen_id, lo.status, pt.name AS patient_name, pt.mr_number
        FROM lab_orders lo JOIN patients pt ON pt.id = lo.patient_id WHERE lo.id = ?
      `).get(r.matched_order_id);
    }
    let parsed = {};
    try { parsed = JSON.parse(r.parsed_json || '{}'); } catch { /* leave empty */ }
    return { ...r, parsed_json: undefined, ai_suggested_json: undefined, parsed, ai_suggested: parseAiSuggested(r), order };
  });
  return sendJSON(res, 200, withOrders);
}));

router.get(/^\/api\/analyzers\/inbox\/(\d+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin', 'lab', 'pathologist']); if (!staff) return;
  const row = db.prepare('SELECT * FROM analyzer_result_inbox WHERE id = ?').get(Number(match[1]));
  if (!row) return sendError(res, 404, 'Inbox entry not found');
  let parsed = {};
  try { parsed = JSON.parse(row.parsed_json || '{}'); } catch { /* leave empty */ }
  return sendJSON(res, 200, { ...row, parsed_json: undefined, ai_suggested_json: undefined, parsed, ai_suggested: parseAiSuggested(row) });
}));

// On-demand AI-assisted re-parse: a lab technician looking at a
// low-confidence Analyzer Inbox entry (see serialBridge.js's "best-effort
// tokenizer" — undocumented Swelab/Microlab serial output is genuinely
// ambiguous) can ask Claude to take another pass at raw_payload. This is
// the ONLY place anything in this app calls out to the internet, and only
// when a human deliberately clicks the button — never automatically on
// capture (this hospital runs offline day-to-day; see db.js's header
// comment). Exactly like every other path into this inbox, the result is
// stored alongside the row for review and never touches lab_orders.results.
router.post(/^\/api\/analyzers\/inbox\/(\d+)\/ai-suggest$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin', 'lab', 'pathologist']); if (!staff) return;
  const row = db.prepare('SELECT * FROM analyzer_result_inbox WHERE id = ?').get(Number(match[1]));
  if (!row) return sendError(res, 404, 'Inbox entry not found');
  if (!claudeFallback.isConfigured()) {
    return sendError(res, 400, 'ANTHROPIC_API_KEY is not configured on this server — ask an admin to set it before using AI-assisted parsing');
  }

  let suggestion;
  try {
    suggestion = await claudeFallback.suggestResults(row.raw_payload);
  } catch (err) {
    return sendError(res, 502, `Claude could not parse this message: ${err.message}`);
  }

  db.prepare('UPDATE analyzer_result_inbox SET ai_suggested_json = ? WHERE id = ?').run(JSON.stringify(suggestion), row.id);
  logAudit(staff.staff_id, 'analyzer_ai_suggest', null, `inbox #${row.id}: ${suggestion.results.length} result(s) suggested`);

  return sendJSON(res, 200, { ok: true, suggestion });
}));

// Manually associate an unmatched entry with an order — needed whenever the
// operator forgot to type the specimen ID into the analyzer, or a format
// quirk kept auto-matching from finding it.
router.post(/^\/api\/analyzers\/inbox\/(\d+)\/match$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin', 'lab', 'pathologist']); if (!staff) return;
  const row = db.prepare('SELECT * FROM analyzer_result_inbox WHERE id = ?').get(Number(match[1]));
  if (!row) return sendError(res, 404, 'Inbox entry not found');
  const { order_id } = await readBody(req);
  const order = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(Number(order_id));
  if (!order) return sendError(res, 404, 'Order not found');
  db.prepare(`UPDATE analyzer_result_inbox SET match_status = 'matched', matched_order_id = ?, matched_by = ?, matched_at = datetime('now') WHERE id = ?`)
    .run(order.id, staff.staff_id, row.id);
  return sendJSON(res, 200, { ok: true });
}));

router.post(/^\/api\/analyzers\/inbox\/(\d+)\/discard$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin', 'lab', 'pathologist']); if (!staff) return;
  const { notes } = await readBody(req).catch(() => ({}));
  db.prepare(`UPDATE analyzer_result_inbox SET match_status = 'discarded', notes = ? WHERE id = ?`).run(notes || null, Number(match[1]));
  return sendJSON(res, 200, { ok: true });
}));

// Returns a pre-fill payload for the result-entry form: each analyzer-native
// result is run through analyzer_test_map to resolve it to this system's own
// test/component name (falling back to the raw analyzer name, clearly
// marked unmapped, when no mapping exists yet) — the frontend fills in
// whatever it can match against the open order's actual test list and
// leaves the rest for the technician to enter normally. This does NOT save
// anything; it only marks the inbox row 'imported' so it doesn't get
// re-imported by accident, and the technician still has to click "Save
// Results" in the normal form for anything to actually be recorded.
router.post(/^\/api\/analyzers\/inbox\/(\d+)\/import$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin', 'lab', 'pathologist']); if (!staff) return;
  const row = db.prepare('SELECT * FROM analyzer_result_inbox WHERE id = ?').get(Number(match[1]));
  if (!row) return sendError(res, 404, 'Inbox entry not found');
  if (!row.matched_order_id) return sendError(res, 400, 'This entry has no matched order yet — match it first');
  const order = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(row.matched_order_id);
  if (!order) return sendError(res, 404, 'Matched order no longer exists');

  let parsed = {};
  try { parsed = JSON.parse(row.parsed_json || '{}'); } catch { /* leave empty */ }
  const aiSuggested = parseAiSuggested(row);
  // A Claude suggestion supersedes the naive tokenizer's raw guess for this
  // import: a technician only generates one because the raw guess was too
  // poor to trust. Both stay visible in GET /api/analyzers/inbox regardless
  // (parsed vs. ai_suggested), so nothing here is silently hidden.
  const sourceResults = (aiSuggested && aiSuggested.results && aiSuggested.results.length) ? aiSuggested.results : (parsed.results || []);

  const testMapRows = db.prepare('SELECT * FROM analyzer_test_map WHERE analyzer_key = ?').all(row.analyzer_key);
  const mapByCode = new Map(testMapRows.map(m => [m.source_code.trim().toLowerCase(), m]));

  const prefill = sourceResults.map(r => {
    const mapping = mapByCode.get(String(r.source_code || '').trim().toLowerCase());
    return {
      source_code: r.source_code,
      source_name: r.source_name,
      value: r.value,
      unit: mapping?.unit_override || r.unit,
      mapped_test: mapping ? mapping.target_test_name : null,
      mapped_component: mapping ? mapping.target_component_name : null,
      mapped: !!mapping
    };
  });

  db.prepare(`UPDATE analyzer_result_inbox SET match_status = 'imported', imported_by = ?, imported_at = datetime('now') WHERE id = ?`)
    .run(staff.staff_id, row.id);
  logAudit(staff.staff_id, 'analyzer_result_import', null, `inbox #${row.id} -> order #${order.id}`);

  return sendJSON(res, 200, { ok: true, order_id: order.id, prefill });
}));

module.exports = router;
