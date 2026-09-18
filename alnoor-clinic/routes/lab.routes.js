// routes/lab.routes.js — Laboratory Management System
//
// Upfront-payment-gate workflow (ISO 15189-aligned): a lab order moves through
// one strict, sequential status pipeline, and every transition endpoint checks
// the order is EXACTLY at the status it expects — nothing can be skipped:
//
//   PENDING_PAYMENT -> PAID -> SAMPLE_COLLECTED -> IN_PROCESS
//                    -> RESULT_ENTERED -> VERIFIED -> DELIVERED
//   (PENDING_PAYMENT -> CANCELLED is the only exit before payment)
//
// The price is locked the moment an order is CREATED (not at results entry,
// as the old flow did) — that locked payment_amount is exactly what the
// patient pays before anything else happens, and it can only change while
// still PENDING_PAYMENT. Once PAID, there is no cancel/refund path in this
// system: consumables, technician time, and analyzer runs are committed the
// moment payment clears, whether or not the patient ever returns for the
// report. A phlebotomist or lab tech literally cannot touch a specimen for
// an order that isn't PAID yet — requireAuth's role check plus the strict
// status check together enforce that at the API layer, not just in the UI.
const { createRouter } = require('../router');
const { db, nextCounter } = require('../db');
const { sendJSON, sendError, readBody, requireAuth, validateBody, asyncHandler, receiptNo } = require('../middleware');
const { computeLockedTestTotal } = require('./catalog.routes');

const router = createRouter();

const STATUSES = ['PENDING_PAYMENT', 'PAID', 'SAMPLE_COLLECTED', 'IN_PROCESS', 'RESULT_ENTERED', 'VERIFIED', 'DELIVERED', 'CANCELLED'];

// Daily-resetting temporary ID for unregistered walk-ins: WALK-LAB-YYYYMMDD-XXX,
// where XXX restarts at 001 each day (a fresh counter name per date).
function generateWalkInId() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return nextCounter(`walkin_lab_${dateStr}`, `WALK-LAB-${dateStr}-`, 3);
}

// Specimen/tube barcode ID — generated the moment payment clears (never
// before), so the physical label a phlebotomist prints and sticks on the tube
// can only ever exist for an already-paid order. SPEC-YYYYMMDD-NNNNN.
function generateSpecimenId() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return nextCounter(`specimen_${dateStr}`, `SPEC-${dateStr}-`, 5);
}

// ---- Report verification (QR code target) ----
// Every printed report page carries a QR encoding a link back to this lookup.
// Deliberately requires staff login (same as everything else here) and works
// entirely over the hospital's own LAN — no internet dependency, consistent
// with this whole system's offline-first design. Confirms the receipt and
// specimen ID actually correspond to a genuine, on-file order for that test,
// catching an altered or photocopied report.
router.get('/api/lab/verify', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, null); if (!staff) return;
  const receipt = url.searchParams.get('receipt') || '';
  const specimen = url.searchParams.get('specimen') || '';
  const testName = url.searchParams.get('test') || '';
  if (!receipt) return sendError(res, 400, 'receipt is required');
  const order = db.prepare(`
    SELECT lo.*, pt.name AS patient_name, pt.mr_number
    FROM lab_orders lo JOIN patients pt ON pt.id = lo.patient_id
    WHERE lo.receipt_no = ?
  `).get(receipt);
  if (!order) return sendJSON(res, 200, { valid: false, reason: 'No order found for this receipt number' });
  if (specimen && order.specimen_id !== specimen) {
    return sendJSON(res, 200, { valid: false, reason: 'Specimen ID does not match this receipt' });
  }
  const tests = JSON.parse(order.tests);
  if (testName && !tests.includes(testName)) {
    return sendJSON(res, 200, { valid: false, reason: 'This test is not part of the order for this receipt' });
  }
  return sendJSON(res, 200, {
    valid: true,
    patient_name: order.patient_name,
    mr_number: order.mr_number,
    tests,
    status: order.status,
    receipt_no: order.receipt_no,
    specimen_id: order.specimen_id,
    paid_at: order.paid_at,
    entered_by: order.entered_by,
    verified_by: order.verified_by,
    verified_at: order.verified_at,
    delivered_by: order.delivered_by,
    delivered_at: order.delivered_at
  });
}));

router.get('/api/lab/orders', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['lab', 'admin', 'phlebotomist', 'pathologist']); if (!staff) return;
  // ?id=123 looks up one specific order regardless of its current status —
  // used by the Analyzer Inbox's "Import" action, which needs the full order
  // record (patient, tests, locked total) for whatever status it's actually
  // in right now, not just one particular queue.
  const id = url.searchParams.get('id');
  const status = url.searchParams.get('status') || 'PENDING_PAYMENT';
  const rows = (id
    ? db.prepare(`
        SELECT lo.*, pt.mr_number, pt.name AS patient_name, pt.age, pt.gender, pt.patient_type
        FROM lab_orders lo JOIN patients pt ON pt.id = lo.patient_id
        WHERE lo.id = ?
      `).all(Number(id))
    : db.prepare(`
        SELECT lo.*, pt.mr_number, pt.name AS patient_name, pt.age, pt.gender, pt.patient_type
        FROM lab_orders lo JOIN patients pt ON pt.id = lo.patient_id
        WHERE lo.status = ? ORDER BY lo.created_at ASC
      `).all(status)
  ).map(o => {
    const tests = JSON.parse(o.tests);
    // payment_amount is locked at creation time now, so it's always already the
    // authoritative total for this order — no live re-pricing needed here.
    return { ...o, tests, results: o.results ? JSON.parse(o.results) : null, locked_total: o.payment_amount };
  });
  return sendJSON(res, 200, rows);
}));

// ---- Completed order search & re-print ----
// A finalized order is never deleted or hidden — this is how staff reopen it
// later to reprint the Payment Receipt, the specimen label, or the Lab Report
// independently. Search by patient name, MR number / Walk-In Order ID, or date.
router.get('/api/lab/orders/completed', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['lab', 'admin', 'phlebotomist', 'pathologist']); if (!staff) return;
  const q = url.searchParams.get('q') || '';
  const date = url.searchParams.get('date') || '';
  const like = `%${q}%`;
  let sql = `
    SELECT lo.*, pt.mr_number, pt.name AS patient_name, pt.age, pt.gender, pt.patient_type
    FROM lab_orders lo JOIN patients pt ON pt.id = lo.patient_id
    WHERE lo.status = 'DELIVERED'
  `;
  const params = [];
  if (q) { sql += ' AND (pt.name LIKE ? OR pt.mr_number LIKE ?)'; params.push(like, like); }
  if (date) { sql += ' AND date(lo.paid_at) = ?'; params.push(date); }
  sql += ' ORDER BY lo.paid_at DESC LIMIT 100';
  const rows = db.prepare(sql).all(...params).map(o => ({ ...o, tests: JSON.parse(o.tests), results: o.results ? JSON.parse(o.results) : null }));
  return sendJSON(res, 200, rows);
}));

// ---- Tab 1: "Registered OPD/IPD Patient (MRN)" — walk-in test for a patient who
// already has a formal MR number, just without a doctor referral for this test. ----
router.post('/api/lab/walk-in', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['lab', 'admin']); if (!staff) return;
  const { mr_number, tests } = await readBody(req);
  if (!mr_number) return sendError(res, 400, 'MR number is required');
  if (!tests || !tests.length) return sendError(res, 400, 'No tests specified');
  const patient = db.prepare('SELECT * FROM patients WHERE mr_number = ?').get(mr_number);
  if (!patient) return sendError(res, 404, 'Patient not found — check the MR number');
  const priced = computeLockedTestTotal(tests);
  if (!priced.ok) return sendError(res, 400, `Cannot order — no price set for: ${priced.missing.join(', ')}. Ask an admin to set test pricing first.`);
  const visitId = db.prepare(`INSERT INTO visits (patient_id, reason, status, created_by) VALUES (?, 'Walk-in — Laboratory', 'closed', ?)`)
    .run(patient.id, staff.staff_id).lastInsertRowid;
  db.prepare(`INSERT INTO lab_orders (visit_id, patient_id, ordered_by, tests, order_source, status, payment_amount) VALUES (?, ?, ?, ?, 'walkin', 'PENDING_PAYMENT', ?)`)
    .run(visitId, patient.id, staff.staff_id, JSON.stringify(tests), priced.total);
  return sendJSON(res, 200, { ok: true, patient_name: patient.name, mr_number: patient.mr_number, payment_amount: priced.total });
}));

// ---- Tab 2: "Direct Walk-In Patient" — a patient with NO registration at all.
// No MR number, no reception visit. A temporary WALK-LAB-YYYYMMDD-XXX identifier
// is generated and the patient record is tagged patient_type='WALK_IN' so these
// are always clearly distinguishable from formally registered patients — in
// every list, receipt, and report they appear in from here on. ----
router.post('/api/lab/walk-in-unregistered', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['lab', 'admin']); if (!staff) return;
  const body = await readBody(req);
  const err = validateBody(body, { name: { required: true, type: 'string' } });
  if (err) return sendError(res, 400, err);
  if (!body.tests || !body.tests.length) return sendError(res, 400, 'No tests specified');
  const priced = computeLockedTestTotal(body.tests);
  if (!priced.ok) return sendError(res, 400, `Cannot order — no price set for: ${priced.missing.join(', ')}. Ask an admin to set test pricing first.`);

  const mr_number = generateWalkInId();
  const patientId = db.prepare(`
    INSERT INTO patients (mr_number, name, age, gender, phone, registered_by, patient_type)
    VALUES (?, ?, ?, ?, ?, ?, 'WALK_IN')
  `).run(mr_number, body.name, body.age || '', body.gender || '', body.phone || '', staff.staff_id).lastInsertRowid;

  const visitId = db.prepare(`INSERT INTO visits (patient_id, reason, status, created_by) VALUES (?, 'Direct Walk-In Lab Test', 'closed', ?)`)
    .run(patientId, staff.staff_id).lastInsertRowid;
  db.prepare(`INSERT INTO lab_orders (visit_id, patient_id, ordered_by, tests, order_source, status, payment_amount) VALUES (?, ?, ?, ?, 'walkin', 'PENDING_PAYMENT', ?)`)
    .run(visitId, patientId, staff.staff_id, JSON.stringify(body.tests), priced.total);

  return sendJSON(res, 200, { ok: true, mr_number, patient_name: body.name, payment_amount: priced.total });
}));

// ---- Partial test refusal / order modification ----
// Only possible before any money has changed hands — the moment an order is
// PAID, the tests it covers are exactly what was billed and cannot change.
router.put(/^\/api\/lab\/orders\/(\d+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'lab', 'admin']); if (!staff) return;
  const orderId = Number(match[1]);
  const { tests } = await readBody(req);
  if (!tests || !tests.length) return sendError(res, 400, 'At least one test must remain — use cancel to remove the whole order');
  const order = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(orderId);
  if (!order) return sendError(res, 404, 'Order not found');
  if (order.status !== 'PENDING_PAYMENT') return sendError(res, 400, 'Only an unpaid order can be modified — once paid, the billed tests are fixed');
  const priced = computeLockedTestTotal(tests);
  if (!priced.ok) return sendError(res, 400, `Cannot save — no price set for: ${priced.missing.join(', ')}. Ask an admin to set test pricing first.`);
  db.prepare('UPDATE lab_orders SET tests = ?, payment_amount = ? WHERE id = ?').run(JSON.stringify(tests), priced.total, orderId);
  return sendJSON(res, 200, { ok: true, payment_amount: priced.total });
}));

router.post(/^\/api\/lab\/orders\/(\d+)\/cancel$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'lab', 'admin']); if (!staff) return;
  const order = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(Number(match[1]));
  if (!order) return sendError(res, 404, 'Order not found');
  if (order.status !== 'PENDING_PAYMENT') return sendError(res, 400, 'Only an unpaid order can be cancelled — once paid, resources are already committed and there is no refund/cancellation path');
  const { reason } = await readBody(req).catch(() => ({}));
  db.prepare("UPDATE lab_orders SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?")
    .run(staff.staff_id, reason || null, order.id);
  return sendJSON(res, 200, { ok: true });
}));

// ---- Step 1: collect payment (PENDING_PAYMENT -> PAID) ----
// This is now the FIRST clinical/financial event on the order — before any
// specimen is touched. An official itemized receipt is generated immediately,
// and a specimen/tube barcode ID is minted in the same step so the physical
// label a phlebotomist prints can never predate payment.
router.post(/^\/api\/lab\/orders\/(\d+)\/collect-payment$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['reception', 'lab', 'admin']); if (!staff) return;
  const order = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(Number(match[1]));
  if (!order) return sendError(res, 404, 'Order not found');
  if (order.status !== 'PENDING_PAYMENT') return sendError(res, 400, 'This order is not awaiting payment');
  const receipt = receiptNo();
  const specimenId = generateSpecimenId();
  db.prepare(`UPDATE lab_orders SET status = 'PAID', receipt_no = ?, paid_at = datetime('now'), specimen_id = ? WHERE id = ?`)
    .run(receipt, specimenId, order.id);
  return sendJSON(res, 200, { ok: true, receipt_no: receipt, specimen_id: specimenId, payment_amount: order.payment_amount });
}));

// ---- Step 2: collect specimen (PAID -> SAMPLE_COLLECTED) ----
// Phlebotomist-only in spirit — a lab tech/admin can also do it for a small
// hospital with no dedicated phlebotomist on shift. If the UI passes the
// scanned specimen_id (barcode scan-to-confirm), it must match this exact
// order's label — catches a mixed-up tube before it ever reaches the bench.
router.post(/^\/api\/lab\/orders\/(\d+)\/collect-sample$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['phlebotomist', 'lab', 'admin']); if (!staff) return;
  const order = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(Number(match[1]));
  if (!order) return sendError(res, 404, 'Order not found');
  if (order.status !== 'PAID') return sendError(res, 400, 'Sample can only be collected for a paid order');
  const { specimen_id } = await readBody(req).catch(() => ({}));
  if (specimen_id && order.specimen_id && specimen_id !== order.specimen_id) {
    return sendError(res, 400, `Scanned label (${specimen_id}) does not match this order's specimen ID (${order.specimen_id})`);
  }
  db.prepare(`UPDATE lab_orders SET status = 'SAMPLE_COLLECTED', collected_by = ?, collected_at = datetime('now') WHERE id = ?`)
    .run(staff.staff_id, order.id);
  return sendJSON(res, 200, { ok: true });
}));

// ---- Step 3: start in-lab processing (SAMPLE_COLLECTED -> IN_PROCESS) ----
router.post(/^\/api\/lab\/orders\/(\d+)\/start-processing$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['lab', 'admin']); if (!staff) return;
  const order = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(Number(match[1]));
  if (!order) return sendError(res, 404, 'Order not found');
  if (order.status !== 'SAMPLE_COLLECTED') return sendError(res, 400, 'Processing can only start once the specimen has been collected');
  db.prepare(`UPDATE lab_orders SET status = 'IN_PROCESS', processing_started_by = ?, processing_started_at = datetime('now') WHERE id = ?`)
    .run(staff.staff_id, order.id);
  return sendJSON(res, 200, { ok: true });
}));

// ---- Step 4: enter results (IN_PROCESS -> RESULT_ENTERED) ----
// No payment or specimen logic here anymore — both already happened earlier
// in the pipeline. This step is pure result capture.
router.post(/^\/api\/lab\/orders\/(\d+)\/results$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['lab', 'admin']); if (!staff) return;
  const orderId = Number(match[1]);
  const { results } = await readBody(req);
  const order = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(orderId);
  if (!order) return sendError(res, 404, 'Order not found');
  if (order.status !== 'IN_PROCESS') return sendError(res, 400, 'Results can only be entered once the sample is marked as in-process');
  db.prepare(`UPDATE lab_orders SET status = 'RESULT_ENTERED', results = ?, entered_by = ?, completed_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(results || []), staff.staff_id, orderId);
  // Doctor-referred orders surface in the doctor's results-ready queue as soon as
  // results exist — clinical review is never blocked by pathologist verification
  // or report printing. Walk-in counter orders have no doctor attached.
  if (order.order_source === 'doctor') {
    const pendingLeft = db.prepare("SELECT COUNT(*) c FROM lab_orders WHERE visit_id = ? AND status = 'PENDING_PAYMENT'").get(order.visit_id).c;
    if (pendingLeft === 0) db.prepare("UPDATE visits SET status = 'with_doctor', results_ready = 1, results_ready_at = datetime('now') WHERE id = ?").run(order.visit_id);
  }
  return sendJSON(res, 200, { ok: true, status: 'RESULT_ENTERED' });
}));

// ---- Step 5: pathologist verification (RESULT_ENTERED -> VERIFIED) ----
// A distinct, mandatory sign-off gate before a report can ever be printed or
// handed to a patient — the "Pathologist Verified" stage from the report
// footer's Pathologist Signature line, enforced here, not just printed there.
router.post(/^\/api\/lab\/orders\/(\d+)\/verify$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['pathologist', 'admin']); if (!staff) return;
  const order = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(Number(match[1]));
  if (!order) return sendError(res, 404, 'Order not found');
  if (order.status !== 'RESULT_ENTERED') return sendError(res, 400, 'Only a result awaiting verification can be verified');
  db.prepare(`UPDATE lab_orders SET status = 'VERIFIED', verified_by = ?, verified_at = datetime('now') WHERE id = ?`)
    .run(staff.staff_id, order.id);
  return sendJSON(res, 200, { ok: true });
}));

// ---- Step 6: report printed / delivered (VERIFIED -> DELIVERED) ----
// The terminal state. The UI calls this right after the report is printed and
// handed over, so "completed orders" search/reprint only ever surfaces reports
// that were actually verified and issued, never a result sitting unverified.
router.post(/^\/api\/lab\/orders\/(\d+)\/deliver$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['reception', 'lab', 'admin', 'pathologist']); if (!staff) return;
  const order = db.prepare('SELECT * FROM lab_orders WHERE id = ?').get(Number(match[1]));
  if (!order) return sendError(res, 404, 'Order not found');
  if (order.status !== 'VERIFIED') return sendError(res, 400, 'Only a verified report can be marked delivered');
  db.prepare(`UPDATE lab_orders SET status = 'DELIVERED', delivered_by = ?, delivered_at = datetime('now') WHERE id = ?`)
    .run(staff.staff_id, order.id);
  return sendJSON(res, 200, { ok: true });
}));

module.exports = router;
module.exports.STATUSES = STATUSES;
