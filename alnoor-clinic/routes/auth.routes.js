// routes/auth.routes.js — login/logout/session/password
const { createRouter } = require('../router');
const { db, logAudit } = require('../db');
const { verifyPassword, createSession, getStaffFromToken, destroySession, changePassword } = require('../auth');
const { sendJSON, sendError, readBody, requireAuth, validateBody, asyncHandler, parseCookies } = require('../middleware');

const router = createRouter();

// ---------- Login brute-force throttle ----------
// In-memory only (resets on restart) — deliberately not persisted, matching the
// zero-new-dependencies / no-extra-schema-churn constraint this codebase holds
// throughout. Keyed by staff_id (not IP): the LAN this runs on typically NATs
// every station behind one router IP, so an IP-based limit would lock out the
// whole hospital after a few failed logins from any single workstation.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const failedLogins = new Map(); // staff_id -> { count, lockedUntil }

function checkLoginThrottle(staffId) {
  const entry = failedLogins.get(staffId);
  if (!entry) return { locked: false };
  if (entry.lockedUntil && entry.lockedUntil > Date.now()) {
    return { locked: true, retryAfterSeconds: Math.ceil((entry.lockedUntil - Date.now()) / 1000) };
  }
  if (entry.lockedUntil && entry.lockedUntil <= Date.now()) failedLogins.delete(staffId);
  return { locked: false };
}
function recordFailedLogin(staffId) {
  const entry = failedLogins.get(staffId) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
  failedLogins.set(staffId, entry);
}
function clearFailedLogins(staffId) {
  failedLogins.delete(staffId);
}

router.post('/api/login', asyncHandler(async (req, res) => {
  const body = await readBody(req);
  const err = validateBody(body, { staff_id: { required: true, type: 'string' }, password: { required: true, type: 'string' } });
  if (err) return sendError(res, 400, err);

  const throttle = checkLoginThrottle(body.staff_id);
  if (throttle.locked) {
    return sendError(res, 429, `Too many failed login attempts for this account. Try again in ${Math.ceil(throttle.retryAfterSeconds / 60)} minute(s).`);
  }

  const staff = db.prepare('SELECT * FROM staff WHERE staff_id = ?').get(body.staff_id);
  if (!staff || !staff.active || !verifyPassword(body.password, staff.salt, staff.password_hash, staff.password_cost_n)) {
    recordFailedLogin(body.staff_id);
    return sendError(res, 401, 'Invalid staff ID or password');
  }
  clearFailedLogins(body.staff_id);
  const token = createSession(staff.staff_id);
  logAudit(staff.staff_id, 'login', null, null);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=43200`);
  return sendJSON(res, 200, { staff_id: staff.staff_id, name: staff.name, role: staff.role });
}));

router.post('/api/logout', asyncHandler(async (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.session) destroySession(cookies.session);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
  return sendJSON(res, 200, { ok: true });
}));

router.get('/api/me', asyncHandler(async (req, res) => {
  const cookies = parseCookies(req);
  const staff = getStaffFromToken(cookies.session);
  if (!staff) return sendError(res, 401, 'Not logged in');
  return sendJSON(res, 200, staff);
}));

router.post('/api/me/password', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, null); if (!staff) return;
  const body = await readBody(req);
  const err = validateBody(body, { new_password: { required: true, type: 'string', minLength: 6 } });
  if (err) return sendError(res, 400, err);
  const full = db.prepare('SELECT * FROM staff WHERE staff_id = ?').get(staff.staff_id);
  if (!verifyPassword(body.old_password || '', full.salt, full.password_hash, full.password_cost_n)) {
    return sendError(res, 401, 'Current password is incorrect');
  }
  changePassword(staff.staff_id, body.new_password);
  return sendJSON(res, 200, { ok: true });
}));

module.exports = router;
