// routes/dashboard.routes.js — hospital census, doctor stats, revenue
const { createRouter } = require('../router');
const { db } = require('../db');
const { sendJSON, requireAuth, asyncHandler } = require('../middleware');

const router = createRouter();

router.get('/api/census', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin', 'doctor']); if (!staff) return;
  const ipd = db.prepare("SELECT COUNT(*) c FROM admissions WHERE status = 'active'").get().c;
  // `opd` is a broad "still an open episode today" count — it includes patients
  // currently at the lab counter or picking up medicine, not just those sitting
  // in the doctor's queue. `waitingDoctor` is the narrow, exact figure: this is
  // the SAME count the Doctor Portal's own queue (`/api/visits/queue`) is built
  // from, so Admin and Doctor always agree on "how many are actually waiting to
  // be seen" instead of Admin reading the broader `opd` number as if it meant
  // that. Added to fix a reported desync where Admin showed patients as still
  // "waiting" that the Doctor Portal had already moved past.
  const opd = db.prepare("SELECT COUNT(DISTINCT patient_id) c FROM visits WHERE status != 'closed'").get().c;
  const waitingDoctor = db.prepare("SELECT COUNT(*) c FROM visits WHERE status = 'waiting_doctor'").get().c;
  const lab = db.prepare(`
    SELECT COUNT(DISTINCT patient_id) c FROM (
      SELECT patient_id FROM lab_orders WHERE status = 'pending'
      UNION
      SELECT patient_id FROM radiology_orders WHERE status = 'pending'
    )
  `).get().c;
  const total = db.prepare(`
    SELECT COUNT(DISTINCT patient_id) c FROM (
      SELECT patient_id FROM visits WHERE status != 'closed'
      UNION
      SELECT patient_id FROM admissions WHERE status = 'active'
    )
  `).get().c;
  return sendJSON(res, 200, { ipd, opd, waitingDoctor, lab, total });
}));

router.get('/api/dashboard/doctors', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const rows = db.prepare(`
    SELECT s.staff_id, s.name,
      (SELECT COUNT(*) FROM examinations e WHERE e.doctor_id = s.staff_id) AS total_patients_seen,
      (SELECT COUNT(*) FROM examinations e WHERE e.doctor_id = s.staff_id AND date(e.created_at) = date('now')) AS patients_today,
      (SELECT COUNT(*) FROM admissions a WHERE a.admitting_doctor = s.staff_id AND a.status = 'active') AS active_inpatients
    FROM staff s WHERE s.role = 'doctor' ORDER BY total_patients_seen DESC
  `).all();
  return sendJSON(res, 200, rows);
}));

router.get('/api/dashboard/revenue', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const range = url.searchParams.get('range') || 'all';
  const dateFilter = {
    today: "date(created_at) = date('now')",
    week: "created_at >= datetime('now', '-7 days')",
    month: "created_at >= datetime('now', '-30 days')",
    all: "1=1"
  }[range] || '1=1';
  const outpatient = db.prepare(`SELECT COALESCE(SUM(consultation_fee),0) total, COUNT(*) c FROM visits WHERE consultation_fee > 0 AND ${dateFilter}`).get();
  const inpatient = db.prepare(`SELECT COALESCE(SUM(discharge_charge),0) total, COUNT(*) c FROM admissions WHERE status='discharged' AND ${dateFilter.replace(/created_at/g, 'discharged_at')}`).get();
  const lab = db.prepare(`SELECT COALESCE(SUM(payment_amount),0) total, COUNT(*) c FROM lab_orders WHERE status='done' AND ${dateFilter.replace(/created_at/g, 'paid_at')}`).get();
  const radiology = db.prepare(`SELECT COALESCE(SUM(payment_amount),0) total, COUNT(*) c FROM radiology_orders WHERE status='done' AND ${dateFilter.replace(/created_at/g, 'paid_at')}`).get();
  const pharmacy = db.prepare(`SELECT COALESCE(SUM(payment_amount),0) total, COUNT(*) c FROM dispenses WHERE ${dateFilter}`).get();
  const proceduresTotal = db.prepare(`SELECT COALESCE(SUM(charge_amount),0) total, COUNT(*) c FROM procedures WHERE status='completed' AND ${dateFilter.replace(/created_at/g, 'completed_at')}`).get();
  const proceduresByType = db.prepare(`
    SELECT procedure_type, COUNT(*) c, COALESCE(SUM(charge_amount),0) total
    FROM procedures WHERE status='completed' AND ${dateFilter.replace(/created_at/g, 'completed_at')}
    GROUP BY procedure_type ORDER BY total DESC
  `).all();
  const grandTotal = outpatient.total + inpatient.total + lab.total + radiology.total + pharmacy.total + proceduresTotal.total;
  return sendJSON(res, 200, { range, outpatient, inpatient, lab, radiology, pharmacy, procedures: proceduresTotal, proceduresByType, grandTotal });
}));

module.exports = router;
