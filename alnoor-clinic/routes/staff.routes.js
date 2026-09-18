// routes/staff.routes.js — staff account management (admin only)
const { createRouter } = require('../router');
const { db, logAudit } = require('../db');
const { hashPassword, revokeAllSessionsForStaff } = require('../auth');
const { sendJSON, sendError, readBody, requireAuth, validateBody, asyncHandler } = require('../middleware');

const router = createRouter();
const VALID_ROLES = ['admin', 'reception', 'doctor', 'lab', 'pharmacy', 'radiographer', 'or_manager', 'nurse', 'phlebotomist', 'pathologist'];

router.get('/api/staff', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const rows = db.prepare('SELECT staff_id, name, role, active, created_at FROM staff ORDER BY created_at DESC').all();
  return sendJSON(res, 200, rows);
}));

router.post('/api/staff', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const body = await readBody(req);
  const err = validateBody(body, {
    staff_id: { required: true, type: 'string' },
    name: { required: true, type: 'string' },
    role: { required: true, type: 'string', enum: VALID_ROLES },
    password: { required: true, type: 'string', minLength: 6 }
  });
  if (err) return sendError(res, 400, err);
  const { hash, salt, costN } = hashPassword(body.password);
  try {
    db.prepare('INSERT INTO staff (staff_id, name, role, password_hash, salt, password_cost_n) VALUES (?, ?, ?, ?, ?, ?)')
      .run(body.staff_id, body.name, body.role, hash, salt, costN);
  } catch (e) { return sendError(res, 400, 'Staff ID already exists'); }
  return sendJSON(res, 200, { ok: true });
}));

router.post(/^\/api\/staff\/([^/]+)\/toggle$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const target = db.prepare('SELECT * FROM staff WHERE staff_id = ?').get(match[1]);
  if (!target) return sendError(res, 404, 'Not found');
  const newActive = target.active ? 0 : 1;
  db.prepare('UPDATE staff SET active = ? WHERE staff_id = ?').run(newActive, target.staff_id);
  if (newActive === 0) revokeAllSessionsForStaff(target.staff_id);
  return sendJSON(res, 200, { ok: true });
}));

// Permanent removal — separate from /toggle above, which just blocks login while
// keeping the account (and its login history) on file. This actually deletes the
// row. No FK constraint anywhere in the schema points at staff.staff_id — every
// other table that records who did something (dispensed_by, entered_by,
// ordered_by, audit_log.staff_id, etc.) stores it as a plain text label, not a
// foreign key — so deleting an account never breaks or cascades into past
// receipts, orders, or the audit log; those keep showing the old staff_id as a
// historical label, exactly like a retired test name still shows correctly on
// old lab reports.
router.del(/^\/api\/staff\/([^/]+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const targetId = decodeURIComponent(match[1]);
  const target = db.prepare('SELECT * FROM staff WHERE staff_id = ?').get(targetId);
  if (!target) return sendError(res, 404, 'Not found');

  if (target.staff_id === staff.staff_id) {
    return sendError(res, 400, 'You cannot delete the account you are currently logged in as');
  }
  if (target.role === 'admin') {
    const otherAdmins = db.prepare(`SELECT COUNT(*) AS c FROM staff WHERE role = 'admin' AND staff_id != ?`).get(target.staff_id).c;
    if (otherAdmins === 0) return sendError(res, 400, 'Cannot delete the last remaining admin account');
  }

  revokeAllSessionsForStaff(target.staff_id);
  db.prepare('DELETE FROM staff WHERE staff_id = ?').run(target.staff_id);
  logAudit(staff.staff_id, 'staff_deleted', null, `${target.staff_id} (${target.name}, ${target.role})`);
  return sendJSON(res, 200, { ok: true });
}));

module.exports = router;
