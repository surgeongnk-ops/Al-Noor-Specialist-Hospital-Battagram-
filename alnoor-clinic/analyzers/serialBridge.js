// analyzers/serialBridge.js — generic Windows serial (COM port) bridge
// factory, shared by any analyzer whose exact RS-232 output format isn't
// confirmed. Currently used by both Microlab 300 and Swelab Alfa (the
// hospital's actual hematology unit — see the note in swelabBridge.js about
// why this replaced an earlier HL7/TCP-based implementation).
//
// Node has no built-in serial port support, and this whole system avoids
// npm dependencies (single hospital PC, unreliable internet — see db.js's
// header comment). The workaround: Windows ships PowerShell with the .NET
// System.IO.Ports.SerialPort class built in, so a small PowerShell script
// (serial-bridge.ps1) does the actual port I/O and streams raw bytes to
// this process via a spawned child process — zero extra installs, works
// out of the box on any Windows PC.
//
// If a connected analyzer turns out to actually speak classic ASTM E1394,
// the incoming byte stream will start with an ENQ (0x05) byte; that case is
// auto-detected and handed to astmTransport.js's spec-correct receiver
// instead of the generic best-effort line tokenizer below.

'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const astm = require('./astmTransport');
const { recordInboxEntry } = require('./inbox');

const SPECIMEN_ID_RE = /SPEC-\d{8}-\d{5}/i;

// Bundles rapid-fire lines from one printed report into a single inbox
// entry (an analyzer typically emits several lines back-to-back for one
// sample's panel of tests) rather than one inbox row per line. A short
// quiet period ends the bundle.
class LineBundler {
  constructor(onBundle, quietMs = 1200) {
    this.lines = [];
    this.onBundle = onBundle;
    this.quietMs = quietMs;
    this.timer = null;
  }
  addLine(line) {
    if (!line.trim()) return;
    this.lines.push(line);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.quietMs);
  }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.lines.length === 0) return;
    const bundle = this.lines;
    this.lines = [];
    this.onBundle(bundle);
  }
}

// Best-effort tokenizer: tries the delimiters commonly used by analyzer
// "printer emulation" serial output and keeps whichever split produces the
// most tokens. Deliberately approximate — refine against real captured
// output once available; every result still lands in the review inbox
// regardless of how well this guesses.
function tokenizeLine(line) {
  const candidates = [
    line.split('\t'),
    line.split(','),
    line.split('|'),
    line.trim().split(/\s{2,}/),
    line.trim().split(/\s+/)
  ].map(parts => parts.map(p => p.trim()).filter(Boolean));
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || [line.trim()];
}

const UNIT_RE = new RegExp('^[a-zA-Z%/*^0-9.µμ]+$');

function parseBundle(lines) {
  const fullText = lines.join('\n');
  const specimenMatch = fullText.match(SPECIMEN_ID_RE);
  const results = lines.map(line => {
    const tokens = tokenizeLine(line);
    const reversedIdx = [...tokens].reverse().findIndex(t => /^-?\d+(\.\d+)?$/.test(t));
    const valueIdx = reversedIdx === -1 ? -1 : tokens.length - 1 - reversedIdx;
    const value = valueIdx === -1 ? '' : tokens[valueIdx];
    const unit = (valueIdx !== -1 && tokens[valueIdx + 1] && UNIT_RE.test(tokens[valueIdx + 1])) ? tokens[valueIdx + 1] : '';
    const nameTokens = (valueIdx === -1 ? tokens : tokens.slice(0, valueIdx))
      .filter(t => !SPECIMEN_ID_RE.test(t)); // strip the specimen ID itself out of the guessed test name
    return {
      source_code: nameTokens.join(' ').trim(),
      source_name: nameTokens.join(' ').trim(),
      value,
      unit,
      ref_range: '',
      abnormal_flag: '',
      raw_line: line
    };
  });
  return {
    specimen_id_guess: specimenMatch ? specimenMatch[0].toUpperCase() : null,
    results
  };
}

// Parallel path for an analyzer that DOES turn out to speak classic ASTM
// (auto-detected from a leading ENQ byte) — reuses the spec-correct
// astmTransport receiver instead of guessing at line structure.
function parseAstmRecords(records) {
  const specimenMatch = records.join('\n').match(SPECIMEN_ID_RE);
  const results = records
    .filter(r => r.startsWith('R|'))
    .map(r => {
      const fields = r.split('|');
      const testField = (fields[2] || '').split('^').filter(Boolean).pop() || fields[2] || '';
      return {
        source_code: testField,
        source_name: testField,
        value: fields[3] || '',
        unit: fields[4] || '',
        ref_range: fields[5] || '',
        abnormal_flag: fields[6] || '',
        raw_line: r
      };
    });
  return { specimen_id_guess: specimenMatch ? specimenMatch[0].toUpperCase() : null, results };
}

// Returns a {start, ANALYZER_KEY, parseBundle, tokenizeLine, parseAstmRecords}
// module bound to one analyzer_key — this is what each analyzer's own
// bridge file (microlabBridge.js, swelabBridge.js) exports.
function createSerialBridge(analyzerKey, logPrefix) {
  function start(config, log) {
    if (process.platform !== 'win32') {
      log(`[${logPrefix}] serial bridge needs Windows (running on ${process.platform} here) — not starting. On the hospital's actual Windows PC this starts normally.`);
      return { stop: () => Promise.resolve(), status: () => ({ listening: false, reason: 'not-windows' }) };
    }

    const stopBitsMap = { 1: 'One', 1.5: 'OnePointFive', 2: 'Two' };
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'powershell', 'serial-bridge.ps1'),
      '-PortName', config.comPort || 'COM3',
      '-BaudRate', String(config.baudRate || 9600),
      '-Parity', config.parity || 'None',
      '-DataBits', String(config.dataBits || 8),
      '-StopBits', stopBitsMap[Number(config.stopBits) || 1] || 'One'
    ];

    const child = spawn('powershell.exe', args, { windowsHide: true });
    let lineBuf = '';
    let astmMode = null; // null = undecided, true/false once first bytes seen
    let astmReceiver = null;

    const bundler = new LineBundler((lines) => {
      const parsed = parseBundle(lines);
      const { id, matchStatus } = recordInboxEntry({
        analyzerKey, rawPayload: lines.join('\n'), parsed, specimenIdGuess: parsed.specimen_id_guess
      });
      log(`[${logPrefix}] captured ${lines.length} line(s) -> inbox #${id} (${matchStatus})`);
    });

    child.stdout.on('data', (chunk) => {
      if (astmMode === null) astmMode = chunk.length > 0 && chunk[0] === astm.ENQ;
      if (astmMode) {
        if (!astmReceiver) {
          astmReceiver = new astm.AstmReceiver({
            onRecords: (records) => {
              const parsed = parseAstmRecords(records);
              const { id, matchStatus } = recordInboxEntry({
                analyzerKey, rawPayload: records.join('\n'), parsed, specimenIdGuess: parsed.specimen_id_guess
              });
              log(`[${logPrefix}] ASTM session complete (${records.length} record(s)) -> inbox #${id} (${matchStatus})`);
            }
          });
        }
        astmReceiver.push(chunk);
        return;
      }
      lineBuf += chunk.toString('latin1');
      let idx;
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, idx).replace(/\r$/, '');
        lineBuf = lineBuf.slice(idx + 1);
        bundler.addLine(line);
      }
    });
    child.stderr.on('data', (chunk) => log(`[${logPrefix}] ${chunk.toString().trim()}`));
    child.on('exit', (code) => log(`[${logPrefix}] serial bridge process exited (code ${code})`));
    child.on('error', (err) => log(`[${logPrefix}] failed to start PowerShell bridge: ${err.message}`));

    log(`[${logPrefix}] serial bridge starting on ${config.comPort} @ ${config.baudRate} baud`);

    return {
      stop: () => new Promise((resolve) => { bundler.flush(); child.once('exit', () => resolve()); child.kill(); }),
      status: () => ({ listening: !child.killed, comPort: config.comPort })
    };
  }

  return { start, ANALYZER_KEY: analyzerKey, parseBundle, tokenizeLine, parseAstmRecords };
}

module.exports = { createSerialBridge, parseBundle, tokenizeLine, parseAstmRecords };
