// routes/procedures.routes.js — Operation Room procedure scheduling
const { createRouter } = require('../router');
const { db } = require('../db');
const { sendJSON, sendError, readBody, requireAuth, asyncHandler, receiptNo } = require('../middleware');

const router = createRouter();

router.get('/api/procedures', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['or_manager', 'doctor', 'admin']); if (!staff) return;
  const status = url.searchParams.get('status') || 'scheduled';
  const rows = db.prepare(`
    SELECT pr.*, pt.mr_number, pt.name AS patient_name
    FROM procedures pr JOIN patients pt ON pt.id = pr.patient_id
    WHERE pr.status = ? ORDER BY pr.scheduled_at ASC
  `).all(status);
  return sendJSON(res, 200, rows);
}));

router.post('/api/procedures', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['or_manager', 'doctor', 'admin']); if (!staff) return;
  const { mr_number, procedure_type, surgeon, scheduled_at, room, notes } = await readBody(req);
  const patient = db.prepare('SELECT * FROM patients WHERE mr_number = ?').get(mr_number || '');
  if (!patient) return sendError(res, 404, 'Patient not found');
  if (!procedure_type) return sendError(res, 400, 'Procedure type required');
  db.prepare('INSERT INTO procedures (patient_id, procedure_type, surgeon, scheduled_at, room, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(patient.id, procedure_type, surgeon || '', scheduled_at || '', room || '', notes || '', staff.staff_id);
  return sendJSON(res, 200, { ok: true });
}));

router.post(/^\/api\/procedures\/(\d+)\/complete$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['or_manager', 'admin']); if (!staff) return;
  const procId = Number(match[1]);
  const proc = db.prepare('SELECT * FROM procedures WHERE id = ?').get(procId);
  if (!proc) return sendError(res, 404, 'Procedure not found');
  if (proc.status !== 'scheduled') return sendError(res, 400, `This procedure is already ${proc.status} — cannot complete it again`);
  const { charge_amount } = await readBody(req);
  const receipt = receiptNo();
  // Status-guarded so two near-simultaneous "complete" clicks can't both
  // succeed and generate two receipts (double billing) for one procedure.
  const result = db.prepare(`UPDATE procedures SET status = 'completed', charge_amount = ?, receipt_no = ?, completed_by = ?, completed_at = datetime('now') WHERE id = ? AND status = 'scheduled'`)
    .run(Number(charge_amount) || 0, receipt, staff.staff_id, procId);
  if (result.changes === 0) return sendError(res, 400, `This procedure is already ${db.prepare('SELECT status FROM procedures WHERE id = ?').get(procId).status} — cannot complete it again`);
  return sendJSON(res, 200, { ok: true, receipt_no: receipt });
}));

router.post(/^\/api\/procedures\/(\d+)\/cancel$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['or_manager', 'admin']); if (!staff) return;
  const procId = Number(match[1]);
  const proc = db.prepare('SELECT * FROM procedures WHERE id = ?').get(procId);
  if (!proc) return sendError(res, 404, 'Procedure not found');
  if (proc.status !== 'scheduled') return sendError(res, 400, `This procedure is already ${proc.status} — only a scheduled procedure can be cancelled`);
  db.prepare("UPDATE procedures SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'").run(procId);
  return sendJSON(res, 200, { ok: true });
}));

module.exports = router;
