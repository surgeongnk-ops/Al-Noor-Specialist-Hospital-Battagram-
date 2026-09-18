// routes/certificates.routes.js — official document issuance (Birth Certificate, etc.)
const { createRouter } = require('../router');
const { db, nextCounter, logAudit } = require('../db');
const { sendJSON, sendError, readBody, requireAuth, validateBody, asyncHandler } = require('../middleware');

const router = createRouter();

router.post('/api/certificates/birth', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['doctor', 'nurse', 'admin']); if (!staff) return;
  const body = await readBody(req);
  const err = validateBody(body, {
    baby_name: { required: true, type: 'string' },
    gender: { required: true, type: 'string', enum: ['Male', 'Female'] },
    date_of_birth: { required: true, type: 'string' }
  });
  if (err) return sendError(res, 400, err);

  let patient_id = null;
  if (body.mr_number) {
    // If an MR number is supplied at all, it must resolve to a real patient —
    // otherwise the certificate carries a dangling reference that looks valid
    // but points nowhere (a data-integrity gap, not a legitimate "no MRN yet"
    // case; leave mr_number blank entirely for that instead).
    const patient = db.prepare('SELECT * FROM patients WHERE mr_number = ?').get(body.mr_number);
    if (!patient) return sendError(res, 404, `No patient found with MR number ${body.mr_number}`);
    patient_id = patient.id;
  }

  const certificate_no = nextCounter('birth_cert', 'BC-');
  db.prepare(`
    INSERT INTO birth_certificates
      (certificate_no, patient_id, mr_number, baby_name, gender, date_of_birth, time_of_birth,
       father_name, mother_name, attending_doctor, weight, issued_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    certificate_no, patient_id, body.mr_number || null, body.baby_name, body.gender, body.date_of_birth,
    body.time_of_birth || '', body.father_name || '', body.mother_name || '', body.attending_doctor || '',
    body.weight || '', staff.staff_id
  );
  logAudit(staff.staff_id, 'birth_certificate_issued', body.mr_number || null, `${certificate_no}: ${body.baby_name}`);
  const cert = db.prepare('SELECT * FROM birth_certificates WHERE certificate_no = ?').get(certificate_no);
  return sendJSON(res, 200, cert);
}));

router.get('/api/certificates/birth', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['doctor', 'nurse', 'admin']); if (!staff) return;
  const mr = url.searchParams.get('mr');
  const rows = mr
    ? db.prepare('SELECT * FROM birth_certificates WHERE mr_number = ? ORDER BY created_at DESC').all(mr)
    : db.prepare('SELECT * FROM birth_certificates ORDER BY created_at DESC LIMIT 100').all();
  return sendJSON(res, 200, rows);
}));

router.get(/^\/api\/certificates\/birth\/([^/]+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'nurse', 'admin']); if (!staff) return;
  const cert = db.prepare('SELECT * FROM birth_certificates WHERE certificate_no = ?').get(decodeURIComponent(match[1]));
  if (!cert) return sendError(res, 404, 'Certificate not found');
  return sendJSON(res, 200, cert);
}));

// ===== Death Certificate =====
router.post('/api/certificates/death', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['doctor', 'admin']); if (!staff) return;
  const body = await readBody(req);
  const err = validateBody(body, {
    deceased_name: { required: true, type: 'string' },
    date_of_death: { required: true, type: 'string' }
  });
  if (err) return sendError(res, 400, err);

  let patient_id = null;
  if (body.mr_number) {
    const patient = db.prepare('SELECT * FROM patients WHERE mr_number = ?').get(body.mr_number);
    if (!patient) return sendError(res, 404, `No patient found with MR number ${body.mr_number}`);
    patient_id = patient.id;
  }

  const certificate_no = nextCounter('death_cert', 'DC-');
  db.prepare(`
    INSERT INTO death_certificates
      (certificate_no, patient_id, mr_number, deceased_name, age, gender, date_of_death, time_of_death,
       place_of_death, cause_of_death, attending_doctor, next_of_kin, issued_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    certificate_no, patient_id, body.mr_number || null, body.deceased_name, body.age || '', body.gender || '',
    body.date_of_death, body.time_of_death || '', body.place_of_death || '', body.cause_of_death || '',
    body.attending_doctor || '', body.next_of_kin || '', staff.staff_id
  );
  logAudit(staff.staff_id, 'death_certificate_issued', body.mr_number || null, `${certificate_no}: ${body.deceased_name}`);
  const cert = db.prepare('SELECT * FROM death_certificates WHERE certificate_no = ?').get(certificate_no);
  return sendJSON(res, 200, cert);
}));

router.get('/api/certificates/death', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['doctor', 'admin']); if (!staff) return;
  const mr = url.searchParams.get('mr');
  const rows = mr
    ? db.prepare('SELECT * FROM death_certificates WHERE mr_number = ? ORDER BY created_at DESC').all(mr)
    : db.prepare('SELECT * FROM death_certificates ORDER BY created_at DESC LIMIT 100').all();
  return sendJSON(res, 200, rows);
}));

router.get(/^\/api\/certificates\/death\/([^/]+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'admin']); if (!staff) return;
  const cert = db.prepare('SELECT * FROM death_certificates WHERE certificate_no = ?').get(decodeURIComponent(match[1]));
  if (!cert) return sendError(res, 404, 'Certificate not found');
  return sendJSON(res, 200, cert);
}));

// ===== Discharge Certificate =====
// Not a new issuance form — this formally re-presents an existing IPD discharge
// summary (already written by the doctor, gating actual discharge) for official
// certificate printing, so there's exactly one source of truth for the clinical
// content rather than two places a discharge narrative could be entered.
router.get('/api/certificates/discharge', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['doctor', 'nurse', 'admin']); if (!staff) return;
  const mr = url.searchParams.get('mr');
  if (!mr) return sendError(res, 400, 'MR number is required');
  const patient = db.prepare('SELECT * FROM patients WHERE mr_number = ?').get(mr);
  if (!patient) return sendError(res, 404, 'Patient not found');
  const rows = db.prepare(`
    SELECT a.*, ds.doctor_id, ds.diagnosis_summary, ds.condition_at_discharge, ds.discharge_instructions, ds.follow_up
    FROM admissions a
    JOIN discharge_summaries ds ON ds.admission_id = a.id
    WHERE a.patient_id = ? AND a.status = 'discharged'
    ORDER BY a.discharged_at DESC
  `).all(patient.id);
  if (!rows.length) return sendError(res, 404, 'No completed discharge summary found for this patient — a doctor must write and save one, and administrative discharge must be processed, before a certificate can be issued.');
  return sendJSON(res, 200, { patient, admissions: rows });
}));

module.exports = router;
