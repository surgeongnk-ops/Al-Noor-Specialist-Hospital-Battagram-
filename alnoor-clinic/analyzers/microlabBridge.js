// analyzers/microlabBridge.js — Windows serial (COM port) bridge for the
// Microlab 300 semi-automated biochemistry analyzer.
//
// UNVERIFIED FORMAT WARNING: no publicly available manual documents the
// Microlab 300's exact RS-232 output format. Rather than invent a precise
// parser for a format that hasn't been confirmed, this captures raw lines
// generically and makes a best-effort guess at test name / value / unit per
// line, clearly intended to be reviewed (and the tokenizer refined, if
// needed) once real hardware is connected — see ANALYZER-INTERFACING.md for
// the calibration steps (a raw-capture view is provided in the Analyzer
// Inbox UI specifically for this).
//
// The actual serial I/O and line-tokenizing logic is shared with
// swelabBridge.js — see analyzers/serialBridge.js for the implementation
// and its own header comment for why a hand-rolled PowerShell bridge is
// used instead of an npm serial-port package.
'use strict';

module.exports = require('./serialBridge').createSerialBridge('microlab_300', 'microlab');
