// routes/radiology.routes.js
const { createRouter } = require('../router');
const { db } = require('../db');
const { sendJSON, sendError, readBody, requireAuth, asyncHandler, receiptNo } = require('../middleware');
const { computeLockedTestTotal } = require('./catalog.routes');

const router = createRouter();

router.get('/api/radiology/orders', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['radiographer', 'admin']); if (!staff) return;
  const status = url.searchParams.get('status') || 'pending';
  const rows = db.prepare(`
    SELECT ro.*, pt.mr_number, pt.name AS patient_name, pt.age, pt.gender
    FROM radiology_orders ro JOIN patients pt ON pt.id = ro.patient_id
    WHERE ro.status = ? ORDER BY ro.created_at ASC
  `).all(status).map(o => {
    const tests = JSON.parse(o.tests);
    const priced = computeLockedTestTotal(tests);
    return { ...o, tests, results: o.results ? JSON.parse(o.results) : null, locked_total: priced.total, missing_prices: priced.missing };
  });
  return sendJSON(res, 200, rows);
}));

router.post('/api/radiology/walk-in', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['radiographer', 'admin']); if (!staff) return;
  const { mr_number, tests } = await readBody(req);
  if (!mr_number) return sendError(res, 400, 'MR number is required');
  if (!tests || !tests.length) return sendError(res, 400, 'No tests specified');
  const patient = db.prepare('SELECT * FROM patients WHERE mr_number = ?').get(mr_number);
  if (!patient) return sendError(res, 404, 'Patient not found — check the MR number');
  const visitId = db.prepare(`INSERT INTO visits (patient_id, reason, status, created_by) VALUES (?, 'Walk-in — Radiology', 'closed', ?)`)
    .run(patient.id, staff.staff_id).lastInsertRowid;
  db.prepare('INSERT INTO radiology_orders (visit_id, patient_id, ordered_by, tests, order_source) VALUES (?, ?, ?, ?, ?)')
    .run(visitId, patient.id, staff.staff_id, JSON.stringify(tests), 'walkin');
  return sendJSON(res, 200, { ok: true, patient_name: patient.name, mr_number: patient.mr_number });
}));

router.put(/^\/api\/radiology\/orders\/(\d+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'radiographer', 'admin']); if (!staff) return;
  const orderId = Number(match[1]);
  const { tests } = await readBody(req);
  if (!tests || !tests.length) return sendError(res, 400, 'At least one study must remain — use cancel to remove the whole order');
  const order = db.prepare('SELECT * FROM radiology_orders WHERE id = ?').get(orderId);
  if (!order) return sendError(res, 404, 'Order not found');
  if (order.status !== 'pending') return sendError(res, 400, 'Only a pending order (before findings are entered) can be modified');
  db.prepare('UPDATE radiology_orders SET tests = ? WHERE id = ?').run(JSON.stringify(tests), orderId);
  return sendJSON(res, 200, { ok: true });
}));

router.post(/^\/api\/radiology\/orders\/(\d+)\/cancel$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['doctor', 'radiographer', 'admin']); if (!staff) return;
  const order = db.prepare('SELECT * FROM radiology_orders WHERE id = ?').get(Number(match[1]));
  if (!order) return sendError(res, 404, 'Order not found');
  if (order.status !== 'pending') return sendError(res, 400, 'Only a pending order can be cancelled');
  db.prepare("UPDATE radiology_orders SET status = 'cancelled' WHERE id = ?").run(order.id);
  return sendJSON(res, 200, { ok: true });
}));

router.post(/^\/api\/radiology\/orders\/(\d+)\/results$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['radiographer', 'admin']); if (!staff) return;
  const orderId = Number(match[1]);
  const { results } = await readBody(req);
  const order = db.prepare('SELECT * FROM radiology_orders WHERE id = ?').get(orderId);
  if (!order) return sendError(res, 404, 'Order not found');
  const priced = computeLockedTestTotal(JSON.parse(order.tests));
  if (!priced.ok) {
    return sendError(res, 400, `Cannot finalize — no locked price set for: ${priced.missing.join(', ')}. Ask an admin to set pricing first.`);
  }
  db.prepare(`UPDATE radiology_orders SET status = 'awaiting_payment', results = ?, payment_amount = ?, entered_by = ?, completed_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(results || []), priced.total, staff.staff_id, orderId);
  if (order.order_source === 'doctor') {
    const order2 = db.prepare('SELECT * FROM radiology_orders WHERE id = ?').get(orderId);
    const pendingLabLeft = db.prepare("SELECT COUNT(*) c FROM lab_orders WHERE visit_id = ? AND status = 'pending'").get(order2.visit_id).c;
    const pendingRadLeft = db.prepare("SELECT COUNT(*) c FROM radiology_orders WHERE visit_id = ? AND status = 'pending'").get(order2.visit_id).c;
    if (pendingLabLeft === 0 && pendingRadLeft === 0) db.prepare("UPDATE visits SET status = 'with_doctor', results_ready = 1, results_ready_at = datetime('now') WHERE id = ?").run(order2.visit_id);
  }
  return sendJSON(res, 200, { ok: true, payment_amount: priced.total, status: 'awaiting_payment' });
}));

router.post(/^\/api\/radiology\/orders\/(\d+)\/collect-payment$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['reception', 'radiographer', 'admin']); if (!staff) return;
  const order = db.prepare('SELECT * FROM radiology_orders WHERE id = ?').get(Number(match[1]));
  if (!order) return sendError(res, 404, 'Order not found');
  if (order.status !== 'awaiting_payment') return sendError(res, 400, 'This order is not awaiting payment');
  const receipt = receiptNo();
  db.prepare(`UPDATE radiology_orders SET status = 'done', receipt_no = ?, paid_at = datetime('now') WHERE id = ?`)
    .run(receipt, order.id);
  return sendJSON(res, 200, { ok: true, receipt_no: receipt, payment_amount: order.payment_amount });
}));

module.exports = router;
