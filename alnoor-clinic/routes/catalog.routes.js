// routes/catalog.routes.js — drug/test autocomplete search, locked test pricing,
// and full admin CRUD for the lab test catalog.
const { createRouter } = require('../router');
const { db, logAudit } = require('../db');
const { sendJSON, sendError, readBody, requireAuth, validateBody, asyncHandler } = require('../middleware');
const { resolveReferenceRange, listRangesForTest } = require('../refRanges');

const router = createRouter();
const TEST_CATEGORIES = ['Hematology', 'Biochemistry', 'Special Chemistry', 'Immunology', 'Serology', 'Endocrinology', 'Radiology'];

router.get('/api/drugs/search', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, null); if (!staff) return;
  const q = `%${url.searchParams.get('q') || ''}%`;
  const rows = db.prepare('SELECT name, category, default_unit FROM drugs_master WHERE active = 1 AND name LIKE ? ORDER BY name ASC LIMIT 20').all(q);
  return sendJSON(res, 200, rows);
}));

router.get('/api/tests/search', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, null); if (!staff) return;
  const q = `%${url.searchParams.get('q') || ''}%`;
  const category = url.searchParams.get('category');
  const rows = category
    ? db.prepare('SELECT name, category, unit, ref_low, ref_high, ref_text FROM tests_master WHERE active = 1 AND category = ? AND name LIKE ? ORDER BY name ASC LIMIT 30').all(category, q)
    : db.prepare('SELECT name, category, unit, ref_low, ref_high, ref_text FROM tests_master WHERE active = 1 AND name LIKE ? ORDER BY name ASC LIMIT 30').all(q);
  return sendJSON(res, 200, rows);
}));

// Admin-only listing that includes INACTIVE tests too (for the catalog
// management table). Registered before the generic /api/tests/:name lookup
// further down so "all" is never mistaken for a test name.
router.get('/api/tests/all', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const rows = db.prepare('SELECT * FROM tests_master ORDER BY category, name').all()
    .map(t => ({ ...t, components: t.components ? JSON.parse(t.components) : null }));
  return sendJSON(res, 200, rows);
}));

router.get('/api/tests', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, null); if (!staff) return;
  const rows = db.prepare('SELECT * FROM tests_master WHERE active = 1 ORDER BY category, name').all()
    .map(t => ({ ...t, components: t.components ? JSON.parse(t.components) : null }));
  return sendJSON(res, 200, rows);
}));

// ===== Age/sex-stratified reference ranges =====
// Resolution: given a patient's age/gender and a set of ordered tests, returns
// the effective range for each test (and each panel component) — a stratified
// band from test_reference_ranges if one matches, else the test's own base
// range from tests_master, completely unchanged from today. Called once when
// a lab tech opens an order for result entry; the resolved value is then
// baked into the stored result row, so it never silently drifts later if the
// stratification table is edited afterwards.
router.post('/api/reference-ranges/resolve', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, null); if (!staff) return;
  const { tests, age, gender } = await readBody(req);
  if (!Array.isArray(tests)) return sendError(res, 400, 'tests must be an array of test names');
  const out = {};
  for (const testName of tests) {
    const t = db.prepare('SELECT * FROM tests_master WHERE name = ?').get(testName);
    if (!t) continue;
    const components = t.components ? JSON.parse(t.components) : null;
    if (components) {
      out[testName] = {
        components: Object.fromEntries(components.map(c => [
          c.name,
          resolveReferenceRange({ testName, componentName: c.name, sex: gender, ageText: age, base: c })
        ]))
      };
    } else {
      out[testName] = resolveReferenceRange({ testName, componentName: null, sex: gender, ageText: age, base: t });
    }
  }
  return sendJSON(res, 200, out);
}));

// Admin management of stratified bands (e.g. FSH pre-/post-menopausal, pediatric
// vs adult TSH). Listing is open to any authenticated staff (result-entry and
// report screens may want to show what's defined); writes are admin-only.
router.get('/api/reference-ranges', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, null); if (!staff) return;
  const testName = url.searchParams.get('test');
  if (!testName) return sendError(res, 400, 'test query parameter required');
  return sendJSON(res, 200, listRangesForTest(testName));
}));

router.post('/api/reference-ranges', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const body = await readBody(req);
  const err = validateBody(body, {
    test_name: { required: true, type: 'string' },
    sex: { required: true, type: 'string', enum: ['M', 'F', 'ANY'] }
  });
  if (err) return sendError(res, 400, err);
  db.prepare(`
    INSERT INTO test_reference_ranges (test_name, component_name, sex, age_min_years, age_max_years, unit, ref_low, ref_high, ref_text, label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    body.test_name, body.component_name || null, body.sex,
    body.age_min_years !== '' && body.age_min_years != null ? Number(body.age_min_years) : 0,
    body.age_max_years !== '' && body.age_max_years != null ? Number(body.age_max_years) : 150,
    body.unit || null,
    body.ref_low !== '' && body.ref_low != null ? Number(body.ref_low) : null,
    body.ref_high !== '' && body.ref_high != null ? Number(body.ref_high) : null,
    body.ref_text || null, body.label || null
  );
  logAudit(staff.staff_id, 'reference_range_added', null, `${body.test_name}${body.component_name ? ' / ' + body.component_name : ''} (${body.sex}, ${body.age_min_years ?? 0}-${body.age_max_years ?? 150}y)`);
  return sendJSON(res, 200, { ok: true });
}));

router.del(/^\/api\/reference-ranges\/(\d+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const id = Number(match[1]);
  const row = db.prepare('SELECT * FROM test_reference_ranges WHERE id = ?').get(id);
  if (!row) return sendError(res, 404, 'Not found');
  db.prepare('DELETE FROM test_reference_ranges WHERE id = ?').run(id);
  logAudit(staff.staff_id, 'reference_range_removed', null, `${row.test_name}${row.component_name ? ' / ' + row.component_name : ''}`);
  return sendJSON(res, 200, { ok: true });
}));

// ===== Lab Test Catalog — full CRUD (admin only) =====
// New tests added here immediately show up everywhere else that reads from
// tests_master: doctor's lab-order autocomplete, the lab walk-in tab, and the
// radiology equivalent — there's no separate list to keep in sync.
router.post('/api/tests', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const body = await readBody(req);
  const err = validateBody(body, {
    name: { required: true, type: 'string' },
    category: { required: true, type: 'string', enum: TEST_CATEGORIES }
  });
  if (err) return sendError(res, 400, err);
  try {
    db.prepare(`
      INSERT INTO tests_master (name, category, unit, ref_low, ref_high, ref_text, default_price)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.name, body.category, body.unit || null,
      body.ref_low !== '' && body.ref_low != null ? Number(body.ref_low) : null,
      body.ref_high !== '' && body.ref_high != null ? Number(body.ref_high) : null,
      body.ref_text || null, Number(body.default_price) || 0
    );
  } catch (e) { return sendError(res, 400, 'A test with that name already exists'); }
  logAudit(staff.staff_id, 'test_catalog_created', null, `${body.name} (${body.category})`);
  return sendJSON(res, 200, { ok: true });
}));

// Test pricing is locked — only admin can set it. Registered BEFORE the generic
// /api/tests/:name GET route so it isn't shadowed.
router.put(/^\/api\/tests\/([^/]+)\/price$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const { price } = await readBody(req);
  if (price == null || Number(price) < 0) return sendError(res, 400, 'Valid price required');
  const name = decodeURIComponent(match[1]);
  const result = db.prepare('UPDATE tests_master SET default_price = ? WHERE name = ?').run(Number(price), name);
  if (result.changes === 0) return sendError(res, 404, 'Test not found');
  logAudit(staff.staff_id, 'set_test_price', null, `${name} -> Rs. ${price}`);
  return sendJSON(res, 200, { ok: true });
}));

router.put(/^\/api\/tests\/([^/]+)\/full$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const name = decodeURIComponent(match[1]);
  const existing = db.prepare('SELECT * FROM tests_master WHERE name = ?').get(name);
  if (!existing) return sendError(res, 404, 'Test not found');
  const body = await readBody(req);
  const updated = {
    category: body.category || existing.category,
    unit: body.unit ?? existing.unit,
    ref_low: body.ref_low !== undefined ? (body.ref_low === '' ? null : Number(body.ref_low)) : existing.ref_low,
    ref_high: body.ref_high !== undefined ? (body.ref_high === '' ? null : Number(body.ref_high)) : existing.ref_high,
    ref_text: body.ref_text ?? existing.ref_text,
    default_price: body.default_price != null ? Number(body.default_price) : existing.default_price
  };
  db.prepare(`
    UPDATE tests_master SET category=?, unit=?, ref_low=?, ref_high=?, ref_text=?, default_price=?
    WHERE name = ?
  `).run(updated.category, updated.unit, updated.ref_low, updated.ref_high, updated.ref_text, updated.default_price, name);
  logAudit(staff.staff_id, 'test_catalog_updated', null, name);
  return sendJSON(res, 200, { ok: true });
}));

// Reverses a retirement — a test taken out of service by mistake (or one the
// hospital resumes offering) goes back to active without re-entering all its
// reference ranges and pricing, which are untouched by retire/reactivate.
router.post(/^\/api\/tests\/([^/]+)\/activate$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const name = decodeURIComponent(match[1]);
  const result = db.prepare('UPDATE tests_master SET active = 1 WHERE name = ?').run(name);
  if (result.changes === 0) return sendError(res, 404, 'Test not found');
  logAudit(staff.staff_id, 'test_catalog_reactivated', null, name);
  return sendJSON(res, 200, { ok: true });
}));

// Soft delete — deactivates rather than hard-deletes, so historical lab/radiology
// orders that already reference this test name by JSON string keep working.
router.del(/^\/api\/tests\/([^/]+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const name = decodeURIComponent(match[1]);
  const result = db.prepare('UPDATE tests_master SET active = 0 WHERE name = ?').run(name);
  if (result.changes === 0) return sendError(res, 404, 'Test not found');
  logAudit(staff.staff_id, 'test_catalog_deactivated', null, name);
  return sendJSON(res, 200, { ok: true });
}));

router.get(/^\/api\/tests\/([^/]+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, null); if (!staff) return;
  const t = db.prepare('SELECT * FROM tests_master WHERE name = ?').get(decodeURIComponent(match[1]));
  if (!t) return sendError(res, 404, 'Test not found');
  return sendJSON(res, 200, { ...t, components: t.components ? JSON.parse(t.components) : null });
}));

// Shared helper (used by lab/radiology routes): computes the locked total for a
// set of test names from tests_master.default_price. Never trusts client input.
function computeLockedTestTotal(testNames) {
  let total = 0;
  const missing = [];
  for (const name of testNames) {
    const t = db.prepare('SELECT default_price FROM tests_master WHERE name = ?').get(name);
    if (!t || t.default_price == null || t.default_price <= 0) missing.push(name);
    else total += t.default_price;
  }
  return { ok: missing.length === 0, total, missing };
}

module.exports = router;
module.exports.computeLockedTestTotal = computeLockedTestTotal;
