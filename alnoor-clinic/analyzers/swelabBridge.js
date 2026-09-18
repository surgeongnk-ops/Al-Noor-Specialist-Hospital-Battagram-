// analyzers/swelabBridge.js — Windows serial (COM port) bridge for the
// hospital's actual hematology analyzer.
//
// IMPORTANT HISTORY — read this if the analyzer still won't connect after
// following ANALYZER-INTERFACING.md: this bridge originally talked HL7 over
// a TCP/IP network connection, based on the newer "Swelab Alfa Plus"
// model's published manual, which explicitly documents that networked
// interface. The hospital's actual unit turned out to be the older/base
// "Swelab Alfa" (without "Plus") — its manual documents only a classic
// 9-pin RS-232 serial port (pins 2/3/5/7/8, TX/RX/GND/CTS/RTS), with no
// mention of a LAN port or HL7 at all. This bridge was rewritten to match
// that: a serial (COM port) bridge, same as Microlab 300 — see
// analyzers/serialBridge.js for the shared implementation.
//
// The RS-232 port's exact DATA format (beyond the physical pinout) is not
// documented anywhere publicly for the base Swelab Alfa — the manual only
// mentions a barcode-reader default of "9600N81" and two output modes
// ("with"/"without histograms"), not a protocol name (ASTM, HL7, or
// otherwise). So, like Microlab 300, this captures raw lines generically
// and auto-detects classic ASTM framing (a leading ENQ byte) as a
// fallback — genuinely needs calibration against real hardware output
// (see ANALYZER-INTERFACING.md).
//
// If a hospital's Swelab unit turns out to actually be the newer "Alfa
// Plus" with a LAN/HL7 interface after all (check its own network settings
// menu for an IP/LIS configuration screen), the original HL7/MLLP module
// this bridge used to call is still in this codebase — analyzers/hl7.js —
// fully working and unit-tested, just not wired up by default anymore.
// Let the hospital know and this can be switched back easily.
'use strict';

module.exports = require('./serialBridge').createSerialBridge('swelab_alfa', 'swelab');
