// routes/doctor.routes.js — doctor queue, examinations, referrals, prescriptions
const { createRouter } = require('../router');
const { db } = require('../db');
const { sendJSON, sendError, readBody, requireAuth, asyncHandler } = require('../middleware');
const { computeLockedTestTotal } = require('./catalog.routes');

const router = createRouter();

router.get('/api/visits/queue', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['doctor', 'admin']); if (!staff) return;
  const rows = db.prepare(`
    SELECT v.*, pt.mr_number, pt.name AS patient_name, pt.age, pt.gender
    FROM visits v JOIN patients pt ON pt.id = v.patient_id
    WHERE v.status = 'waiting_doctor' ORDER BY v.created_at ASC
  `).all();
  return sendJSON(res, 200, rows);
}));

router.get('/api/visits/results-ready', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['doctor', 'admin']); if (!staff) return;
  const rows = db.prepare(`
    SELECT v.*, pt.mr_number, pt.name AS patient_name, pt.age, pt.gender
    FROM visits v JOIN patients pt ON pt.id = v.patient_id
    WHERE v.results_ready = 1 ORDER BY v.results_ready_at ASC
  `).all();
  return sendJSON(res, 200, rows);
}));

router.post(/^\/api\/visits\/(\d+)\/examination$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'admin']); if (!staff) return;
  const visitId = Number(match[1]);
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
  if (!visit) return sendError(res, 404, 'Visit not found');
  const { notes, diagnosis } = await readBody(req);
  db.prepare('INSERT INTO examinations (visit_id, doctor_id, notes, diagnosis) VALUES (?, ?, ?, ?)')
    .run(visitId, staff.staff_id, notes || '', diagnosis || '');
  db.prepare("UPDATE visits SET status = 'with_doctor', results_ready = 0 WHERE id = ?").run(visitId);
  return sendJSON(res, 200, { ok: true });
}));

// Payment-gated LMS workflow: the price is locked the moment the order exists,
// because the very next thing that must happen — before any specimen is
// collected or any test is touched — is the patient paying that exact amount
// at the counter. A test with no price set at all cannot be ordered; asking
// the admin to price it first is safer than ordering it and discovering later
// there's nothing to bill.
router.post(/^\/api\/visits\/(\d+)\/lab-order$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'admin']); if (!staff) return;
  const visitId = Number(match[1]);
  const { tests } = await readBody(req);
  if (!tests || !tests.length) return sendError(res, 400, 'No tests specified');
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
  if (!visit) return sendError(res, 404, 'Visit not found');
  const priced = computeLockedTestTotal(tests);
  if (!priced.ok) return sendError(res, 400, `Cannot order — no price set for: ${priced.missing.join(', ')}. Ask an admin to set test pricing first.`);
  db.prepare(`INSERT INTO lab_orders (visit_id, patient_id, ordered_by, tests, status, payment_amount) VALUES (?, ?, ?, ?, 'PENDING_PAYMENT', ?)`)
    .run(visitId, visit.patient_id, staff.staff_id, JSON.stringify(tests), priced.total);
  db.prepare("UPDATE visits SET status = 'waiting_lab' WHERE id = ?").run(visitId);
  return sendJSON(res, 200, { ok: true, payment_amount: priced.total });
}));

router.post(/^\/api\/visits\/(\d+)\/radiology-order$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'admin']); if (!staff) return;
  const visitId = Number(match[1]);
  const { tests } = await readBody(req);
  if (!tests || !tests.length) return sendError(res, 400, 'No tests specified');
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
  if (!visit) return sendError(res, 404, 'Visit not found');
  db.prepare('INSERT INTO radiology_orders (visit_id, patient_id, ordered_by, tests) VALUES (?, ?, ?, ?)')
    .run(visitId, visit.patient_id, staff.staff_id, JSON.stringify(tests));
  db.prepare("UPDATE visits SET status = 'waiting_lab' WHERE id = ?").run(visitId);
  return sendJSON(res, 200, { ok: true });
}));

router.post(/^\/api\/visits\/(\d+)\/admit$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'admin']); if (!staff) return;
  const visitId = Number(match[1]);
  const { ward, room, reason } = await readBody(req);
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
  if (!visit) return sendError(res, 404, 'Visit not found');
  db.prepare('INSERT INTO admissions (patient_id, visit_id, admitting_doctor, ward, room, reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(visit.patient_id, visitId, staff.staff_id, ward || '', room || '', reason || '', staff.staff_id);
  return sendJSON(res, 200, { ok: true });
}));

router.get(/^\/api\/visits\/(\d+)\/prescriptions$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'admin']); if (!staff) return;
  const rows = db.prepare('SELECT * FROM prescriptions WHERE visit_id = ? ORDER BY created_at DESC').all(Number(match[1]))
    .map(r => ({ ...r, medicines: JSON.parse(r.medicines) }));
  return sendJSON(res, 200, rows);
}));

router.post(/^\/api\/visits\/(\d+)\/prescription$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'admin']); if (!staff) return;
  const visitId = Number(match[1]);
  const { medicines } = await readBody(req);
  if (!medicines || !medicines.length) return sendError(res, 400, 'No medicines specified');
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
  if (!visit) return sendError(res, 404, 'Visit not found');
  db.prepare('INSERT INTO prescriptions (visit_id, patient_id, doctor_id, medicines) VALUES (?, ?, ?, ?)')
    .run(visitId, visit.patient_id, staff.staff_id, JSON.stringify(medicines));
  db.prepare("UPDATE visits SET status = 'waiting_pharmacy' WHERE id = ?").run(visitId);
  return sendJSON(res, 200, { ok: true });
}));

router.put(/^\/api\/prescriptions\/(\d+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'admin']); if (!staff) return;
  const rxId = Number(match[1]);
  const { medicines } = await readBody(req);
  if (!medicines || !medicines.length) return sendError(res, 400, 'No medicines specified');
  const rx = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(rxId);
  if (!rx) return sendError(res, 404, 'Prescription not found');
  if (rx.status === 'dispensed') return sendError(res, 400, 'Already dispensed by pharmacy — cannot edit. This prescription has already reached the patient.');
  db.prepare("UPDATE prescriptions SET medicines = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(medicines), rxId);
  return sendJSON(res, 200, { ok: true });
}));

router.post('/api/visits/close', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['doctor', 'admin']); if (!staff) return;
  const { visit_id } = await readBody(req);
  const result = db.prepare("UPDATE visits SET status = 'closed' WHERE id = ?").run(Number(visit_id) || 0);
  if (result.changes === 0) return sendError(res, 404, 'Visit not found');
  return sendJSON(res, 200, { ok: true });
}));

module.exports = router;
