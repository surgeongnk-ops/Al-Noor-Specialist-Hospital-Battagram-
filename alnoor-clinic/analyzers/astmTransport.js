// analyzers/astmTransport.js — hand-written ASTM E1394 / CLSI LIS02-A2
// low-level transport layer. Zero dependencies, same reasoning as hl7.js.
//
// This is the classic "serial ASTM" handshake used by a large fraction of
// lab analyzers worldwide (ENQ/ACK/NAK, STX-framed text records with a
// checksum, EOT to end a session). It is well-established and stable enough
// to implement directly from the standard rather than guess at, unlike the
// vendor-specific HIGH-LEVEL record content (which fields a given analyzer
// actually populates in its H/P/O/R records) — that part genuinely does
// need calibration against real hardware output, which is why anything this
// module extracts still lands in analyzer_result_inbox for human review.
//
// None of the three analyzers currently being interfaced are CONFIRMED to
// use this transport (Swelab Alfa Plus uses HL7/TCP instead — see hl7.js —
// and Microlab 300's exact serial format is undocumented). This module
// exists so microlabBridge.js can auto-detect classic ASTM framing (if the
// hospital's Microlab 300 turns out to speak it) and fall back to a plain
// line-based reader otherwise, and so any FUTURE analyzer that does speak
// standard ASTM has a ready-made, spec-correct transport to plug into.

'use strict';

const ENQ = 0x05, ACK = 0x06, NAK = 0x15, STX = 0x02, ETX = 0x03, ETB = 0x17, EOT = 0x04;
const CR = 0x0d, LF = 0x0a;

// Sum-of-bytes-mod-256 checksum, formatted as two uppercase hex digits — the
// algorithm ASTM E1394 specifies, computed over the frame number, text, and
// terminator byte (everything between STX and the checksum itself).
function checksum(bytes) {
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

// Builds one complete ASTM frame ready to write to the wire:
//   <STX><frameNum 0-7><text><ETX or ETB><checksum 2 hex><CR><LF>
function buildFrame(frameNum, text, isLast = true) {
  const term = isLast ? ETX : ETB;
  const middle = Buffer.concat([
    Buffer.from(String(frameNum % 8), 'ascii'),
    Buffer.from(text, 'ascii'),
    Buffer.from([term])
  ]);
  const cs = checksum(middle);
  return Buffer.concat([Buffer.from([STX]), middle, Buffer.from(cs, 'ascii'), Buffer.from([CR, LF])]);
}

// Incremental receiver: feed raw bytes as they arrive on the serial line.
// Handles the ENQ/ACK session-establishment handshake, verifies each frame's
// checksum (NAKing a corrupt one so the sender retransmits, per spec),
// reassembles multi-frame text (frames end in ETB when a record is split
// across more than one ~240-byte frame, ETX on the truly final frame of a
// record), and splits the accumulated text on CR into individual ASTM
// records (H|..., P|..., O|..., R|..., C|..., L|...). Emits complete
// records only once EOT ends the session, since a partial session has no
// well-defined result yet.
class AstmReceiver {
  constructor({ onAck, onNak, onRecords } = {}) {
    this.buffer = Buffer.alloc(0);
    this.textAcc = '';
    this.records = [];
    this.onAck = onAck || (() => {});
    this.onNak = onNak || (() => {});
    this.onRecords = onRecords || (() => {});
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length === 0) return;
      const b0 = this.buffer[0];
      if (b0 === ENQ) {
        this.buffer = this.buffer.subarray(1);
        this.onAck(); // caller writes an ACK byte back
        continue;
      }
      if (b0 === EOT) {
        this.buffer = this.buffer.subarray(1);
        const finalText = this.textAcc;
        this.textAcc = '';
        const records = finalText.split(/[\r\n]+/).filter(Boolean);
        this.onRecords(records);
        continue;
      }
      if (b0 === STX) {
        // Need at least STX + frameNum + ... + checksum(2) + CR LF to parse.
        const crlfIdx = this.buffer.indexOf(Buffer.from([CR, LF]), 1);
        if (crlfIdx === -1) return; // wait for more data
        const frame = this.buffer.subarray(1, crlfIdx); // frameNum..checksum
        this.buffer = this.buffer.subarray(crlfIdx + 2);
        if (frame.length < 3) { this.onNak(); continue; }
        const checksumBytes = frame.subarray(frame.length - 2);
        const body = frame.subarray(0, frame.length - 2); // frameNum + text + ETX/ETB
        const expected = checksum(body);
        const got = checksumBytes.toString('ascii').toUpperCase();
        if (expected !== got) { this.onNak(); continue; }
        const term = body[body.length - 1];
        const text = body.subarray(1, body.length - 1).toString('ascii'); // drop frame# and terminator
        this.textAcc += text;
        this.onAck();
        if (term === ETX) {
          // record boundary within the accumulated text is CR — leave
          // splitting to the EOT handler so multi-record sessions accumulate
          // correctly across many frames.
        }
        continue;
      }
      // Unrecognized leading byte (noise, or a device that never sends a
      // clean ENQ) — drop it and keep scanning rather than getting stuck.
      this.buffer = this.buffer.subarray(1);
    }
  }
}

module.exports = { ENQ, ACK, NAK, STX, ETX, ETB, EOT, CR, LF, checksum, buildFrame, AstmReceiver };
