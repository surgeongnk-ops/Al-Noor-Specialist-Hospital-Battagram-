// routes/billing.routes.js — consolidated master receipt across all departments
const { createRouter } = require('../router');
const { db, logAudit } = require('../db');
const { sendJSON, sendError, requireAuth, asyncHandler } = require('../middleware');

const router = createRouter();

router.get(/^\/api\/billing\/([^/]+)\/master-receipt$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['reception', 'admin']); if (!staff) return;
  const patient = db.prepare('SELECT * FROM patients WHERE mr_number = ?').get(decodeURIComponent(match[1]));
  if (!patient) return sendError(res, 404, 'Patient not found');

  const lines = [];
  for (const v of db.prepare('SELECT * FROM visits WHERE patient_id = ? AND consultation_fee > 0').all(patient.id)) {
    lines.push({ category: 'Outpatient Consultation', receipt_no: v.consultation_receipt_no, amount: v.consultation_fee, date: v.created_at });
  }
  for (const a of db.prepare("SELECT * FROM admissions WHERE patient_id = ? AND status = 'discharged'").all(patient.id)) {
    lines.push({ category: 'Inpatient / Ward Charges', receipt_no: a.discharge_receipt_no, amount: a.discharge_charge, date: a.discharged_at });
  }
  for (const l of db.prepare("SELECT * FROM lab_orders WHERE patient_id = ? AND status = 'done'").all(patient.id)) {
    lines.push({ category: 'Laboratory', receipt_no: l.receipt_no, amount: l.payment_amount, date: l.paid_at });
  }
  for (const r of db.prepare("SELECT * FROM radiology_orders WHERE patient_id = ? AND status = 'done'").all(patient.id)) {
    lines.push({ category: 'Radiology', receipt_no: r.receipt_no, amount: r.payment_amount, date: r.paid_at });
  }
  for (const d of db.prepare('SELECT * FROM dispenses WHERE patient_id = ?').all(patient.id)) {
    lines.push({ category: 'Pharmacy', receipt_no: d.receipt_no, amount: d.payment_amount, date: d.created_at });
  }
  for (const pr of db.prepare("SELECT * FROM procedures WHERE patient_id = ? AND status = 'completed'").all(patient.id)) {
    lines.push({ category: `Procedure — ${pr.procedure_type}`, receipt_no: pr.receipt_no, amount: pr.charge_amount, date: pr.completed_at });
  }
  lines.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const grandTotal = lines.reduce((s, l) => s + (l.amount || 0), 0);
  logAudit(staff.staff_id, 'master_receipt', patient.mr_number, null);
  return sendJSON(res, 200, { patient, lines, grandTotal });
}));

module.exports = router;
