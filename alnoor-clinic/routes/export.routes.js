// routes/export.routes.js — CSV/Excel exports (admin only)
const { createRouter } = require('../router');
const { db } = require('../db');
const { requireAuth, asyncHandler, sendCSV } = require('../middleware');

const router = createRouter();

router.get('/api/export/patients', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  return sendCSV(res, 'patients.csv', db.prepare('SELECT mr_number, name, age, gender, phone, address, registered_by, created_at FROM patients ORDER BY created_at').all());
}));

router.get('/api/export/visits', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  return sendCSV(res, 'visits.csv', db.prepare(`
    SELECT v.id, pt.mr_number, pt.name AS patient_name, v.reason, v.room, v.status, v.consultation_fee, v.consultation_receipt_no, v.created_by, v.created_at
    FROM visits v JOIN patients pt ON pt.id = v.patient_id ORDER BY v.created_at
  `).all());
}));

router.get('/api/export/lab-results', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const rows = db.prepare(`
    SELECT lo.id, pt.mr_number, pt.name AS patient_name, lo.tests, lo.status, lo.payment_amount, lo.receipt_no, lo.entered_by, lo.completed_at
    FROM lab_orders lo JOIN patients pt ON pt.id = lo.patient_id ORDER BY lo.created_at
  `).all().map(r => ({ ...r, tests: JSON.parse(r.tests).join('; ') }));
  return sendCSV(res, 'lab-results.csv', rows);
}));

router.get('/api/export/pharmacy-sales', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const rows = db.prepare(`
    SELECT d.id, pt.mr_number, pt.name AS patient_name, d.subtotal, d.discount_percent, d.payment_amount, d.receipt_no, d.dispensed_by, d.created_at
    FROM dispenses d LEFT JOIN patients pt ON pt.id = d.patient_id ORDER BY d.created_at
  `).all();
  return sendCSV(res, 'pharmacy-sales.csv', rows);
}));

router.get('/api/export/inventory', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  return sendCSV(res, 'inventory.csv', db.prepare('SELECT * FROM drug_batches ORDER BY drug_name, expiry_date').all());
}));

router.get('/api/export/procedures', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const rows = db.prepare(`
    SELECT pr.id, pt.mr_number, pt.name AS patient_name, pr.procedure_type, pr.surgeon, pr.status, pr.charge_amount, pr.receipt_no, pr.completed_at
    FROM procedures pr JOIN patients pt ON pt.id = pr.patient_id ORDER BY pr.created_at
  `).all();
  return sendCSV(res, 'procedures.csv', rows);
}));

router.get('/api/export/revenue-summary', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const rows = [
    { category: 'Outpatient', ...db.prepare('SELECT COALESCE(SUM(consultation_fee),0) total, COUNT(*) count FROM visits WHERE consultation_fee > 0').get() },
    { category: 'Inpatient', ...db.prepare("SELECT COALESCE(SUM(discharge_charge),0) total, COUNT(*) count FROM admissions WHERE status='discharged'").get() },
    { category: 'Laboratory', ...db.prepare("SELECT COALESCE(SUM(payment_amount),0) total, COUNT(*) count FROM lab_orders WHERE status='done'").get() },
    { category: 'Radiology', ...db.prepare("SELECT COALESCE(SUM(payment_amount),0) total, COUNT(*) count FROM radiology_orders WHERE status='done'").get() },
    { category: 'Pharmacy', ...db.prepare('SELECT COALESCE(SUM(payment_amount),0) total, COUNT(*) count FROM dispenses').get() },
    { category: 'Procedures', ...db.prepare("SELECT COALESCE(SUM(charge_amount),0) total, COUNT(*) count FROM procedures WHERE status='completed'").get() },
  ];
  return sendCSV(res, 'revenue-summary.csv', rows);
}));

// ===== Financial Export: one row per revenue transaction, every department =====
// Note on "payment method": this system doesn't currently distinguish cash from
// card/mobile payment anywhere — every collection screen just records an amount.
// The column is included as requested but will read "Cash" for every row until
// that distinction is actually built into the collection flows; it is not
// fabricated variety, just an honest reflection of what's tracked today.
router.get('/api/export/financial-detailed', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const rows = [];

  for (const v of db.prepare(`
    SELECT pt.mr_number, pt.name AS patient_name, v.consultation_fee, v.consultation_receipt_no, v.created_by, v.created_at
    FROM visits v JOIN patients pt ON pt.id = v.patient_id WHERE v.consultation_fee > 0
  `).all()) {
    rows.push({ date_time: v.created_at, department: 'Outpatient Consultation', patient_name: v.patient_name, mr_number: v.mr_number, amount: v.consultation_fee, receipt_no: v.consultation_receipt_no, payment_method: 'Cash', collected_by: v.created_by });
  }
  for (const a of db.prepare(`
    SELECT pt.mr_number, pt.name AS patient_name, a.discharge_charge, a.discharge_receipt_no, a.discharged_by, a.discharged_at
    FROM admissions a JOIN patients pt ON pt.id = a.patient_id WHERE a.status = 'discharged'
  `).all()) {
    rows.push({ date_time: a.discharged_at, department: 'Inpatient / Discharge', patient_name: a.patient_name, mr_number: a.mr_number, amount: a.discharge_charge, receipt_no: a.discharge_receipt_no, payment_method: 'Cash', collected_by: a.discharged_by });
  }
  for (const l of db.prepare(`
    SELECT pt.mr_number, pt.name AS patient_name, l.payment_amount, l.receipt_no, l.entered_by, l.paid_at
    FROM lab_orders l JOIN patients pt ON pt.id = l.patient_id WHERE l.status = 'done'
  `).all()) {
    rows.push({ date_time: l.paid_at, department: 'Laboratory', patient_name: l.patient_name, mr_number: l.mr_number, amount: l.payment_amount, receipt_no: l.receipt_no, payment_method: 'Cash', collected_by: l.entered_by });
  }
  for (const r of db.prepare(`
    SELECT pt.mr_number, pt.name AS patient_name, r.payment_amount, r.receipt_no, r.entered_by, r.paid_at
    FROM radiology_orders r JOIN patients pt ON pt.id = r.patient_id WHERE r.status = 'done'
  `).all()) {
    rows.push({ date_time: r.paid_at, department: 'Radiology', patient_name: r.patient_name, mr_number: r.mr_number, amount: r.payment_amount, receipt_no: r.receipt_no, payment_method: 'Cash', collected_by: r.entered_by });
  }
  for (const d of db.prepare(`
    SELECT pt.mr_number, pt.name AS patient_name, d.payment_amount, d.receipt_no, d.dispensed_by, d.created_at
    FROM dispenses d LEFT JOIN patients pt ON pt.id = d.patient_id
  `).all()) {
    rows.push({ date_time: d.created_at, department: 'Pharmacy', patient_name: d.patient_name || 'Walk-in (no MR)', mr_number: d.mr_number || '—', amount: d.payment_amount, receipt_no: d.receipt_no, payment_method: 'Cash', collected_by: d.dispensed_by });
  }
  for (const p of db.prepare(`
    SELECT pt.mr_number, pt.name AS patient_name, p.procedure_type, p.charge_amount, p.receipt_no, p.completed_by, p.completed_at
    FROM procedures p JOIN patients pt ON pt.id = p.patient_id WHERE p.status = 'completed'
  `).all()) {
    rows.push({ date_time: p.completed_at, department: `Procedure — ${p.procedure_type}`, patient_name: p.patient_name, mr_number: p.mr_number, amount: p.charge_amount, receipt_no: p.receipt_no, payment_method: 'Cash', collected_by: p.completed_by });
  }

  rows.sort((a, b) => (a.date_time || '').localeCompare(b.date_time || ''));
  return sendCSV(res, 'financial-detailed.csv', rows);
}));

// ===== Distributor purchase log: every batch ever received, all-time =====
router.get('/api/export/purchases-detailed', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const rows = db.prepare(`
    SELECT drug_name, distributor_name, company_name, invoice_number, batch_number,
           quantity, purchase_price, (quantity * purchase_price) AS total_cost, created_at AS purchase_date, created_by
    FROM drug_batches ORDER BY created_at DESC
  `).all();
  return sendCSV(res, 'purchases-detailed.csv', rows);
}));

// ===== Clinical/Patient Export: patient name, MRN/Walk-in ID, tests + results,
// prescribed medicines, date/time — combined activity log across Lab, Radiology,
// and Pharmacy prescriptions. Each activity is its own row (a lab test and a
// prescription are different kinds of records, so forcing them into one row per
// patient would lose detail) but shares one consistent column set. =====
router.get('/api/export/clinical-log', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const rows = [];

  for (const l of db.prepare(`
    SELECT pt.name AS patient_name, pt.mr_number, pt.patient_type, l.tests, l.results, l.paid_at
    FROM lab_orders l JOIN patients pt ON pt.id = l.patient_id WHERE l.status = 'done'
  `).all()) {
    const tests = JSON.parse(l.tests).join('; ');
    const results = (JSON.parse(l.results || '[]')).map(r =>
      r.components ? r.components.map(c => `${c.name}: ${c.value}${c.unit ? ' ' + c.unit : ''}`).join(', ') : `${r.test}: ${r.value}${r.unit ? ' ' + r.unit : ''}`
    ).join(' | ');
    rows.push({ date_time: l.paid_at, patient_name: l.patient_name, mrn_or_walkin_id: l.mr_number, patient_type: l.patient_type, activity_type: 'Lab Test', details: tests, result_or_medicines: results });
  }
  for (const r of db.prepare(`
    SELECT pt.name AS patient_name, pt.mr_number, pt.patient_type, r.tests, r.results, r.paid_at
    FROM radiology_orders r JOIN patients pt ON pt.id = r.patient_id WHERE r.status = 'done'
  `).all()) {
    const tests = JSON.parse(r.tests).join('; ');
    const findings = (JSON.parse(r.results || '[]')).map(f => `${f.test}: ${f.findings}`).join(' | ');
    rows.push({ date_time: r.paid_at, patient_name: r.patient_name, mrn_or_walkin_id: r.mr_number, patient_type: r.patient_type, activity_type: 'Radiology Study', details: tests, result_or_medicines: findings });
  }
  for (const p of db.prepare(`
    SELECT pt.name AS patient_name, pt.mr_number, pt.patient_type, p.medicines, p.doctor_id, p.created_at
    FROM prescriptions p JOIN patients pt ON pt.id = p.patient_id
  `).all()) {
    const meds = JSON.parse(p.medicines).map(m => `${m.name} (${m.dosage || 'no dosage noted'}) x${m.qty || '—'}`).join(', ');
    rows.push({ date_time: p.created_at, patient_name: p.patient_name, mrn_or_walkin_id: p.mr_number, patient_type: p.patient_type, activity_type: `Prescription (Dr. ${p.doctor_id})`, details: '—', result_or_medicines: meds });
  }

  rows.sort((a, b) => (a.date_time || '').localeCompare(b.date_time || ''));
  return sendCSV(res, 'clinical-log.csv', rows);
}));

module.exports = router;
