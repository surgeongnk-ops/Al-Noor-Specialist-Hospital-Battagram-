// routes/patients.routes.js — registration, search, combined record (Reception + shared)
const { createRouter } = require('../router');
const { db, nextCounter, logAudit } = require('../db');
const { sendJSON, sendError, readBody, requireAuth, validateBody, asyncHandler, receiptNo } = require('../middleware');

const router = createRouter();

router.post('/api/patients', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['reception', 'admin']); if (!staff) return;
  const body = await readBody(req);
  const err = validateBody(body, { name: { required: true, type: 'string' } });
  if (err) return sendError(res, 400, err);
  const { age, gender, phone, address, reason, room, consultation_fee, allergies } = body;
  const mr = nextCounter('mr', 'P-');
  db.prepare('INSERT INTO patients (mr_number, name, age, gender, phone, address, registered_by, allergies) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(mr, body.name, age || '', gender || '', phone || '', address || '', staff.staff_id, allergies || null);
  const patient = db.prepare('SELECT * FROM patients WHERE mr_number = ?').get(mr);
  const fee = Number(consultation_fee) || 0;
  const receipt = fee > 0 ? receiptNo() : null;
  db.prepare('INSERT INTO visits (patient_id, reason, room, created_by, consultation_fee, consultation_receipt_no) VALUES (?, ?, ?, ?, ?, ?)')
    .run(patient.id, reason || '', room || '', staff.staff_id, fee, receipt);
  return sendJSON(res, 200, { ...patient, consultation_receipt_no: receipt, consultation_fee: fee });
}));

router.get('/api/patients/search', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, null); if (!staff) return;
  const q = `%${url.searchParams.get('q') || ''}%`;
  const rows = db.prepare('SELECT * FROM patients WHERE mr_number LIKE ? OR name LIKE ? OR phone LIKE ? ORDER BY created_at DESC LIMIT 30')
    .all(q, q, q);
  return sendJSON(res, 200, rows);
}));

router.get(/^\/api\/patients\/([^/]+)\/record$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, null); if (!staff) return;
  const patient = db.prepare('SELECT * FROM patients WHERE mr_number = ?').get(decodeURIComponent(match[1]));
  if (!patient) return sendError(res, 404, 'Patient not found');
  logAudit(staff.staff_id, 'view_record', patient.mr_number, null);
  const visits = db.prepare('SELECT * FROM visits WHERE patient_id = ? ORDER BY created_at DESC').all(patient.id);
  for (const v of visits) {
    v.examinations = db.prepare('SELECT * FROM examinations WHERE visit_id = ? ORDER BY created_at DESC').all(v.id);
    v.lab_orders = db.prepare('SELECT * FROM lab_orders WHERE visit_id = ? ORDER BY created_at DESC').all(v.id)
      .map(o => ({ ...o, tests: JSON.parse(o.tests), results: o.results ? JSON.parse(o.results) : null }));
    v.radiology_orders = db.prepare('SELECT * FROM radiology_orders WHERE visit_id = ? ORDER BY created_at DESC').all(v.id)
      .map(o => ({ ...o, tests: JSON.parse(o.tests), results: o.results ? JSON.parse(o.results) : null }));
    v.prescriptions = db.prepare('SELECT * FROM prescriptions WHERE visit_id = ? ORDER BY created_at DESC').all(v.id)
      .map(pr => ({ ...pr, medicines: JSON.parse(pr.medicines) }));
  }
  const admissions = db.prepare('SELECT * FROM admissions WHERE patient_id = ? ORDER BY created_at DESC').all(patient.id);
  for (const a of admissions) {
    a.orders = db.prepare('SELECT * FROM doctor_orders WHERE admission_id = ? ORDER BY created_at DESC').all(a.id);
  }
  const procedures = db.prepare('SELECT * FROM procedures WHERE patient_id = ? ORDER BY created_at DESC').all(patient.id);
  return sendJSON(res, 200, { patient, visits, admissions, procedures });
}));

router.post('/api/visits/new-visit', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['reception', 'admin']); if (!staff) return;
  const { mr_number, reason, room, consultation_fee } = await readBody(req);
  const patient = db.prepare('SELECT * FROM patients WHERE mr_number = ?').get(mr_number || '');
  if (!patient) return sendError(res, 404, 'Patient not found');
  const fee = Number(consultation_fee) || 0;
  const receipt = fee > 0 ? receiptNo() : null;
  db.prepare('INSERT INTO visits (patient_id, reason, room, created_by, consultation_fee, consultation_receipt_no) VALUES (?, ?, ?, ?, ?, ?)')
    .run(patient.id, reason || '', room || '', staff.staff_id, fee, receipt);
  return sendJSON(res, 200, { ok: true, consultation_receipt_no: receipt });
}));

// Free-text, known-drug-allergy field on the patient's own record (not per-visit)
// — set at registration if known, or added/corrected later by whoever finds out
// first (reception, a nurse taking history, the doctor, or pharmacy catching it
// at dispense time). Feeds the interaction/allergy check in
// routes/pharmacy.routes.js (GET /api/pharmacy/safety-check) that both the
// Doctor Portal's prescription screen and the Pharmacy dispense screen call.
router.put(/^\/api\/patients\/([^/]+)\/allergies$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, null); if (!staff) return;
  const mr = decodeURIComponent(match[1]);
  const patient = db.prepare('SELECT * FROM patients WHERE mr_number = ?').get(mr);
  if (!patient) return sendError(res, 404, 'Patient not found');
  const { allergies } = await readBody(req);
  db.prepare('UPDATE patients SET allergies = ? WHERE id = ?').run((allergies || '').trim() || null, patient.id);
  logAudit(staff.staff_id, 'allergies_updated', mr, allergies || '(cleared)');
  return sendJSON(res, 200, { ok: true, allergies: (allergies || '').trim() || null });
}));

module.exports = router;
