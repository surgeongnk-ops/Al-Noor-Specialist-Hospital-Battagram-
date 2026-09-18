// auth.js — password hashing + JWT-based session authentication.
//
// JWT implementation note: this hand-rolls standard HS256 JWTs using only
// node:crypto — no `jsonwebtoken` package — because this server must keep running
// on a hospital PC that may never see `npm install` again after initial setup. The
// token format is completely standard (inspect it on jwt.io, it decodes normally).
//
// The one deliberate deviation from "pure" stateless JWT: every token's `jti` must
// also exist in the `sessions` table, so an admin disabling a staff account revokes
// that person's active session immediately — a pure stateless JWT can't do that
// (it would stay valid until it naturally expires), which is not acceptable for a
// hospital access-control system.

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { db } = require('./db');

const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours, matches the previous cookie Max-Age

// ---------- JWT signing secret ----------
// Generated once and persisted to disk so sessions survive a server restart.
const SECRET_PATH = path.join(__dirname, 'data', '.jwt_secret');
function loadOrCreateSecret() {
  try {
    return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(48).toString('hex');
    fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
    fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
    return secret;
  }
}
const JWT_SECRET = loadOrCreateSecret();

// ---------- base64url helpers ----------
function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  while (input.length % 4) input += '=';
  return Buffer.from(input, 'base64').toString('utf8');
}

// ---------- JWT sign / verify (HS256) ----------
function signJWT(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerPart = b64url(JSON.stringify(header));
  const payloadPart = b64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${headerPart}.${payloadPart}`).digest();
  const sigPart = b64url(signature);
  return `${headerPart}.${payloadPart}.${sigPart}`;
}

function verifyJWT(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, sigPart] = parts;
  const expectedSig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${headerPart}.${payloadPart}`).digest());
  const a = Buffer.from(sigPart);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(payloadPart)); } catch { return null; }
  if (typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) >= payload.exp) return null;
  return payload;
}

// ---------- Password hashing (scrypt, built into Node) ----------
// New/changed passwords use a stronger cost factor than the Node default. Existing
// hashes keep whatever cost they were created with (stored per-row in
// staff.password_cost_n) so upgrading this file never invalidates existing accounts.
const CURRENT_SCRYPT_N = 65536; // ~4x the Node default (16384); tuned for a login-only hot path

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex'), costN = CURRENT_SCRYPT_N) {
  const hash = crypto.scryptSync(password, salt, 64, { N: costN, maxmem: 128 * 1024 * 1024 }).toString('hex');
  return { hash, salt, costN };
}

function verifyPassword(password, salt, hash, costN = CURRENT_SCRYPT_N) {
  const check = crypto.scryptSync(password, salt, 64, { N: costN, maxmem: 128 * 1024 * 1024 }).toString('hex');
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Sessions (JWT + server-side revocation list) ----------
function createSession(staffId) {
  const jti = crypto.randomBytes(24).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const exp = now + SESSION_TTL_SECONDS;
  const expiresAtIso = new Date(exp * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, staff_id, expires_at) VALUES (?, ?, ?)').run(jti, staffId, expiresAtIso);
  return signJWT({ sub: staffId, jti, iat: now, exp });
}

function getStaffFromToken(token) {
  const payload = verifyJWT(token);
  if (!payload || !payload.jti) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(payload.jti);
  if (!session) return null; // revoked (logged out, or staff account disabled and session purged)
  if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(payload.jti);
    return null;
  }
  const staff = db.prepare('SELECT staff_id, name, role, active FROM staff WHERE staff_id = ?').get(session.staff_id);
  if (!staff || !staff.active) return null;
  return staff;
}

function destroySession(token) {
  const payload = verifyJWT(token);
  if (payload && payload.jti) db.prepare('DELETE FROM sessions WHERE token = ?').run(payload.jti);
}

// Revokes every active session for a staff member — called when an admin disables
// an account, so access is cut immediately rather than waiting for token expiry.
function revokeAllSessionsForStaff(staffId) {
  db.prepare('DELETE FROM sessions WHERE staff_id = ?').run(staffId);
}

// Housekeeping: drop expired session rows. Cheap, safe to call periodically.
function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run();
}

function changePassword(staffId, newPassword) {
  const { hash, salt, costN } = hashPassword(newPassword);
  db.prepare('UPDATE staff SET password_hash = ?, salt = ?, password_cost_n = ? WHERE staff_id = ?')
    .run(hash, salt, costN, staffId);
}

module.exports = {
  hashPassword, verifyPassword, changePassword,
  createSession, getStaffFromToken, destroySession, revokeAllSessionsForStaff, purgeExpiredSessions,
  signJWT, verifyJWT
};
