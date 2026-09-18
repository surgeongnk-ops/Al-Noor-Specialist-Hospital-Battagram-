// analyzers/ichromaBridge.js — folder-watch importer for the i-Chroma II
// point-of-care immunoassay reader.
//
// Unlike the other two analyzers, i-Chroma II has no documented open
// serial/network protocol for direct integration: its own user guide states
// that PC connectivity needs Boditech's own proprietary software, and does
// not document any export file format. Rather than reverse-engineer a closed
// USB protocol (which would be fragile and could break on any firmware/
// software update, with no vendor support to fall back on), this watches a
// folder for whatever delimited export file that software can produce
// (CSV/TSV/etc — most lab/POC vendor software can export "to file" even
// when it lacks a full LIS interface) and parses it generically.
//
// Setup requires a human step the software can't do on its own: once
// Boditech's PC software is installed and the analyzer connected, check its
// export / print-to-file / save-results settings, point them at a folder,
// and put that folder's path into this analyzer's config (Admin -> Analyzer
// Settings). If that software genuinely has no export option at all, this
// bridge has nothing to watch and i-Chroma II results stay on manual entry
// for now — ANALYZER-INTERFACING.md covers escalating that to Boditech/the
// local distributor for their actual host interface option.
//
// As with the other bridges, nothing parsed here is ever written directly
// into a patient's saved result — see analyzers/inbox.js.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { recordInboxEntry } = require('./inbox');

const ANALYZER_KEY = 'ichroma_ii';
const SPECIMEN_ID_RE = /SPEC-\d{8}-\d{5}/i;

function matchesPattern(filename, pattern) {
  if (!pattern || pattern === '*') return true;
  // Minimal glob: only "*" wildcards are supported (e.g. "*.csv", "result_*.txt") —
  // deliberately simple rather than pulling in a glob library.
  const re = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(filename);
}

function detectDelimiter(sampleLines) {
  const candidates = [',', '\t', ';', '|'];
  let best = ','; let bestScore = -1;
  for (const d of candidates) {
    const counts = sampleLines.map(l => l.split(d).length);
    if (counts.every(c => c === counts[0]) && counts[0] > 1) {
      const score = counts[0];
      if (score > bestScore) { bestScore = score; best = d; }
    }
  }
  return best;
}

const HEADER_KEYWORDS = {
  specimenId: ['specimen', 'sample id', 'sampleid', 'patient id', 'patientid', 'accession'],
  patientName: ['patient name', 'name'],
  testName: ['test', 'item', 'assay', 'parameter'],
  value: ['result', 'value', 'reading'],
  unit: ['unit', 'units'],
  refRange: ['reference', 'ref range', 'range', 'normal']
};

function guessColumnMap(headerRow) {
  const map = {};
  headerRow.forEach((h, idx) => {
    const norm = h.trim().toLowerCase();
    for (const [field, keywords] of Object.entries(HEADER_KEYWORDS)) {
      if (map[field] == null && keywords.some(k => norm.includes(k))) map[field] = idx;
    }
  });
  return map;
}

// Parses one export file's text into inbox-ready groups. `columnMap` (from
// analyzer_config, admin-editable) maps field -> either a header name or a
// zero-based column index; when empty, header names are guessed generically.
function parseFile(text, { delimiter = 'auto', hasHeaderRow = true, columnMap = {} } = {}) {
  const lines = text.split(/\r\n|\r|\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];
  const delim = delimiter === 'auto' ? detectDelimiter(lines.slice(0, Math.min(5, lines.length))) : delimiter;
  const rows = lines.map(l => l.split(delim).map(c => c.trim()));

  let header = null, dataRows = rows;
  if (hasHeaderRow) { header = rows[0]; dataRows = rows.slice(1); }

  const resolvedMap = Object.keys(columnMap).length > 0
    ? Object.fromEntries(Object.entries(columnMap).map(([field, ref]) => {
        if (typeof ref === 'number') return [field, ref];
        const idx = header ? header.findIndex(h => h.trim().toLowerCase() === String(ref).trim().toLowerCase()) : -1;
        return [field, idx];
      }))
    : (header ? guessColumnMap(header) : {});

  const col = (row, field) => {
    const idx = resolvedMap[field];
    return (idx != null && idx >= 0 && row[idx] != null) ? row[idx] : '';
  };

  // Group rows by specimen ID when a specimen/patient-id column was found
  // (one export file can contain more than one result, e.g. a batch export
  // or several parameters from one panel test); otherwise treat the whole
  // file as a single group.
  const groups = new Map();
  const fallbackKey = '__whole_file__';
  for (const row of dataRows) {
    const specimenCell = col(row, 'specimenId');
    const key = specimenCell || fallbackKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const haveValueColumn = resolvedMap.value != null && resolvedMap.value >= 0;

  return [...groups.entries()].map(([key, groupRows]) => {
    const results = groupRows.map(row => {
      if (haveValueColumn) {
        return {
          source_code: col(row, 'testName') || row.join(' '),
          source_name: col(row, 'testName') || row.join(' '),
          value: col(row, 'value'),
          unit: col(row, 'unit'),
          ref_range: col(row, 'refRange'),
          abnormal_flag: '',
          raw_line: row.join(delim)
        };
      }
      // No usable column mapping (no header, or a header we couldn't match) —
      // fall back to a positional guess: first non-numeric-looking token(s)
      // are the name, the first purely-numeric token after that is the
      // value, and whatever immediately follows it is the unit. Same
      // approximate spirit as microlabBridge's line tokenizer — always
      // reviewable, never trusted blind.
      const numericIdx = row.findIndex(t => /^-?\d+(\.\d+)?$/.test(t));
      const value = numericIdx === -1 ? '' : row[numericIdx];
      const unit = numericIdx !== -1 ? (row[numericIdx + 1] || '') : '';
      const nameTokens = numericIdx === -1 ? row : row.slice(0, numericIdx);
      return {
        source_code: nameTokens.join(' ').trim(),
        source_name: nameTokens.join(' ').trim(),
        value,
        unit,
        ref_range: '',
        abnormal_flag: '',
        raw_line: row.join(delim)
      };
    });
    const specimenFromRegex = key === fallbackKey ? (text.match(SPECIMEN_ID_RE) || [null])[0] : key;
    return {
      specimen_id_guess: specimenFromRegex ? String(specimenFromRegex).toUpperCase() : null,
      results
    };
  });
}

function waitForStableFile(filePath, cb) {
  // A file that just finished being written by another program can still be
  // mid-write when the watch event fires. Poll its size twice, 300ms apart;
  // only proceed once it stops changing, so a partially-written export never
  // gets parsed as if it were complete.
  let lastSize = -1;
  const check = () => {
    fs.stat(filePath, (err, stat) => {
      if (err) return; // file may have been moved/deleted already — skip silently
      if (stat.size === lastSize) return cb();
      lastSize = stat.size;
      setTimeout(check, 300);
    });
  };
  check();
}

function start(config, log) {
  const folder = config.watchFolder;
  if (!folder) {
    log('[ichroma] no watch folder configured yet — nothing to watch. Set one in Admin -> Analyzer Settings once Boditech\'s PC software\'s export location is known.');
    return { stop: () => Promise.resolve(), status: () => ({ listening: false, reason: 'not-configured' }) };
  }
  if (!fs.existsSync(folder)) {
    log(`[ichroma] configured watch folder does not exist: ${folder}`);
    return { stop: () => Promise.resolve(), status: () => ({ listening: false, reason: 'folder-missing' }) };
  }

  const processedDir = path.join(folder, '_imported');
  try { fs.mkdirSync(processedDir, { recursive: true }); } catch { /* best-effort */ }

  const processing = new Set(); // filenames currently being handled, to ignore duplicate fs events

  function handleFile(filename) {
    if (!matchesPattern(filename, config.filePattern || '*')) return;
    const filePath = path.join(folder, filename);
    if (processing.has(filePath)) return;
    if (!fs.existsSync(filePath)) return;
    processing.add(filePath);
    waitForStableFile(filePath, () => {
      try {
        const text = fs.readFileSync(filePath, 'utf8');
        const groups = parseFile(text, config);
        for (const parsed of groups) {
          const { id, matchStatus } = recordInboxEntry({
            analyzerKey: ANALYZER_KEY,
            rawPayload: text,
            parsed,
            specimenIdGuess: parsed.specimen_id_guess
          });
          log(`[ichroma] imported ${filename} -> inbox #${id} (${matchStatus}, ${parsed.results.length} result(s))`);
        }
        // Move rather than delete — keeps the original export file recoverable
        // if a mapping needs fixing and the file needs re-parsing later.
        const dest = path.join(processedDir, `${Date.now()}_${filename}`);
        fs.renameSync(filePath, dest);
      } catch (err) {
        log(`[ichroma] failed to process ${filename}: ${err.message}`);
      } finally {
        processing.delete(filePath);
      }
    });
  }

  // Pick up anything already sitting in the folder at startup (e.g. the
  // service restarted after the software exported a file).
  try { fs.readdirSync(folder).forEach(handleFile); } catch { /* best-effort */ }

  let watcher;
  try {
    watcher = fs.watch(folder, (eventType, filename) => { if (filename) handleFile(filename); });
  } catch (err) {
    log(`[ichroma] could not watch folder ${folder}: ${err.message}`);
    return { stop: () => Promise.resolve(), status: () => ({ listening: false, reason: 'watch-failed' }) };
  }

  log(`[ichroma] watching ${folder} for exported result files (pattern: ${config.filePattern || '*'})`);

  return {
    stop: () => { try { watcher.close(); } catch { /* already closed */ } return Promise.resolve(); },
    status: () => ({ listening: true, folder })
  };
}

module.exports = { start, ANALYZER_KEY, parseFile, detectDelimiter, guessColumnMap };
