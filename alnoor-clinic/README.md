# Al Noor Clinic System

Internal offline hospital workflow system for Al Noor Specialist Hospital.
Runs entirely on your own local network — no internet needed day-to-day, and
no patient data ever leaves the hospital.

**Analyzer interfacing (Swelab Alfa, Microlab 300, i-Chroma II):** see
[`ANALYZER-INTERFACING.md`](./ANALYZER-INTERFACING.md) for setup, safety
model, and calibration steps — start there before enabling anything in
Admin → Analyzer Interfacing.

## What it does

- **Reception**: register a new patient, auto-generates an MR number, optionally collects a consultation fee (receipt generated), prints a slip; starts new visits for returning patients
- **Doctor**: sees a queue of waiting patients, records examination notes/diagnosis, sends lab and radiology referrals, admits patients to a ward, adds inpatient doctor's orders, writes prescriptions
- **Lab**: sees pending orders, enters results, generates a payment receipt (staff-only access)
- **Radiology**: sees pending imaging orders, enters findings, generates a payment receipt
- **Pharmacy**: sees pending prescriptions, dispenses medicine, generates a payment receipt, tracks a medicine stock database
- **Nursing**: sees all active inpatients and their doctor's orders, can acknowledge/mark orders done, discharges patients (with a discharge/ward charge receipt)
- **Operation Room Manager**: schedules procedures (surgery, normal vaginal delivery, D&C, or anything else) against a patient, marks them complete with a charge, generates a receipt
- **Combined patient record**: full history across every department — visits, admissions, procedures, labs, radiology, prescriptions — under one MR number
- **Admin**: create/disable staff logins for every department (each staff member has their own ID and password), a dashboard of patients-per-doctor, a revenue breakdown by department and procedure type, an audit log of who logged in and who viewed which patient record, database backup controls, and CSV/Excel exports
- **Change password**: every staff member can change their own password from any page
- **Laboratory Management System**: test master list with pre-filled reference ranges across Hematology, Biochemistry, Special Chemistry, and Immunology, including a full CBC panel (Hb, RBC, WBC, Platelets, differential count). Result entry compares each value against its normal range and flags High/Low/Normal automatically, then prints as a report/receipt.
- **Pharmacy Management System**: batch-level inventory (drug, quantity, batch number, expiry date, purchase/selling price, company, distributor), automatic Red (expired) / Yellow (within 30 or 60 days) expiry flags, a Point-of-Sale screen for walk-in sales with a discount field capped at 1%, and itemized printable receipts. Dispensing — whether from a doctor's prescription or a walk-in sale — automatically deducts stock from the earliest-expiring batch first (FEFO). Also: a Supplier/Purchase-Order workflow for restocking, a controlled-substance (narcotics) register, a non-blocking drug interaction/allergy safety check, and optional insurance/split-payment billing — see the OPD/Pharmacy update section below.
- **Universal search**: every drug and test field across Doctor/Lab/Pharmacy has a live, Google-style autocomplete — filters as soon as you type.
- **Prescription editing**: doctors can edit and re-save an active prescription any time before pharmacy has actually dispensed it. Once dispensed, it's locked (the patient already has the medicine).
- **Billing**: every department still prints its own receipt at the point of service (as before). A separate Billing page can also produce one consolidated Master Receipt covering every charge a patient has across all departments.

## Latest fixes (this update)

- **Fixed: doctors could never see returning patients.** When lab or radiology completed a test, the patient vanished from the doctor's screen — there was no queue that showed them. Doctor Dashboard now has a dedicated **"Lab / Radiology Results Ready — Re-examination Queue"** that surfaces the patient the moment results are in, with the results themselves visible right there (no need to leave the page) before the doctor re-examines, adjusts the diagnosis, or edits the prescription.
- **Added: global patient search on the Doctor Dashboard** — search by MR number, name, or phone, pull up any patient's visit history, and jump straight into an open visit to review results, add orders, or edit the prescription.
- **Fixed: pharmacy unit price field was frozen.** The POS price input is now fully editable (it still pre-fills a suggested price from stock, but never locks the field), and every row shows a live Qty × Price subtotal plus a running sale total as you type.
- **Fixed: receipts and diagnostic reports were printing together.** Every station (Registration, Pharmacy, Laboratory, Radiology, IPD) now has completely separate print actions — printing a lab report never pulls in the payment receipt, and vice versa. All printed documents now carry standard branding: **AL-NOOR SPECIALIST HOSPITAL**, address (Karakoram Highway, Doraha, Battagram), and contact (0997310399) in the header/footer. Lab reports specifically show a **"AL-NOOR SPECIALIST HOSPITAL LABORATORY"** title with patient name, age/gender, MR number, and date/time directly below it.
- **Added: live Hospital Census widget** on both the Admin and Doctor dashboards — real-time counts of patients currently in IPD/Wards, OPD, and Laboratory, plus a Total Active Patients figure.

## Bug fixes & operational gaps (this update)

- **Fixed: walk-in lab orders appeared to "disappear" after printing.** Investigation confirmed the data was never actually lost — it was already saved and searchable via the patient database. The real gap was that Lab had no way to reopen a completed order once its results card was closed. Lab now has a permanent "Completed Orders — Search & Re-Print" section (search by patient name, MR/Walk-In ID, or date) that reopens any paid order and reprints the Payment Receipt or Lab Report independently, at any time, without redoing anything.
- **Fixed: Daily Closing Report print button printed nothing, and had no hospital branding.** Root cause: it called the browser's raw print on content sitting inside a "no-print" card, so nothing usable ever reached the printer. It's now routed through the same shared print system as every other receipt — thermal format, with the full hospital header and footer.
- **Fixed: the "Load" button on Daily Closing Reports appeared unresponsive.** It had no error handling, so any failed request silently did nothing. It now shows a loading state and a clear error message (via toast) if something goes wrong, instead of looking broken.
- **Added: distributor purchase detail in the closing report and inventory.** A new Invoice/Bill Number field on inventory entry (previously missing from the form even though the intent existed) plus a full itemized purchase table — distributor, invoice #, medicine, quantity, date, total cost — now shows in both the Daily Closing Report and its own CSV export.
- **Added: full Lab Test Catalog management** (Admin → Lab Test Catalog) — create, edit, and retire tests directly, with category, reference range, unit, and locked price. A newly added test is available immediately in Doctor's ordering and the Lab walk-in tabs, no restart needed. Retiring a test deactivates it (never a hard delete) so historical orders and reports referencing it stay intact.
- **Expanded exports into Financial vs. Clinical categories**: Financial now includes a fully itemized revenue log (department, patient, amount, receipt #, cashier — note: this system doesn't yet distinguish payment methods, so that column reads "Cash" for everything until that's actually built) and a distributor purchase log. Clinical now includes a combined activity log — tests conducted with results, radiology findings, and prescribed medicines — one row per patient encounter, alongside the existing raw exports.

## Clinical workflow upgrade (this update)

- **Direct Lab walk-in with no MR number at all**: the Lab page now has two tabs — "Registered OPD/IPD Patient (MRN)" for an existing patient tested without a doctor referral, and "Direct Walk-In Patient" for someone with no registration whatsoever. The second tab only asks for name, age, gender, and contact number, and issues a temporary ID in the format `WALK-LAB-YYYYMMDD-XXX` (resets to 001 each day). These patients are tagged `patient_type = 'WALK_IN'` in the database, and every receipt and report for them is clearly labeled "DIRECT WALK-IN TEST".
- **Death Certificate module**: a new page (Official Certificates → Death Certificate) captures deceased's name, age/gender, date/time and place of death, cause of death, attending doctor, and next of kin, and issues a numbered, print-ready A4 certificate.
- **Discharge Certificate module**: a new page (Official Certificates → Discharge Certificate) looks up a patient's completed discharge summary by MR number and reprints it as a formal A4 certificate — it doesn't duplicate the discharge-summary form itself (that's still written once by the doctor at the time of discharge), it just gives that content an official certificate layout.
- **Unified official-document branding**: every A4 document (Lab/Radiology Reports, Birth/Death/Discharge Certificates) now shares one header (hospital name, tagline, address, phone, and emergency contact) and one footer (signature block naming the authorizing role, issue timestamp, letterhead line), and prints at exact 210mm×297mm with 15mm margins. "Official Certificates" is now its own grouped section in the nav on Admin, Doctor, and Nursing pages.
- **Low-stock alert threshold**: stock warnings now trigger only when a drug's total remaining stock drops below 5 packs (or 5 units for a loose item) — 5 packs or more is never flagged. This shows as a badge in the Pharmacy inventory table, in the POS autocomplete while selling, and as a dedicated Low Stock Alert panel on the Admin page.
- **Pharmacy POS ↔ inventory sync re-verified**: real-time stock deduction on every sale (partial pack or full) was already correct from a prior round; re-tested this round to confirm nothing regressed while adding the low-stock logic.

- **Direct walk-in / counter sale (Lab & Radiology)**: a patient with a registered MR number but no doctor referral can now be served directly — Lab and Radiology each have a "Direct Walk-In" form (search tests, submit) that creates the order without needing a doctor's visit. These orders are tagged and never clutter the doctor's queues.
- **Partial test refusal & order editing**: a doctor or lab/radiology tech can now edit a still-pending order to remove individual tests the patient declines, or cancel the whole order — the bill recalculates automatically from whatever remains.
- **Payment now gates printing, not ordering**: placing a lab/radiology order never requires payment. Entering results is now a separate step from collecting payment — a report or receipt cannot be printed until payment is explicitly collected (a new "Awaiting Payment" list on each page). The doctor's results-ready queue still fires as soon as results are entered, regardless of payment — clinical review is never blocked by billing.
- **Loose/unit tablet dispensing**: pharmacy inventory now always tracks stock in individual units internally. Adding a batch can be done pack-based (units per pack, number of packs, pack price — the system converts to per-unit automatically) or unit-based directly for loose items like syrups. Dispensing any partial quantity (5 tablets out of a 20-tablet strip) bills at the exact per-unit price with no special handling needed.
- **Admin pharmacy inventory corrections**: admin can now directly edit or delete a batch (fixing a miscounted quantity, wrong batch number, wrong expiry date) from the Admin page. This is separate from, and doesn't require, the wastage/damage/return approval workflow — every correction is audit-logged.
- **Thermal vs A4 printing**: all receipts (registration, pharmacy, lab/radiology payment, IPD discharge charges, master receipt) now print in 80mm thermal roll format. Lab/Radiology Reports, IPD Discharge Summaries, and Birth Certificates print in full A4.
- **Birth Certificate module**: a new page (Admin/Doctor/Nursing → Birth Certificate) captures baby's name, gender, date/time of birth, parents' names, attending doctor, and weight, and issues a numbered, print-ready A4 certificate.

## Enterprise architecture upgrade (this update)

This update was a systematic refactor for security, code organization, and
production readiness — with one hard constraint preserved throughout: **zero new
dependencies**. This server runs on a hospital PC with no reliable internet, so
nothing added here may ever require `npm install` to recover from.

- **Codebase restructure**: the old single 1,000+ line `server.js` is now a thin
  ~110-line entrypoint. All business logic moved into `routes/*.routes.js` — one
  file per domain (patients, doctor, lab, radiology, pharmacy, nursing,
  procedures, dashboard, admin, billing, reports, export, staff, auth, catalog),
  each built on a small dependency-free router (`router.js`) and shared
  middleware (`middleware.js`) that gives every endpoint the same RBAC check,
  input validation, and error-response shape for free.
- **Versioned API**: every endpoint is now reachable at both its original path
  (`/api/...`, so nothing already built against it breaks) and the new canonical
  versioned form (`/api/v1/...`).
- **JWT authentication**: logins now issue real, standard JWTs (inspectable on
  jwt.io) instead of opaque tokens — hand-rolled with Node's built-in `crypto`
  (no `jsonwebtoken` package). Sessions still live in the database too, so
  disabling a staff account revokes their access instantly, which a purely
  stateless JWT can't do.
- **Stronger password hashing**: new and changed passwords use a substantially
  higher `scrypt` cost factor. Existing password hashes keep working exactly as
  before — the cost used is now stored per-account, so upgrading this file never
  locks anyone out.
- **Formal database migrations**: schema changes now go through a numbered,
  tracked migration list (`db.js`) instead of ad-hoc changes — safe to upgrade
  an already-deployed hospital database without losing data. Added
  `PRAGMA busy_timeout` so concurrent stations wait briefly instead of erroring
  if they hit the same row at the same moment, and audited every table for the
  right indexes (MRN, visit status/dates, receipt numbers, session expiry, etc.)
- **Non-blocking backups**: the backup itself now runs in a separate OS process
  (`backup-worker.js`), so a large database being backed up never stalls the
  server for any station using it at that moment.
- **Input validation & standard errors**: every request body is now checked
  against an explicit schema (required fields, types, minimum lengths, allowed
  values) before it touches the database, and every error response uses the
  same `{ "error": "..." }` shape.
- **Graceful shutdown**: stopping the server (`Ctrl+C`, a service stop, a PM2
  restart) now closes the database handle properly first, which checkpoints
  SQLite's WAL file back into the main database and avoids leaving stray files
  behind.
- **Process management (`ecosystem.config.js`)**: a ready-to-use PM2
  configuration for auto-restart, crash-loop protection, and local log files.
  Deliberately runs as a single process, not clustered — see the long comment
  in that file for why clustering a SQLite-backed app doesn't help here and can
  make a couple of code paths (receipt numbering, stock deduction) riskier.
- **Frontend**: browser `alert()` popups across every station were replaced
  with non-blocking toast notifications (`toast()` in `app.js`), and a safe API
  wrapper (`apiSafe()`) is available for pages that just want failures reported
  without writing their own try/catch.

## Laboratory Management System — Phase 2: Analyzer Interfacing (this update)

Connects the hospital's three physical lab analyzers — **Swelab Alfa**
(hematology), **Microlab 300** (chemistry), and **i-Chroma II** (special
chemistry/immunoassay) — to the LMS, so results captured on an instrument
can be pulled into result entry instead of retyped by hand. Full setup,
per-device notes, and the safety model are in
[`ANALYZER-INTERFACING.md`](./ANALYZER-INTERFACING.md) — read that before
enabling anything. In short:

- **New `analyzers/` module** (zero new dependencies, same rule as
  everywhere else in this app): a shared Windows COM-port bridge for
  Swelab Alfa and Microlab 300 (via a small bundled PowerShell script using
  .NET's built-in `SerialPort` class — no serial-port package needed, with
  automatic fallback to a spec-correct hand-written ASTM E1394 receiver if
  a device turns out to speak it), a folder-watch importer for i-Chroma
  II's PC software exports, and a hand-written HL7 v2 + MLLP parser kept in
  reserve for the newer networked "Swelab Alfa Plus" model in case the
  hospital's own turns out to have that interface after all (see
  `ANALYZER-INTERFACING.md`'s note on this — the model name was corrected
  mid-build from "Alfa Plus" to the base "Alfa," which changes the
  connection type from network to serial).
- **Analyzer Inbox** (Lab): every incoming analyzer message lands in a
  staging table first — auto-matched to a paid order by specimen ID when
  possible — and stays there until a technician reviews it and imports it
  into the ordinary result-entry screen. Nothing an analyzer sends is ever
  written directly into a saved result; the pathologist verification gate
  is unchanged.
- **Admin → Analyzer Interfacing**: per-analyzer connection settings
  (enable/disable, port/COM-port/watch-folder), live running status, a
  test-code mapping table (an analyzer's own code for a parameter, e.g.
  `WBC`, mapped to this system's own test/component name), and a
  recent-activity log.
- **Fixed while building this**: the qualitative-result dropdown (used for
  H. pylori, Toxoplasma, Brucella, Malaria, Typhidot, and any other test
  whose normal value is "Negative") had no "Positive" option at all —
  Trace/1+/2+/3+/4+ only, which is meant for urine dipstick semi-quantitative
  results, not binary infectious-serology results. Both option sets are now
  offered together.

## OPD Status Fix & Pharmacy Management System Upgrade (this update)

**Fixed: Admin dashboard kept showing patients as "still in OPD/waiting"
long after the Doctor Portal had already moved past them.** Root cause: a
visit sent to Pharmacy (`visits.status = 'waiting_pharmacy'`) had no path
back to `closed` — unlike the lab/radiology side, which already looped back
to the doctor correctly, nothing ever closed a visit out once pharmacy
dispensed the prescription. It stayed "open" forever, permanently inflating
the Admin/Doctor "In OPD" census count even though the Doctor Portal's own
queue (`waiting_doctor` only) had stopped showing that patient. Fixed in
two parts:
- `routes/pharmacy.routes.js` now auto-closes a visit the moment nothing is
  left pending on it (no other undispensed prescription, no pending lab or
  radiology order, and no unreviewed results-ready flag) — the same rule
  the lab/radiology side already uses to loop a visit back to the doctor,
  just completing the other end of the same lifecycle.
- **Migration v17** retroactively closes any visit that was already stuck
  this way before the fix existed, so upgrading doesn't require a fresh
  dispense on every old visit before the count corrects itself.
- The Hospital Census widget (Admin + Doctor dashboards) now also shows a
  precise **"Waiting to See Doctor"** figure — the exact same count the
  Doctor Portal's own queue is built from — alongside the broader
  **"In OPD (Clinic) — all stages"** figure (which intentionally still
  includes patients currently at the lab or pharmacy counter), so the two
  numbers can never be mistaken for each other again.

**Pharmacy Management System upgrade** (Migration v18, all additive — every
existing prescription/dispense/batch keeps working exactly as before):
- **Suppliers & Purchase Orders**: Admin/Pharmacy → Pharmacy page now has a
  Suppliers list and a Purchase Order workflow (create a PO against a
  supplier with line items and unit cost, then Receive it — in full or in
  part, across multiple deliveries if needed). Receiving a PO uses the exact
  same batch-creation path as manually adding inventory, tagged with the PO
  number as its reference, so received stock is immediately visible in
  Inventory and FEFO-eligible. Creating a PO never touches stock by itself —
  only Receiving does.
- **Controlled-substance (narcotics) register**: any drug can be flagged
  "controlled" (Admin only, in the new Controlled Substances section).
  Dispensing or selling a flagged drug — from a doctor's prescription or a
  walk-in sale — automatically writes an entry to the narcotics register
  (drug, quantity, batch, patient, prescriber, dispensing staff, receipt) in
  the same transaction as the sale itself, so a controlled drug can never
  leave the pharmacy without a register entry. The register itself is
  view-only from the app; only the controlled flag is editable.
- **Drug-drug and drug-allergy safety check**: a non-blocking check (seeded
  with a short list of well-established interaction pairs, e.g.
  Warfarin+Aspirin, Sildenafil+Nitrates) now runs on both the Doctor
  Portal's prescription screen and the Pharmacy dispense/POS screens,
  comparing the medicines involved against each other and against the
  patient's own recorded allergies. It only ever warns — it never blocks a
  prescription or a sale, consistent with how this system treats every
  other piece of automated decision support. Patients now have an
  **Allergies** field (set at registration, or edited later from the Doctor
  Portal) feeding this check.
- **Insurance / split-payment billing**: both the prescription-dispense
  screen and the walk-in POS screen now take an optional insurance provider
  and covered amount — the receipt shows the bill total, what insurance
  covered, and what the patient actually paid, and the daily report/exports
  keep working unchanged (`patient_payable` defaults to the full amount on
  every sale that doesn't use it, including all historical sales via a
  migration backfill).
- Every dispense and walk-in sale is now also written to the shared Audit
  Log (already visible under Admin → Audit Log), alongside the stock
  adjustments and returns that were already logged there.


## Roles

`admin`, `reception`, `doctor`, `lab`, `radiographer`, `pharmacy`, `nurse`, `or_manager` — an admin creates every account from the Admin page and assigns the role.

## Access control (strict, by design)

- **Only doctors** can create or edit admission orders, discharge summaries, and prescriptions. Nurses have no write access to any of these — enforced server-side, not just hidden in the UI.
- **Nurses** can view active doctor's orders and record that something was actually carried out — an injectable given, dosage confirmed, timestamped under their own ID. They cannot alter what was ordered.
- **Discharging a patient is now two steps**: a doctor must write a discharge summary first (diagnosis, condition, instructions, follow-up); only then can nursing/reception process the administrative discharge and charge. The system blocks the second step with a clear message if the first hasn't happened.

## Pharmacy stock integrity

- There is no edit or delete button for inventory anywhere in the system, by design. Once a batch is added, its quantity can only move in one of three ways:
  1. **A completed sale** (POS or prescription dispense) — automatic, FEFO (earliest-expiring stock first).
  2. **An approved stock adjustment** — pharmacy staff can *request* a wastage/damage/expired/return adjustment, but requesting it never touches stock. Only an admin approving it does, and every approval is logged.
  3. **Receiving a Purchase Order** — creates a new batch (or restocks an existing one) at the quantity actually received, which can be less than what was ordered if the supplier short-ships; the PO stays open until every line is fully received.
- Discounts at the point of sale are hard-capped at 1% server-side — even if the UI is bypassed and 5% is sent directly to the API, it's silently clamped to 1%.

## Lab & radiology pricing integrity

- Every test has a **locked price** set only by admin (Admin → Test Pricing). Lab/radiology staff cannot see or use a payment field — the amount charged is always computed server-side from the locked price at the moment of finalizing.
- A result cannot be finalized or printed until every test in that order has a price set. If one doesn't, the system blocks it and names exactly which test is missing pricing.
- All ~35 seeded tests ship with reasonable default prices so the lab isn't blocked on day one — adjust any of them from the Admin page.

## Daily closing reports

- **Admin → Daily Closing Reports**: pick a date, get both a Laboratory Daily Closing (tests conducted, itemized by patient/test/fee, total revenue) and a Pharmacy Daily Closing (purchases received that day, gross sales, cost of goods sold — computed from the actual batch cost of what was sold, not the current stock price — and net profit).
- "Print Owner Daily Receipt" gives a single clean page combining both reports, meant to be handed to the owner at end of day.

## Audit log & backups

- Every login and every time a staff member opens a patient's combined record is logged (who, when, which MR number) — visible to admin under "Audit Log".
- The database is backed up automatically once a day (kept 30 days), plus a "Back Up Now" button on the Admin page. Backups live in a `backups/` folder as complete, safe-to-copy snapshot files. **Still copy this folder to a USB drive or another PC periodically** — an automatic backup sitting on the same machine as the live database won't survive that machine failing entirely.

## Database architecture

- SQLite in **WAL (Write-Ahead Logging) mode**, which lets every station on the network read
  and write at the same time without locking each other out — this is what makes it hold up
  under continuous multi-station use rather than just single-user testing.
- Every foreign key and every column used in a search or filter (MR number, patient name,
  phone, visit status, order status, expiry date, dates used for revenue ranges, etc.) has a
  dedicated index, so lookups stay fast as the data grows.
- At roughly 1,000 patients/day, 3 years of continuous use lands well within a few million
  rows across all tables combined — comfortably inside what indexed SQLite handles without
  degrading, provided the `data/` folder lives on a normal local disk (not a network drive).
- **CSV/Excel export**: the Admin page has one-click exports (Patients, Visits, Lab Results,
  Pharmacy Sales, Inventory, Procedures, Revenue Summary) that open directly in Excel or
  Google Sheets — for offline reporting and an extra local backup layer beyond the database
  file itself.

## Master lists (drugs & tests)

- `drugs_master` and `tests_master` are pre-populated with ~45 common drugs and ~35 common
  tests (with reference ranges) across Hematology, Biochemistry, Special Chemistry, and
  Immunology, plus common Radiology studies — this is what powers the autocomplete.
- Adding a new inventory batch for a drug not yet in the list adds it automatically. To add
  more lab tests, or adjust a reference range, tell me and I'll add them to `seed.js` (or ask
  me to build an admin screen for editing the master lists directly).

## How it works technically

- One PC (call it "the server") runs this software and holds the database.
- Every other PC (reception desk, doctor's room, lab, pharmacy) just opens a normal
  web browser and visits the server PC's address — no software installed on those PCs.
- The database is a single file on the server PC (`data/clinic.db`) — back it up regularly
  (copy that one file to a USB drive periodically).
- Requires only **Node.js** on the server PC — no other software, no internet connection
  required to run it, and no third-party service ever sees patient data.

## One-time setup (on the server PC)

1. Install Node.js (version 22 or newer) from https://nodejs.org — download the Windows/Mac
   installer once while you have internet, then no internet is needed again.
2. Copy this whole `alnoor-clinic` folder onto that PC.
3. Open a terminal / command prompt in that folder and run:

   ```
   node server.js
   ```

4. You'll see something like:

   ```
   On this PC:  http://localhost:3000
   On the network (use this on other PCs):  http://192.168.1.5:3000
   ```

   That second address is what every other PC on the same WiFi/LAN should type into
   their browser.

5. To keep it running permanently (so it survives reboots / doesn't need a terminal window
   open), use the included PM2 configuration:

   ```
   npm install -g pm2        (one-time, needs internet — like installing Node.js itself)
   pm2 start ecosystem.config.js
   pm2 save
   pm2 startup               (then follow the one printed command to enable auto-start on boot)
   ```

   From then on, `pm2 restart alnoor-clinic`, `pm2 stop alnoor-clinic`, and
   `pm2 logs alnoor-clinic` manage it. Logs are written to `./logs/`.

## First login

- **Staff ID:** `admin`
- **Password:** `admin123`

**Log in as admin immediately and:**
1. Go to the Admin page and create real accounts for every department — you can create as
   many doctors, nurses, lab/radiology/pharmacy staff etc. as you need, each with their own
   staff ID and password.
2. Use "Change Password" (top right of every page) to change the default admin password.

## Upgrading from a previous version

This update added strict role separation, discharge-summary gating, pharmacy stock
adjustment approvals, and locked lab/radiology pricing. If you have **not** run the system
yet, there's nothing to do — first boot seeds sensible default test prices automatically.
If you already have a `data/clinic.db` with real patients or inventory in it, tell me before
replacing these files so I can check whether anything needs a migration step first.

## Data safety notes

- The database file (`data/clinic.db`) contains all patient records. Treat the server PC
  itself like a filing cabinet: physical access control, a login password on the PC, and
  regular backups matter more than anything else here.
- There is currently no built-in encryption-at-rest for the database file itself, and no
  audit log of who viewed which record (only who *entered* data is tracked). If you want
  those added, I can build them in — worth doing before this holds real patient volume.
- This system was built to run **offline and local only**. If it's ever exposed to the
  open internet (e.g. port-forwarded from a router), patient data would be reachable from
  outside the hospital — don't do that without proper access controls (HTTPS, a firewall,
  IP allow-listing) in place first.

## What's not built yet (possible next steps)

- Printable prescription hardcopy formatted like a real Rx pad (a proper letterhead-style layout, not just the on-screen list)
- An admin screen to edit the drugs/tests master lists directly, instead of asking me to update `seed.js`
- Purchase-order / reordering workflow when stock runs low
- A true PDF report generator for lab results (currently uses the browser's print-to-PDF, which works well but isn't a dedicated PDF engine)

Tell me which of these matters most and I'll build it next.
