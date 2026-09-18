// analyzers/hl7.js — hand-written, zero-dependency HL7 v2.x + MLLP framing.
//
// Why hand-written: this whole system runs on a single hospital PC with no
// reliable internet access, so nothing may require `npm install` to recover
// from a lost node_modules folder (see db.js's header comment for the same
// rule applied to SQLite). HL7 v2's pipe/hat delimited structure and MLLP's
// three-byte framing are small, stable, and well-documented enough to
// implement directly rather than pull in a library.
//
// Used by analyzers/swelabBridge.js: the Swelab Alfa Plus hematology
// analyzer's own manual states it "communicates via a network using HL7
// protocol" (not classic serial ASTM), so this is the actual wire format for
// that one device — not a guess. What IS still unverified is exactly which
// OBX-3 observation codes the analyzer sends for each CBC parameter (WBC,
// RBC, HGB, etc.) — that can only be confirmed once real hardware is
// connected and sending, which is why every parsed result lands in the
// analyzer_result_inbox staging table for human review rather than being
// written straight into a patient's saved result.

'use strict';

// ---------- MLLP (Minimal Lower Layer Protocol) framing ----------
// A HL7 message on the wire is wrapped as: <VT> message <FS><CR>
const VT = 0x0b; // vertical tab — start of block
const FS = 0x1c; // file separator — end of block
const CR = 0x0d;

function wrapMLLP(message) {
  return Buffer.concat([Buffer.from([VT]), Buffer.from(message, 'utf8'), Buffer.from([FS, CR])]);
}

// Incremental MLLP frame extractor. Feed it raw bytes as they arrive on the
// TCP socket; it emits complete HL7 message strings (VT/FS/CR stripped) as
// soon as a full frame has been seen, and keeps any partial trailing bytes
// buffered for the next call. A single TCP read can contain zero, one, or
// several complete frames, and a single frame can span several reads — this
// handles both without assuming message boundaries line up with packet
// boundaries.
class MLLPFrameReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }
  // Returns an array of complete message strings extracted from this push.
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    for (;;) {
      const startIdx = this.buffer.indexOf(VT);
      if (startIdx === -1) { this.buffer = Buffer.alloc(0); break; }
      const endIdx = this.buffer.indexOf(FS, startIdx + 1);
      if (endIdx === -1) {
        // Incomplete frame — keep from the VT onward and wait for more data.
        this.buffer = this.buffer.subarray(startIdx);
        break;
      }
      const msgBytes = this.buffer.subarray(startIdx + 1, endIdx);
      messages.push(msgBytes.toString('utf8'));
      // Skip the trailing CR after FS if present.
      let next = endIdx + 1;
      if (this.buffer[next] === CR) next += 1;
      this.buffer = this.buffer.subarray(next);
    }
    return messages;
  }
}

// ---------- HL7 v2 message parsing ----------
// Segments are separated by CR (sometimes CRLF from misbehaving senders —
// tolerated here). Fields within a segment are separated by the field
// separator declared in MSH-1 (almost always '|'). Components within a
// field are separated by the char in MSH-2 position 1 (almost always '^').
function parseMessage(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\r').replace(/\n/g, '\r');
  const segments = text.split('\r').filter(s => s.length > 0);
  if (segments.length === 0) return { segments: [], fieldSep: '|', compSep: '^' };
  const msh = segments[0];
  // MSH is special: the character immediately after "MSH" IS the field
  // separator, so MSH-1 (by field count) is that separator itself, and the
  // "first field" most implementations mean is actually MSH-2.
  const fieldSep = msh.charAt(3) || '|';
  const encodingChars = msh.split(fieldSep)[1] || '^~\\&';
  const compSep = encodingChars.charAt(0) || '^';
  const repSep = encodingChars.charAt(1) || '~';

  const parsed = segments.map(seg => {
    const segId = seg.slice(0, 3);
    let fields;
    if (segId === 'MSH') {
      // Reconstruct so MSH-1 = the field separator char, MSH-2 = encoding chars,
      // and everything from MSH-3 onward lines up with every other segment's
      // 1-based field numbering used throughout this module and its callers.
      fields = [segId, fieldSep, ...seg.slice(4).split(fieldSep)];
    } else {
      fields = seg.split(fieldSep);
    }
    return { segId, fields, raw: seg };
  });
  return { segments: parsed, fieldSep, compSep, repSep };
}

// field(seg, n) returns the raw n-th field (1-based, matching HL7 convention
// where field 1 is the segment ID) split into components on ^.
function components(fieldValue, compSep) {
  if (fieldValue == null) return [];
  return String(fieldValue).split(compSep || '^');
}

function getSegments(msg, segId) {
  return msg.segments.filter(s => s.segId === segId);
}
function getField(seg, n) {
  return seg && seg.fields[n] != null ? seg.fields[n] : '';
}

// Extracts the message type (MSH-9, e.g. "ORU^R01") and control ID (MSH-10).
function messageMeta(msg) {
  const msh = getSegments(msg, 'MSH')[0];
  if (!msh) return { messageType: '', controlId: '', sendingApp: '' };
  return {
    messageType: getField(msh, 9),
    controlId: getField(msh, 10),
    sendingApp: getField(msh, 3),
    version: getField(msh, 12)
  };
}

// Pulls out everything a lab result inbox entry needs from an ORU^R01-style
// message: patient identifiers, the specimen/order identifier (checked
// against our own specimen_id so an order can be matched automatically),
// and one row per OBX segment (the analyzer's own code/name for that
// parameter, the value, unit, reference range, and abnormal flag — all
// analyzer-native and NOT yet mapped to this system's own test/component
// names; that mapping happens at import time via analyzer_test_map).
function extractResults(msg) {
  const compSep = msg.compSep || '^';
  const pid = getSegments(msg, 'PID')[0];
  const obr = getSegments(msg, 'OBR')[0];
  const patientIdField = components(getField(pid, 3), compSep)[0] || '';
  const patientNameRaw = getField(pid, 5);
  const nameParts = components(patientNameRaw, compSep);
  const patientName = [nameParts[1], nameParts[0]].filter(Boolean).join(' ');

  // The specimen/sample ID an operator typed into the analyzer when running
  // the tube is the only reliable link back to a specific paid order. Vendors
  // place this inconsistently — OBR-2 (placer order number), OBR-3 (filler
  // order number), and PID-3 (patient ID field, sometimes reused as a sample
  // ID on simpler analyzers) are all checked, in that order of preference.
  const specimenCandidates = [
    components(getField(obr, 3), compSep)[0],
    components(getField(obr, 2), compSep)[0],
    patientIdField
  ].filter(Boolean);

  const obxRows = getSegments(msg, 'OBX').map(obx => {
    const idField = components(getField(obx, 3), compSep);
    return {
      source_code: idField[0] || '',
      source_name: idField[1] || idField[0] || '',
      value: getField(obx, 5),
      unit: components(getField(obx, 6), compSep)[0] || '',
      ref_range: getField(obx, 7),
      abnormal_flag: getField(obx, 8),
      result_status: getField(obx, 11)
    };
  });

  return {
    patient_id: patientIdField,
    patient_name: patientName,
    specimen_id_guess: specimenCandidates[0] || null,
    results: obxRows
  };
}

// Builds a minimal, spec-valid ACK^R01 (or matching ACK type) response so a
// well-behaved analyzer knows its message was received — most analyzers will
// hold/queue results (or alarm) if they never see an ACK come back.
function buildAck(originalMsg, ackCode = 'AA') {
  const meta = messageMeta(originalMsg);
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const ackType = meta.messageType.split('^')[0] === 'ORU' ? 'ORU^R01' : 'ACK';
  const controlId = 'ACK' + ts + Math.floor(Math.random() * 900 + 100);
  const seg = [
    `MSH|^~\\&|ALNOOR-LMS||${meta.sendingApp || ''}||${ts}||ACK^${ackType.split('^')[1] || 'R01'}|${controlId}|P|2.3`,
    `MSA|${ackCode}|${meta.controlId || ''}`
  ];
  return seg.join('\r') + '\r';
}

module.exports = {
  MLLPFrameReader, wrapMLLP, parseMessage, getSegments, getField, components,
  messageMeta, extractResults, buildAck
};
