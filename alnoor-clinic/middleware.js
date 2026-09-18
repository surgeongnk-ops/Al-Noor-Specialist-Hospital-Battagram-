// middleware.js — shared request helpers used by every route module.
// Centralizing these means every endpoint gets the same auth check, the same
// error-response shape, and the same input-validation behavior for free.

const { getStaffFromToken } = require('./auth');
const { nextCounter } = require('./db');

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

// Standard error shape used everywhere: { error: "message" }.
function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
    req.on('data', chunk => {
      if (settled) return; // already rejected (oversized) — ignore further chunks
      data += chunk;
      if (data.length > 5_000_000) {
        // Previously this called req.destroy() synchronously right here, which
        // (a) emits neither 'end' nor 'error' — the promise never settled, so
        // the client got no response at all and the connection just hung open
        // — and (b) even once fixed to reject explicitly, destroying the
        // socket immediately tears down the connection before the 413 response
        // below has actually been flushed to it, so the client still sees
        // nothing but a dropped connection. Reject now (so the route handler's
        // asyncHandler can write the 413 response), and only destroy the
        // socket on the next tick, after that write has had a chance to go
        // out — freeing the resource without swallowing our own response.
        finish(reject, new Error('PAYLOAD_TOO_LARGE'));
        data = '';
        setImmediate(() => req.destroy());
      }
    });
    req.on('end', () => {
      if (!data) return finish(resolve, {});
      try { finish(resolve, JSON.parse(data)); } catch (e) { finish(reject, new Error('Malformed JSON body')); }
    });
    req.on('error', err => finish(reject, err));
    req.on('aborted', () => finish(reject, new Error('Request aborted')));
  });
}

// RBAC gate. `roles: null` means "any authenticated staff member"; otherwise an
// array of allowed roles. Returns the authenticated staff row, or null after
// already sending the appropriate 401/403 — callers just do `if (!staff) return;`
function requireAuth(req, res, roles) {
  const cookies = parseCookies(req);
  const staff = getStaffFromToken(cookies.session);
  if (!staff) { sendError(res, 401, 'Not logged in'); return null; }
  if (roles && !roles.includes(staff.role)) { sendError(res, 403, 'Not authorized for this action'); return null; }
  return staff;
}

// ---------- Input validation ----------
// Minimal, dependency-free schema check. Each field maps to a rule set:
//   { required: true, type: 'string'|'number', minLength, min, max, enum: [...] }
function validateBody(body, schema) {
  for (const [field, rule] of Object.entries(schema)) {
    const value = body[field];
    const present = value !== undefined && value !== null && value !== '';
    if (rule.required && !present) return `"${field}" is required`;
    if (!present) continue;
    if (rule.type === 'number' && isNaN(Number(value))) return `"${field}" must be a number`;
    if (rule.type === 'string' && typeof value !== 'string') return `"${field}" must be text`;
    if (rule.minLength && String(value).length < rule.minLength) return `"${field}" must be at least ${rule.minLength} characters`;
    if (rule.min != null && Number(value) < rule.min) return `"${field}" must be at least ${rule.min}`;
    if (rule.max != null && Number(value) > rule.max) return `"${field}" must be at most ${rule.max}`;
    if (rule.enum && !rule.enum.includes(value)) return `"${field}" must be one of: ${rule.enum.join(', ')}`;
  }
  return null;
}

// Wraps a route handler so a thrown/rejected error becomes a clean JSON
// response instead of crashing the request (or, worse, the process). A
// malformed request body is the client's fault (400), not a server fault
// (500) — everything else that reaches here is treated as an unexpected
// server error and sanitized: the client gets a generic message, the real
// error (with stack trace) goes to the server log only, never to the response.
function asyncHandler(fn) {
  return async (req, res, ...rest) => {
    try {
      await fn(req, res, ...rest);
    } catch (err) {
      if (res.headersSent) return;
      if (err && err.message === 'Malformed JSON body') return sendError(res, 400, 'Malformed JSON in request body');
      if (err && err.message === 'PAYLOAD_TOO_LARGE') return sendError(res, 413, 'Request body too large (max 5MB)');
      if (err && (err.message === 'Request aborted' || err.code === 'ECONNRESET')) return; // client hung up — nothing to send back
      console.error('[route error]', err);
      sendError(res, 500, 'Server error');
    }
  };
}

// ---------- Static files ----------
const path = require('node:path');
const fs = require('node:fs');
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml'
};

function serveStatic(req, res, urlPath, publicDir) {
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(publicDir, filePath);
  if (!fullPath.startsWith(publicDir)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(fullPath, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- CSV export ----------
function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map(c => csvEscape(r[c])).join(','));
  return lines.join('\n');
}
function sendCSV(res, filename, rows) {
  const body = toCSV(rows);
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  res.end(body);
}

// ---------- Domain helpers shared across route modules ----------
function receiptNo() { return nextCounter('receipt', 'R-'); }

function expiryStatus(expiry_date) {
  if (!expiry_date) return 'ok';
  const days = (new Date(expiry_date) - new Date()) / 86400000;
  if (days < 0) return 'expired';
  if (days <= 30) return 'near_30';
  if (days <= 60) return 'near_60';
  return 'ok';
}

// Low-stock threshold: warn only when remaining stock is under 5 PACKS worth of
// units (or under 5 individual units for a loose item where units_per_pack=1).
// Deliberately separate from expiryStatus — a batch can be fresh but nearly out,
// or plentiful but expiring soon; these are two different warnings.
const LOW_STOCK_PACK_THRESHOLD = 5;
function isLowStock(quantityRemaining, unitsPerPack) {
  const perPack = Math.max(1, Number(unitsPerPack) || 1);
  return Number(quantityRemaining) < LOW_STOCK_PACK_THRESHOLD * perPack;
}

module.exports = {
  parseCookies, sendJSON, sendError, readBody, requireAuth, validateBody, asyncHandler,
  serveStatic, csvEscape, toCSV, sendCSV, receiptNo, expiryStatus, isLowStock
};
