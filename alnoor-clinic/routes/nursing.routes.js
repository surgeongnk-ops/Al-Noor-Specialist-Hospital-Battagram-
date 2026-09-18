// routes/nursing.routes.js — inpatient admissions, doctor orders, nurse execution log, discharge
const { createRouter } = require('../router');
const { db, logAudit, withTransaction } = require('../db');
const { sendJSON, sendError, readBody, requireAuth, validateBody, asyncHandler, receiptNo } = require('../middleware');

const router = createRouter();

// Physiologically plausible bounds — wide enough to admit a genuinely critical
// patient's readings (this is a hospital, not a fitness tracker) but tight
// enough to catch obvious data-entry mistakes (a misplaced decimal, a stray
// extra digit, a field typed into the wrong box). A value outside these bounds
// is rejected with a clear message naming the field, rather than silently
// stored and possibly acted on clinically.
const VITALS_SCHEMA = {
  temperature_c: { type: 'number', min: 25, max: 45 },
  pulse_bpm: { type: 'number', min: 0, max: 300 },
  resp_rate: { type: 'number', min: 0, max: 100 },
  bp_systolic: { type: 'number', min: 0, max: 300 },
  bp_diastolic: { type: 'number', min: 0, max: 250 },
  spo2: { type: 'number', min: 0, max: 100 }
};

router.get('/api/admissions', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['doctor', 'nurse', 'admin']); if (!staff) return;
  const status = url.searchParams.get('status') || 'active';
  const rows = db.prepare(`
    SELECT a.*, pt.mr_number, pt.name AS patient_name, pt.age, pt.gender
    FROM admissions a JOIN patients pt ON pt.id = a.patient_id
    WHERE a.status = ? ORDER BY a.created_at DESC
  `).all(status);
  for (const a of rows) {
    a.orders = db.prepare('SELECT * FROM doctor_orders WHERE admission_id = ? ORDER BY created_at DESC').all(a.id);
    for (const o of a.orders) {
      o.administrations = db.prepare('SELECT * FROM medication_administrations WHERE order_id = ? ORDER BY administered_at DESC').all(o.id);
    }
    a.discharge_summary = db.prepare('SELECT * FROM discharge_summaries WHERE admission_id = ?').get(a.id) || null;
    a.vitals = db.prepare('SELECT * FROM vitals WHERE admission_id = ? ORDER BY recorded_at DESC LIMIT 20').all(a.id);
  }
  return sendJSON(res, 200, rows);
}));

// ---- Nursing vitals: record and retrieve vital signs for an inpatient ----
router.post(/^\/api\/admissions\/(\d+)\/vitals$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['nurse', 'admin']); if (!staff) return;
  const admissionId = Number(match[1]);
  const admission = db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId);
  if (!admission) return sendError(res, 404, 'Admission not found');
  if (admission.status !== 'active') return sendError(res, 400, 'Cannot record vitals for a discharged admission');

  const body = await readBody(req);
  const err = validateBody(body, VITALS_SCHEMA);
  if (err) return sendError(res, 400, err);

  const fields = ['temperature_c', 'pulse_bpm', 'resp_rate', 'bp_systolic', 'bp_diastolic', 'spo2'];
  const hasAnyReading = fields.some(f => body[f] !== undefined && body[f] !== null && body[f] !== '');
  if (!hasAnyReading) return sendError(res, 400, 'At least one vital sign reading is required');

  const toNum = v => (v === undefined || v === null || v === '' ? null : Number(v));
  db.prepare(`
    INSERT INTO vitals (admission_id, recorded_by, temperature_c, pulse_bpm, resp_rate, bp_systolic, bp_diastolic, spo2, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(admissionId, staff.staff_id, toNum(body.temperature_c), toNum(body.pulse_bpm), toNum(body.resp_rate), toNum(body.bp_systolic), toNum(body.bp_diastolic), toNum(body.spo2), body.notes || '');
  return sendJSON(res, 200, { ok: true });
}));

router.get(/^\/api\/admissions\/(\d+)\/vitals$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'nurse', 'admin']); if (!staff) return;
  const admissionId = Number(match[1]);
  const admission = db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId);
  if (!admission) return sendError(res, 404, 'Admission not found');
  const rows = db.prepare('SELECT * FROM vitals WHERE admission_id = ? ORDER BY recorded_at DESC').all(admissionId);
  return sendJSON(res, 200, rows);
}));

router.post(/^\/api\/admissions\/(\d+)\/orders$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'admin']); if (!staff) return;
  const admissionId = Number(match[1]);
  const { order_text, priority } = await readBody(req);
  if (!order_text) return sendError(res, 400, 'Order text required');
  db.prepare('INSERT INTO doctor_orders (admission_id, doctor_id, order_text, priority) VALUES (?, ?, ?, ?)')
    .run(admissionId, staff.staff_id, order_text, priority || 'routine');
  return sendJSON(res, 200, { ok: true });
}));

router.post(/^\/api\/orders\/(\d+)\/acknowledge$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['nurse', 'admin']); if (!staff) return;
  const result = db.prepare(`UPDATE doctor_orders SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = datetime('now') WHERE id = ?`)
    .run(staff.staff_id, Number(match[1]));
  if (result.changes === 0) return sendError(res, 404, 'Order not found');
  return sendJSON(res, 200, { ok: true });
}));

router.post(/^\/api\/orders\/(\d+)\/done$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['nurse', 'admin']); if (!staff) return;
  const result = db.prepare(`UPDATE doctor_orders SET status = 'done', done_by = ?, done_at = datetime('now') WHERE id = ?`)
    .run(staff.staff_id, Number(match[1]));
  if (result.changes === 0) return sendError(res, 404, 'Order not found');
  return sendJSON(res, 200, { ok: true });
}));

router.post(/^\/api\/orders\/(\d+)\/administer$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['nurse', 'admin']); if (!staff) return;
  const orderId = Number(match[1]);
  const { dosage_confirmed, notes } = await readBody(req);
  const order = db.prepare('SELECT * FROM doctor_orders WHERE id = ?').get(orderId);
  if (!order) return sendError(res, 404, 'Order not found');
  db.prepare('INSERT INTO medication_administrations (order_id, nurse_id, dosage_confirmed, notes) VALUES (?, ?, ?, ?)')
    .run(orderId, staff.staff_id, dosage_confirmed || '', notes || '');
  logAudit(staff.staff_id, 'medication_administered', null, `order #${orderId}`);
  return sendJSON(res, 200, { ok: true });
}));

router.post(/^\/api\/admissions\/(\d+)\/discharge-summary$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'admin']); if (!staff) return;
  const admissionId = Number(match[1]);
  const { diagnosis_summary, condition_at_discharge, discharge_instructions, follow_up } = await readBody(req);
  db.prepare(`
    INSERT INTO discharge_summaries (admission_id, doctor_id, diagnosis_summary, condition_at_discharge, discharge_instructions, follow_up)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(admission_id) DO UPDATE SET
      doctor_id = excluded.doctor_id, diagnosis_summary = excluded.diagnosis_summary,
      condition_at_discharge = excluded.condition_at_discharge, discharge_instructions = excluded.discharge_instructions,
      follow_up = excluded.follow_up, created_at = datetime('now')
  `).run(admissionId, staff.staff_id, diagnosis_summary || '', condition_at_discharge || '', discharge_instructions || '', follow_up || '');
  return sendJSON(res, 200, { ok: true });
}));

// Nursing/reception process the administrative discharge once a doctor has
// already written the discharge summary (see the README's two-step discharge
// policy) — 'reception' is included here because they're the ones who
// typically collect the final ward charge at the front desk, not just nursing.
router.post(/^\/api\/admissions\/(\d+)\/discharge$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'nurse', 'reception', 'admin']); if (!staff) return;
  const admissionId = Number(match[1]);
  const admission = db.prepare('SELECT * FROM admissions WHERE id = ?').get(admissionId);
  if (!admission) return sendError(res, 404, 'Admission not found');
  if (admission.status !== 'active') return sendError(res, 400, 'This admission has already been discharged');
  const summary = db.prepare('SELECT * FROM discharge_summaries WHERE admission_id = ?').get(admissionId);
  if (!summary) return sendError(res, 400, 'A doctor must write and save a discharge summary for this patient before discharge can be completed.');
  const { discharge_charge } = await readBody(req);
  const receipt = receiptNo();
  // Status-guarded UPDATE: if two discharge requests for the same admission
  // race each other, only the first (still 'active') matches and a second
  // receipt is never generated for the same discharge.
  const result = db.prepare(`UPDATE admissions SET status = 'discharged', discharge_charge = ?, discharge_receipt_no = ?, discharged_by = ?, discharged_at = datetime('now') WHERE id = ? AND status = 'active'`)
    .run(Number(discharge_charge) || 0, receipt, staff.staff_id, admissionId);
  if (result.changes === 0) return sendError(res, 400, 'This admission has already been discharged');
  return sendJSON(res, 200, { ok: true, receipt_no: receipt });
}));

module.exports = router;
