// refRanges.js — age/sex-stratified reference range resolution for lab tests.
//
// tests_master carries one default reference range per test (or per panel
// component). Some tests are clinically meaningless without stratifying that
// range further — FSH reads completely differently pre- vs post-menopause,
// TSH differs pediatric vs adult, etc. test_reference_ranges (migration v13)
// holds those additional, more specific bands; this module picks the single
// best-matching band for a given patient, falling back to the test's own
// base range when no stratified band applies (so every existing test keeps
// working exactly as before until an admin explicitly adds bands for it).
//
// Resolution happens once, at result-entry time, and the resolved range is
// baked into the stored result row (normal_range) — a later change to the
// stratification table must never silently rewrite an already-issued report.
const { db } = require('./db');

// Accepts free-text age ("34", "34y", "5 months", "45 Yrs", "3d") as typed at
// reception and returns a best-effort age in years, or null if unparseable —
// null age matches any age band ('ANY'-width resolution below).
function parseAgeYears(ageText) {
  if (ageText == null) return null;
  const s = String(ageText).trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/([\d.]+)\s*(y|yr|yrs|year|years|m|mo|mos|month|months|d|day|days)?/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (Number.isNaN(num)) return null;
  const unit = m[2] || 'y';
  if (unit.startsWith('m')) return num / 12;
  if (unit.startsWith('d')) return num / 365;
  return num;
}

// Reception's gender field is free-select text ("Male"/"Female"/"Other"/"") —
// normalize to the 'M'/'F'/'ANY' vocabulary test_reference_ranges uses.
function normalizeSex(genderText) {
  const g = String(genderText || '').trim().toLowerCase();
  if (g.startsWith('m')) return 'M';
  if (g.startsWith('f')) return 'F';
  return 'ANY';
}

// Returns every stratified band that COULD apply (before narrowing by this
// patient's age/sex) — used by the admin management UI to show what's defined
// for a test regardless of who's viewing it.
function listRangesForTest(testName) {
  return db.prepare('SELECT * FROM test_reference_ranges WHERE test_name = ? ORDER BY component_name IS NOT NULL, component_name, sex, age_min_years').all(testName);
}

// Picks the single best-matching band for (testName, componentName, sex, ageYears),
// or null if none is defined / none matches. componentName is null for a
// non-panel test's own range.
function findStratifiedRange(testName, componentName, sex, ageYears) {
  const rows = componentName == null
    ? db.prepare('SELECT * FROM test_reference_ranges WHERE test_name = ? AND component_name IS NULL').all(testName)
    : db.prepare('SELECT * FROM test_reference_ranges WHERE test_name = ? AND component_name = ?').all(testName, componentName);
  if (!rows.length) return null;
  const candidates = rows.filter(r => {
    const sexOk = r.sex === 'ANY' || r.sex === sex;
    const ageOk = ageYears == null ? true : (ageYears >= r.age_min_years && ageYears <= r.age_max_years);
    return sexOk && ageOk;
  });
  if (!candidates.length) return null;
  // Most specific match wins: an exact sex match beats an ANY-sex band; among
  // equally sex-specific bands, the narrowest age window wins (e.g. a 10-year
  // "post-menopausal" band beats a 0-150 "adult female" catch-all).
  candidates.sort((a, b) => {
    const aSex = a.sex === 'ANY' ? 0 : 1;
    const bSex = b.sex === 'ANY' ? 0 : 1;
    if (aSex !== bSex) return bSex - aSex;
    return (a.age_max_years - a.age_min_years) - (b.age_max_years - b.age_min_years);
  });
  return candidates[0];
}

// Resolves the effective range for one printed/entered result line. `base` is
// the test's (or component's) own tests_master-level {unit, ref_low, ref_high,
// ref_text} — the fallback when no stratified band matches.
function resolveReferenceRange({ testName, componentName = null, sex, ageText, base }) {
  const ageYears = parseAgeYears(ageText);
  const sexCode = normalizeSex(sex);
  const stratified = findStratifiedRange(testName, componentName, sexCode, ageYears);
  if (stratified) {
    return {
      unit: stratified.unit != null && stratified.unit !== '' ? stratified.unit : ((base && base.unit) || null),
      ref_low: stratified.ref_low,
      ref_high: stratified.ref_high,
      ref_text: stratified.ref_text,
      label: stratified.label || null,
      source: 'stratified'
    };
  }
  return {
    unit: (base && base.unit) || null,
    ref_low: base ? base.ref_low : null,
    ref_high: base ? base.ref_high : null,
    ref_text: base ? base.ref_text : null,
    label: null,
    source: 'base'
  };
}

module.exports = { parseAgeYears, normalizeSex, findStratifiedRange, listRangesForTest, resolveReferenceRange };
