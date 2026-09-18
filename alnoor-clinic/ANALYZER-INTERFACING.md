# Analyzer Interfacing (Phase 2) — Setup & Safety Guide

This phase connects three lab analyzers — **Swelab Alfa** (hematology),
**Microlab 300** (chemistry), and **i-Chroma II** (special chemistry /
immunoassay) — to the Al Noor Clinic LMS, so results captured on the
instrument can be pulled into result entry instead of retyped by hand.

**Read this before switching anything on.** None of the three devices had
a manual confirming its exact result-data format, and none was available to
test against during development — every bridge here is best-effort and
needs the calibration steps below once the hardware is actually connected.

> **A note on the Swelab model name.** This was originally built against
> the newer **Swelab Alfa Plus**, whose manual documents a networked
> HL7/TCP interface — that version of this bridge is still in the codebase
> (`analyzers/hl7.js`) but is no longer used by default. The hospital's
> actual unit is the older/base **Swelab Alfa** (no "Plus"), whose manual
> documents only a classic RS-232 serial port with no LAN interface at all,
> so the bridge was rewritten to match: serial, same as Microlab 300. If
> your unit's own settings menu does show a network/IP/LIS configuration
> screen (meaning it may actually be a Plus model or have an add-on network
> card), say so and this can be switched back to the HL7/TCP bridge.

## The one safety rule everything else depends on

**Nothing an analyzer sends is ever written directly into a patient's saved
result.** Every incoming message — however it arrives — is stored first in
a staging area (Lab → **Analyzer Inbox**). A technician reviews it there,
matches it to the right paid order if needed, and clicks **Import**, which
only *pre-fills* the exact same result-entry screen they'd otherwise type
into by hand. Saving still requires clicking **Save Results**, and the
pathologist verification step is completely unchanged. Worst case, a
misparsed or mismapped analyzer message wastes a few seconds of a
technician's time in the Inbox — it can never silently become part of a
report.

## What's confirmed vs. what needs calibration

| Analyzer | Transport | Status |
|---|---|---|
| Swelab Alfa | RS-232 serial (9-pin, pins 2/3/5/7/8 = TX/RX/GND/CTS/RTS) | Physical port/pinout confirmed from the manufacturer's manual. The actual data protocol on that serial line (ASTM, or a simple printer-style format) is **not** documented — the bridge captures raw lines generically and auto-detects classic ASTM framing as a fallback. Needs calibration. |
| Microlab 300 | RS-232 serial, format undocumented | Nothing about this device's serial output is publicly documented. The bridge captures raw lines generically and makes a best-effort guess at test/value/unit per line. Needs calibration. |
| i-Chroma II | No open protocol — needs Boditech's own PC software | The device's own manual states PC connectivity requires Boditech's proprietary software, with no documented export format. This bridge watches a folder for whatever export file that software can produce. May need contacting Boditech/the local distributor if no export option exists. |

Swelab Alfa and Microlab 300 now use the exact same underlying serial
bridge (`analyzers/serialBridge.js`) — same calibration approach applies to
both: capture real output in the Analyzer Inbox, check the raw text against
the best-effort guess, and add Test Code Mappings as needed.

## Admin setup (Admin → Analyzer Interfacing)

Each analyzer has a **Configure** button opening its connection settings,
a live running/not-running status, a test-code mapping table, and a
recent-activity log.

### Swelab Alfa (serial / COM port)

1. Connect the analyzer's RS-232 port to the PC using a standard serial
   cable (or a USB-to-serial adapter if the PC has no native serial port —
   Device Manager will show it as a COM port either way). The Swelab's
   manual documents a male 9-pin D-SUB connector: pin 2 = TX, pin 3 = RX,
   pin 5 = GND, pin 7 = CTS, pin 8 = RTS — use a straight-through cable to a
   PC's 9-pin serial port, or the crossover pinout in the manual for a
   25-pin port.
2. Check **Windows Device Manager → Ports (COM & LPT)** for the COM port
   number. The baud rate/parity/data bits/stop bits for the analyzer's own
   RS-232 host output are not published in the manual (only its barcode
   reader's default of 9600 baud, no parity, 8 data bits, 1 stop bit is
   documented, which is a reasonable starting guess but may not be what the
   analyzer itself uses) — check the unit's own communication setup menu to
   confirm, and try the barcode-reader default first if there's no
   dedicated host-port setting.
3. In Admin, open **Swelab Alfa → Configure**, enter those settings, tick
   **Enabled**, and Save.
4. **This step matters**: run one real sample and immediately check Lab's
   Analyzer Inbox — see the calibration note under Microlab 300 below,
   which applies identically here.

### Microlab 300 (serial / COM port)

1. Connect the analyzer's RS-232 output to the PC — directly if it has a
   native serial port, or via a USB-to-serial adapter (Device Manager will
   show it as a COM port either way).
2. Check **Windows Device Manager → Ports (COM & LPT)** for the COM port
   number, and check the Microlab 300's own communication/interface setup
   menu for its baud rate/parity/data bits/stop bits — these are not
   published anywhere and must come from the actual unit's settings screen
   or its printed manual insert.
3. In Admin, open **Microlab 300 → Configure**, enter those settings, tick
   **Enabled**, and Save.
4. **This step matters**: run one real sample and immediately check Lab's
   Analyzer Inbox. Click the entry to see the **raw captured lines**
   alongside the guessed test/value/unit split. If the guess looks wrong
   (wrong field picked as the value, name split oddly), that's expected on
   first contact — the raw text is always preserved, so nothing is lost;
   it just means the per-line guess needs a matching **Test Code Mapping**
   entry (see below) to resolve cleanly going forward.

### i-Chroma II (folder-watch)

1. Install Boditech's own PC software for the i-Chroma II and connect the
   reader via its USB OTG port, per the device's own manual.
2. In that software, look for an export / print-to-file / save-results
   option (exact wording varies by software version) and point it at a
   folder — anywhere on this PC works.
3. In Admin, open **i-Chroma II → Configure**, set **Folder to watch** to
   that same folder, set the **File pattern** (e.g. `*.csv`), tick
   **Enabled**, and Save.
4. Run a real sample, let the software export a file, and check Lab's
   Analyzer Inbox for it. Files that get picked up are moved into an
   `_imported` subfolder inside the watched folder (never deleted) so the
   originals stay available if a mapping needs correcting and the file
   needs re-reading.
5. **If Boditech's software has no export/save-to-file option at all**,
   this bridge has nothing to watch. Check with Boditech or the local
   distributor for their actual LIS/host interface option (some POC reader
   software has this as a separate licensed module); until then, i-Chroma
   II results stay on manual entry exactly as before this phase.

## Test Code Mapping — why results don't just appear correctly on day one

An analyzer reports its OWN code or name for each parameter (e.g. Swelab
might send `WBC`, `HGB`, `PLT`) — it has no idea this system's CBC panel
calls those "WBC Count", "Hemoglobin (Hb)", "Platelet Count". Each
analyzer's **Configure** screen has a **Test Code Mapping** table for
exactly this: once you see a real code come through in the Analyzer Inbox,
add one row (analyzer code → our test name → our component name, if it's
part of a panel) and every future message with that code pre-fills
correctly. Unmapped codes still show up in the Inbox and can still be
imported — the technician just has to type that one value in manually,
same as before this phase existed, until it's mapped.

## Matching a result to the right order

Every message is matched automatically by **specimen ID** — the
`SPEC-YYYYMMDD-NNNNN` barcode printed on the tube label, generated the
moment payment clears. **The specimen ID has to actually reach the
analyzer** for auto-matching to work:

- On Swelab and Microlab, whoever runs the sample should type or scan the
  specimen ID into the analyzer's own "Sample ID" field before running it.
- On i-Chroma II, if Boditech's software has a sample ID field, use the
  specimen ID there too.

If a result arrives without a recognizable specimen ID (or the operator
forgot), it shows up in the Inbox as **Unmatched** — a technician can use
**Match to Order** and type the specimen ID from the physical tube/label to
link it manually. Nothing is ever guessed at or auto-matched to the "most
likely" order — an unmatched result stays unmatched until a person confirms
which order it belongs to.

## What this phase deliberately does NOT do

- **No bidirectional order transmission.** The LMS does not push a worklist
  to any analyzer — results-only, matching the hospital's existing
  workflow where the technician runs the sample and reads/types results
  off the analyzer's own display or printout today.
- **No automatic result acceptance.** Covered above, but worth repeating:
  everything goes through the Inbox and the ordinary result-entry screen.
- **No SMS/WhatsApp/email alerts** for critical values from analyzer
  results — critical-value alerting stays on-screen + printed-report only,
  per the hospital's Phase 1 decision, unchanged here.

## Troubleshooting

- **Swelab or Microlab shows "not-windows" as its status**: these bridges
  spawn a small PowerShell script (`analyzers/powershell/serial-bridge.ps1`)
  that uses the .NET `System.IO.Ports.SerialPort` class built into every
  Windows installation — no extra software to install. They only run on
  Windows, which is what the hospital's actual PC uses; seeing this status
  anywhere else (a Mac/Linux dev machine) is expected, not an error.
- **Swelab or Microlab shows "Not running" on the actual Windows PC**: the
  COM port is usually the culprit — double check the port number in Device
  Manager (it can shift if the USB-to-serial adapter is unplugged and
  replugged into a different port) and that nothing else (another program,
  or this server already running elsewhere) has that port open.
- **i-Chroma shows "not-configured" or "folder-missing"**: the watch
  folder either hasn't been set yet, or the path typed into Admin doesn't
  exist on this PC — create the folder first (or let Boditech's software
  create it when it first exports), then re-check the path.
- **A result never shows up at all**: check the analyzer's own screen for a
  communication error first (most analyzers show one directly if they
  can't reach their configured destination), then check the **Recent
  Activity** log on that analyzer's Configure screen in Admin — every
  connection attempt and parse error is logged there.
