// db.js — SQLite database setup for Al Noor Clinic System
// Uses Node's built-in node:sqlite module — zero external dependencies, by design:
// this server runs on a single hospital PC with no reliable internet access, so
// nothing here may require `npm install` to recover from a lost node_modules folder.
//
// Architecture notes:
// - WAL journal mode + a busy_timeout let every LAN station (reception, doctor, lab,
//   pharmacy, nursing, admin) read and write concurrently without lock errors.
// - All queries use `db.prepare(...).run/get/all(params)` — parameter binding, never
//   string concatenation — which is what actually prevents SQL injection in SQLite
//   (true throughout this codebase; formalized here as a hard rule for anyone
//   extending it: never build a query string from request input).
// - Schema changes go through the numbered `MIGRATIONS` array below, not ad-hoc
//   ALTER TABLE calls scattered through the code. Each migration runs at most once,
//   tracked in `schema_migrations`, so upgrading an existing hospital database never
//   requires wiping data.

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'clinic.db');
const db = new DatabaseSync(DB_PATH);

// ---------- Pragmas: concurrency & safety ----------
db.exec(`PRAGMA journal_mode = WAL;`);        // concurrent readers + one writer, no "database is locked" errors
db.exec(`PRAGMA synchronous = NORMAL;`);      // safe with WAL; durable across app crashes, fast enough for this scale
db.exec(`PRAGMA foreign_keys = ON;`);         // enforce referential integrity at the DB layer, not just in app code
db.exec(`PRAGMA busy_timeout = 5000;`);       // if two stations hit the same row, wait up to 5s instead of erroring immediately

// ---------- Base schema (idempotent — safe to run on every startup) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','reception','doctor','lab','pharmacy','radiographer','or_manager','nurse')),
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_staff_role ON staff(role);
CREATE INDEX IF NOT EXISTS idx_staff_active ON staff(active);

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mr_number TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  age TEXT,
  gender TEXT,
  phone TEXT,
  address TEXT,
  registered_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patients_mrn ON patients(mr_number);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(name);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);
CREATE INDEX IF NOT EXISTS idx_patients_created ON patients(created_at);

CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  reason TEXT,
  room TEXT,
  status TEXT NOT NULL DEFAULT 'waiting_doctor', -- waiting_doctor, with_doctor, waiting_lab, waiting_pharmacy, closed
  created_by TEXT,
  consultation_fee REAL,
  consultation_receipt_no TEXT,
  results_ready INTEGER NOT NULL DEFAULT 0, -- 1 = lab/radiology completed and doctor hasn't re-reviewed yet
  results_ready_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (patient_id) REFERENCES patients(id)
);
CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patient_id);
CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);
CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at);
CREATE INDEX IF NOT EXISTS idx_visits_results_ready ON visits(results_ready);
CREATE INDEX IF NOT EXISTS idx_visits_receipt ON visits(consultation_receipt_no);

CREATE TABLE IF NOT EXISTS examinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id INTEGER NOT NULL,
  doctor_id TEXT,
  notes TEXT,
  diagnosis TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (visit_id) REFERENCES visits(id)
);
CREATE INDEX IF NOT EXISTS idx_examinations_visit ON examinations(visit_id);
CREATE INDEX IF NOT EXISTS idx_examinations_doctor ON examinations(doctor_id);
CREATE INDEX IF NOT EXISTS idx_examinations_created ON examinations(created_at);

-- ===== LABORATORY MANAGEMENT =====

CREATE TABLE IF NOT EXISTS tests_master (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL, -- Hematology, Biochemistry, Special Chemistry, Immunology, Radiology
  unit TEXT,
  ref_low REAL,
  ref_high REAL,
  ref_text TEXT,
  components TEXT, -- JSON array for panel tests (e.g. CBC)
  default_price REAL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_tests_master_name ON tests_master(name);
CREATE INDEX IF NOT EXISTS idx_tests_master_category ON tests_master(category);

CREATE TABLE IF NOT EXISTS lab_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  ordered_by TEXT,
  tests TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  results TEXT,
  payment_amount REAL,
  receipt_no TEXT,
  entered_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (visit_id) REFERENCES visits(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id)
);
CREATE INDEX IF NOT EXISTS idx_lab_orders_visit ON lab_orders(visit_id);
CREATE INDEX IF NOT EXISTS idx_lab_orders_patient ON lab_orders(patient_id);
CREATE INDEX IF NOT EXISTS idx_lab_orders_status ON lab_orders(status);
CREATE INDEX IF NOT EXISTS idx_lab_orders_completed ON lab_orders(completed_at);
CREATE INDEX IF NOT EXISTS idx_lab_orders_receipt ON lab_orders(receipt_no);

CREATE TABLE IF NOT EXISTS radiology_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  ordered_by TEXT,
  tests TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  results TEXT,
  payment_amount REAL,
  receipt_no TEXT,
  entered_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (visit_id) REFERENCES visits(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id)
);
CREATE INDEX IF NOT EXISTS idx_rad_orders_visit ON radiology_orders(visit_id);
CREATE INDEX IF NOT EXISTS idx_rad_orders_patient ON radiology_orders(patient_id);
CREATE INDEX IF NOT EXISTS idx_rad_orders_status ON radiology_orders(status);
CREATE INDEX IF NOT EXISTS idx_rad_orders_completed ON radiology_orders(completed_at);

-- ===== PHARMACY MANAGEMENT =====

CREATE TABLE IF NOT EXISTS drugs_master (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  category TEXT,
  default_unit TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_drugs_master_name ON drugs_master(name);

CREATE TABLE IF NOT EXISTS drug_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drug_name TEXT NOT NULL,
  batch_number TEXT,
  quantity INTEGER NOT NULL DEFAULT 0,
  quantity_remaining INTEGER NOT NULL DEFAULT 0,
  expiry_date TEXT,
  purchase_price REAL DEFAULT 0,
  selling_price REAL DEFAULT 0,
  company_name TEXT,
  distributor_name TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_batches_drug_name ON drug_batches(drug_name);
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON drug_batches(expiry_date);
CREATE INDEX IF NOT EXISTS idx_batches_remaining ON drug_batches(quantity_remaining);
CREATE INDEX IF NOT EXISTS idx_batches_created ON drug_batches(created_at);

CREATE TABLE IF NOT EXISTS prescriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  doctor_id TEXT,
  medicines TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  FOREIGN KEY (visit_id) REFERENCES visits(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id)
);
CREATE INDEX IF NOT EXISTS idx_prescriptions_visit ON prescriptions(visit_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_patient ON prescriptions(patient_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_status ON prescriptions(status);

CREATE TABLE IF NOT EXISTS dispenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prescription_id INTEGER,
  patient_id INTEGER,
  items TEXT NOT NULL,
  subtotal REAL,
  discount_percent REAL DEFAULT 0,
  payment_amount REAL,
  receipt_no TEXT,
  dispensed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (prescription_id) REFERENCES prescriptions(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id)
);
CREATE INDEX IF NOT EXISTS idx_dispenses_patient ON dispenses(patient_id);
CREATE INDEX IF NOT EXISTS idx_dispenses_created ON dispenses(created_at);
CREATE INDEX IF NOT EXISTS idx_dispenses_receipt ON dispenses(receipt_no);

CREATE TABLE IF NOT EXISTS admissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  visit_id INTEGER,
  admitting_doctor TEXT,
  ward TEXT,
  room TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  discharge_charge REAL,
  discharge_receipt_no TEXT,
  discharged_by TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  discharged_at TEXT,
  FOREIGN KEY (patient_id) REFERENCES patients(id)
);
CREATE INDEX IF NOT EXISTS idx_admissions_patient ON admissions(patient_id);
CREATE INDEX IF NOT EXISTS idx_admissions_status ON admissions(status);

CREATE TABLE IF NOT EXISTS doctor_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id INTEGER NOT NULL,
  doctor_id TEXT,
  order_text TEXT NOT NULL,
  priority TEXT DEFAULT 'routine',
  status TEXT NOT NULL DEFAULT 'pending',
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  done_by TEXT,
  done_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (admission_id) REFERENCES admissions(id)
);
CREATE INDEX IF NOT EXISTS idx_doctor_orders_admission ON doctor_orders(admission_id);
CREATE INDEX IF NOT EXISTS idx_doctor_orders_status ON doctor_orders(status);

CREATE TABLE IF NOT EXISTS medication_administrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  nurse_id TEXT NOT NULL,
  dosage_confirmed TEXT,
  notes TEXT,
  administered_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (order_id) REFERENCES doctor_orders(id)
);
CREATE INDEX IF NOT EXISTS idx_med_admin_order ON medication_administrations(order_id);

CREATE TABLE IF NOT EXISTS discharge_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id INTEGER UNIQUE NOT NULL,
  doctor_id TEXT NOT NULL,
  diagnosis_summary TEXT,
  condition_at_discharge TEXT,
  discharge_instructions TEXT,
  follow_up TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (admission_id) REFERENCES admissions(id)
);

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  drug_name TEXT NOT NULL,
  adjustment_type TEXT NOT NULL,
  qty INTEGER NOT NULL,
  reason TEXT,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'pending',
  approved_by TEXT,
  approved_at TEXT,
  FOREIGN KEY (batch_id) REFERENCES drug_batches(id)
);
CREATE INDEX IF NOT EXISTS idx_stock_adj_status ON stock_adjustments(status);
CREATE INDEX IF NOT EXISTS idx_stock_adj_batch ON stock_adjustments(batch_id);

-- Immediate, pharmacist-level customer medicine return: a patient brings back
-- unused/unopened medicine from a specific sale receipt, the pharmacist verifies
-- it against that receipt and restocks + refunds on the spot. Deliberately
-- separate from stock_adjustments' admin-approval-gated 'return' type, which is
-- for wastage/damage/disposal write-offs, not customer refunds.
CREATE TABLE IF NOT EXISTS medicine_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_no TEXT UNIQUE NOT NULL,
  dispense_id INTEGER,
  original_receipt_no TEXT,
  patient_id INTEGER,
  drug_name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  refund_amount REAL NOT NULL,
  restock_batch_id INTEGER,
  reason TEXT,
  processed_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (dispense_id) REFERENCES dispenses(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (restock_batch_id) REFERENCES drug_batches(id)
);
CREATE INDEX IF NOT EXISTS idx_med_returns_receipt ON medicine_returns(original_receipt_no);
CREATE INDEX IF NOT EXISTS idx_med_returns_created ON medicine_returns(created_at);
CREATE INDEX IF NOT EXISTS idx_med_returns_dispense ON medicine_returns(dispense_id);

CREATE TABLE IF NOT EXISTS procedures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL,
  admission_id INTEGER,
  procedure_type TEXT NOT NULL,
  surgeon TEXT,
  scheduled_at TEXT,
  room TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  charge_amount REAL,
  receipt_no TEXT,
  created_by TEXT,
  completed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (patient_id) REFERENCES patients(id)
);
CREATE INDEX IF NOT EXISTS idx_procedures_patient ON procedures(patient_id);
CREATE INDEX IF NOT EXISTS idx_procedures_status ON procedures(status);
CREATE INDEX IF NOT EXISTS idx_procedures_completed ON procedures(completed_at);

CREATE TABLE IF NOT EXISTS birth_certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  certificate_no TEXT UNIQUE NOT NULL,
  patient_id INTEGER, -- the mother's patient record, if registered
  mr_number TEXT,
  baby_name TEXT NOT NULL,
  gender TEXT NOT NULL,
  date_of_birth TEXT NOT NULL,
  time_of_birth TEXT,
  father_name TEXT,
  mother_name TEXT,
  attending_doctor TEXT,
  weight TEXT,
  issued_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_birth_cert_mrn ON birth_certificates(mr_number);
CREATE INDEX IF NOT EXISTS idx_birth_cert_no ON birth_certificates(certificate_no);

CREATE TABLE IF NOT EXISTS death_certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  certificate_no TEXT UNIQUE NOT NULL,
  patient_id INTEGER,
  mr_number TEXT,
  deceased_name TEXT NOT NULL,
  age TEXT,
  gender TEXT,
  date_of_death TEXT NOT NULL,
  time_of_death TEXT,
  place_of_death TEXT,
  cause_of_death TEXT,
  attending_doctor TEXT,
  next_of_kin TEXT,
  issued_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_death_cert_mrn ON death_certificates(mr_number);
CREATE INDEX IF NOT EXISTS idx_death_cert_no ON death_certificates(certificate_no);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id TEXT,
  action TEXT NOT NULL,
  mr_number TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_mr ON audit_log(mr_number);
CREATE INDEX IF NOT EXISTS idx_audit_staff ON audit_log(staff_id);

-- Sessions doubles as the JWT revocation list: the token's jti (JWT ID) is the
-- primary key here. Deleting a row instantly invalidates that token everywhere,
-- even though the JWT itself would otherwise still verify until it expires.
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_staff ON sessions(staff_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- Versioned migrations ----------
// Anything that needs to change an EXISTING table (add a column, backfill data)
// goes here as a numbered, one-shot migration — never edit a migration once it has
// shipped; add a new one instead. This is what lets an already-deployed hospital
// database upgrade safely without anyone hand-running SQL or losing data.
const MIGRATIONS = [
  {
    version: 1,
    description: 'Add results_ready tracking columns to visits (doctor results-ready queue)',
    up() {
      ensureColumn('visits', 'results_ready', "INTEGER NOT NULL DEFAULT 0");
      ensureColumn('visits', 'results_ready_at', 'TEXT');
    }
  },
  {
    version: 2,
    description: 'Add expires_at to sessions for JWT expiry enforcement server-side',
    up() {
      ensureColumn('sessions', 'expires_at', 'TEXT');
    }
  },
  {
    version: 3,
    description: 'Add password_cost_n to staff so scrypt cost can be raised for new hashes without breaking existing ones',
    up() {
      // Existing rows keep the original Node scrypt default (N=16384) they were hashed
      // with; only new/changed passwords use the stronger cost going forward.
      ensureColumn('staff', 'password_cost_n', 'INTEGER NOT NULL DEFAULT 16384');
    }
  },
  {
    version: 4,
    description: 'Add order_source to lab/radiology orders (doctor-referred vs direct walk-in counter sale)',
    up() {
      ensureColumn('lab_orders', 'order_source', "TEXT NOT NULL DEFAULT 'doctor'");
      ensureColumn('radiology_orders', 'order_source', "TEXT NOT NULL DEFAULT 'doctor'");
    }
  },
  {
    version: 5,
    description: 'Split lab/radiology "done" into awaiting_payment -> done: printing is gated on payment, not on ordering or even on results entry',
    up() {
      ensureColumn('lab_orders', 'paid_at', 'TEXT');
      ensureColumn('radiology_orders', 'paid_at', 'TEXT');
      // Any order that was already fully "done" under the old one-step flow (results +
      // receipt generated atomically) is by definition already paid — backfill paid_at
      // from completed_at so historical revenue reporting doesn't change for old records.
      db.exec(`UPDATE lab_orders SET paid_at = completed_at WHERE status = 'done' AND paid_at IS NULL`);
      db.exec(`UPDATE radiology_orders SET paid_at = completed_at WHERE status = 'done' AND paid_at IS NULL`);
    }
  },
  {
    version: 6,
    description: 'Add units_per_pack to drug_batches for loose/unit tablet dispensing — quantity fields are always in individual units from here on',
    up() {
      ensureColumn('drug_batches', 'units_per_pack', 'INTEGER NOT NULL DEFAULT 1');
    }
  },
  {
    version: 7,
    description: 'Add patient_type to patients so true unregistered lab walk-ins (no MRN required at reception) can be distinguished from formally registered patients',
    up() {
      ensureColumn('patients', 'patient_type', "TEXT NOT NULL DEFAULT 'REGISTERED'");
    }
  },
  {
    version: 8,
    description: 'Add invoice_number to drug_batches so distributor purchases can be traced to a specific supplier invoice/bill in reporting',
    up() {
      ensureColumn('drug_batches', 'invoice_number', 'TEXT');
    }
  },
  {
    version: 9,
    description: 'Add vitals table so nursing can record/track inpatient vital signs against an admission',
    up() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS vitals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          admission_id INTEGER NOT NULL,
          recorded_by TEXT NOT NULL,
          temperature_c REAL,
          pulse_bpm INTEGER,
          resp_rate INTEGER,
          bp_systolic INTEGER,
          bp_diastolic INTEGER,
          spo2 REAL,
          notes TEXT,
          recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (admission_id) REFERENCES admissions(id)
        );
        CREATE INDEX IF NOT EXISTS idx_vitals_admission ON vitals(admission_id);
        CREATE INDEX IF NOT EXISTS idx_vitals_recorded ON vitals(recorded_at);
      `);
    }
  },
  {
    version: 10,
    description: 'Upgrade Urine R/E from a single free-text line to a full multi-parameter panel (physical/chemical/microscopic), matching how CBC and other panel tests already work',
    up() {
      const components = [
        { name: 'Colour', ref_text: 'Pale Yellow' },
        { name: 'Appearance', ref_text: 'Clear' },
        { name: 'Specific Gravity', ref_low: 1.005, ref_high: 1.030 },
        { name: 'pH', ref_low: 4.5, ref_high: 8.0 },
        { name: 'Protein', ref_text: 'Negative' },
        { name: 'Glucose', ref_text: 'Negative' },
        { name: 'Ketones', ref_text: 'Negative' },
        { name: 'Bilirubin', ref_text: 'Negative' },
        { name: 'Urobilinogen', ref_text: 'Normal' },
        { name: 'Blood', ref_text: 'Negative' },
        { name: 'Nitrite', ref_text: 'Negative' },
        { name: 'Leukocyte Esterase', ref_text: 'Negative' },
        { name: 'Pus Cells (WBC)', unit: '/HPF', ref_low: 0, ref_high: 5 },
        { name: 'Red Blood Cells', unit: '/HPF', ref_low: 0, ref_high: 2 },
        { name: 'Epithelial Cells', ref_text: 'Few' },
        { name: 'Casts', ref_text: 'Nil' },
        { name: 'Crystals', ref_text: 'Nil' },
        { name: 'Bacteria', ref_text: 'Nil / Occasional' },
        { name: 'Mucus Threads', ref_text: 'Nil / Occasional' }
      ];
      // Only touch the row if it still looks like the old single-line version
      // (no components yet) — never overwrite a hospital's own edits to this test.
      const existing = db.prepare(`SELECT id, components FROM tests_master WHERE name = 'Urine R/E'`).get();
      if (existing && !existing.components) {
        db.prepare(`UPDATE tests_master SET unit = NULL, ref_low = NULL, ref_high = NULL, ref_text = NULL, components = ? WHERE id = ?`)
          .run(JSON.stringify(components), existing.id);
      } else if (!existing) {
        db.prepare(`
          INSERT INTO tests_master (name, category, components, default_price)
          VALUES ('Urine R/E', 'Immunology', ?, 250)
        `).run(JSON.stringify(components));
      }
    }
  },
  {
    version: 11,
    description: "Add 'phlebotomist' and 'pathologist' roles to staff (LMS payment-gate workflow needs a specimen-collection role distinct from general lab tech, and a report-verification role distinct from general lab tech). SQLite cannot ALTER a CHECK constraint in place, so this rebuilds the table.",
    up() {
      db.exec(`
        CREATE TABLE staff_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          staff_id TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin','reception','doctor','lab','pharmacy','radiographer','or_manager','nurse','phlebotomist','pathologist')),
          password_hash TEXT NOT NULL,
          salt TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          password_cost_n INTEGER NOT NULL DEFAULT 16384
        );
        INSERT INTO staff_new (id, staff_id, name, role, password_hash, salt, active, created_at, password_cost_n)
          SELECT id, staff_id, name, role, password_hash, salt, active, created_at, password_cost_n FROM staff;
        DROP TABLE staff;
        ALTER TABLE staff_new RENAME TO staff;
        CREATE INDEX IF NOT EXISTS idx_staff_role ON staff(role);
        CREATE INDEX IF NOT EXISTS idx_staff_active ON staff(active);
      `);
    }
  },
  {
    version: 12,
    description: 'LMS upfront-payment-gate workflow: add specimen/collection/verification/delivery tracking columns to lab_orders and remap old status vocabulary to the new one (pending->PENDING_PAYMENT, awaiting_payment->PENDING_PAYMENT, done->DELIVERED). Historical rows keep their payment/results data untouched.',
    up() {
      ensureColumn('lab_orders', 'specimen_id', 'TEXT');
      ensureColumn('lab_orders', 'collected_by', 'TEXT');
      ensureColumn('lab_orders', 'collected_at', 'TEXT');
      ensureColumn('lab_orders', 'processing_started_by', 'TEXT');
      ensureColumn('lab_orders', 'processing_started_at', 'TEXT');
      ensureColumn('lab_orders', 'verified_by', 'TEXT');
      ensureColumn('lab_orders', 'verified_at', 'TEXT');
      ensureColumn('lab_orders', 'delivered_by', 'TEXT');
      ensureColumn('lab_orders', 'delivered_at', 'TEXT');
      ensureColumn('lab_orders', 'cancelled_by', 'TEXT');
      ensureColumn('lab_orders', 'cancelled_at', 'TEXT');
      ensureColumn('lab_orders', 'cancel_reason', 'TEXT');
      // Historical status remap. A row that already reached 'done' under the old flow
      // (results entered AND paid, in whichever order) is fully finished: treat it as
      // DELIVERED so it keeps showing in completed-orders history/reporting. A row still
      // sitting at 'pending' or 'awaiting_payment' had no results yet, so it safely
      // restarts at the front of the new payment-gated queue.
      db.exec(`UPDATE lab_orders SET status = 'DELIVERED', delivered_at = COALESCE(delivered_at, completed_at) WHERE status = 'done'`);
      db.exec(`UPDATE lab_orders SET status = 'PENDING_PAYMENT' WHERE status IN ('pending', 'awaiting_payment')`);
      db.exec(`UPDATE radiology_orders SET status = 'DELIVERED', paid_at = COALESCE(paid_at, completed_at) WHERE status = 'done' AND paid_at IS NULL`);
    }
  },
  {
    version: 13,
    description: 'Add test_reference_ranges for age/sex-stratified normal ranges (e.g. FSH pre/post-menopausal, pediatric vs adult TSH) — a test or a component name can have multiple rows here, each scoped by sex and an age band, resolved most-specific-first at result-entry and report-print time.',
    up() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS test_reference_ranges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          test_name TEXT NOT NULL,
          component_name TEXT, -- NULL = applies to the test itself (non-panel test)
          sex TEXT NOT NULL DEFAULT 'ANY', -- 'M', 'F', or 'ANY'
          age_min_years REAL NOT NULL DEFAULT 0,
          age_max_years REAL NOT NULL DEFAULT 150,
          unit TEXT,
          ref_low REAL,
          ref_high REAL,
          ref_text TEXT,
          label TEXT, -- human-readable band name for admin UI, e.g. "Post-menopausal"
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_ref_ranges_test ON test_reference_ranges(test_name);
        CREATE INDEX IF NOT EXISTS idx_ref_ranges_lookup ON test_reference_ranges(test_name, component_name, sex);
      `);
    }
  },
  {
    version: 14,
    description: 'Seed the 11 mandatory new lab tests (H. pylori, TSH, FSH, Prolactin, CA125, Toxoplasma, Brucella, ALT/SGPT, Malaria, Typhidot, Calcium) with standard reference ranges, plus a few illustrative age/sex-stratified bands. Only inserts a test if no test of that exact name already exists — never overwrites a hospitals own edits or an identically-named test they already created.',
    up() {
      const insertTest = db.prepare(`
        INSERT INTO tests_master (name, category, unit, ref_low, ref_high, ref_text, components, default_price)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const exists = (name) => !!db.prepare('SELECT id FROM tests_master WHERE name = ?').get(name);
      const addIfMissing = (name, category, { unit = null, ref_low = null, ref_high = null, ref_text = null, components = null } = {}, price) => {
        if (exists(name)) return;
        insertTest.run(name, category, unit, ref_low, ref_high, ref_text, components ? JSON.stringify(components) : null, price);
      };

      addIfMissing('H. pylori (Ag/Ab)', 'Serology', {
        components: [
          { name: 'H. pylori Antigen', ref_text: 'Negative' },
          { name: 'H. pylori Antibody (IgG)', ref_text: 'Negative' }
        ]
      }, 1800);

      addIfMissing('TSH', 'Endocrinology', { unit: 'mIU/L', ref_low: 0.4, ref_high: 4.0 }, 1200);

      addIfMissing('FSH', 'Endocrinology', {
        unit: 'mIU/mL', ref_text: 'Varies by sex and menopausal status — see stratified ranges'
      }, 1500);

      addIfMissing('PROLACTIN', 'Endocrinology', {
        unit: 'ng/mL', ref_text: 'Varies by sex — see stratified ranges'
      }, 1600);

      addIfMissing('CA125', 'Special Chemistry', { unit: 'U/mL', ref_low: 0, ref_high: 35 }, 3500);

      addIfMissing('TOXOPLASMA (IgG/IgM)', 'Serology', {
        components: [
          { name: 'Toxoplasma IgG', ref_text: 'Negative' },
          { name: 'Toxoplasma IgM', ref_text: 'Negative' }
        ]
      }, 2200);

      addIfMissing('BRUCELLA', 'Serology', { ref_text: 'Negative' }, 900);

      addIfMissing('ALT/SGPT', 'Biochemistry', {
        unit: 'U/L', ref_text: 'Varies by sex — see stratified ranges (generic adult: 7-56 U/L)'
      }, 400);

      addIfMissing('MALARIA (ICT/Smear)', 'Serology', {
        components: [
          { name: 'ICT (Rapid Antigen)', ref_text: 'Negative' },
          { name: 'Peripheral Smear (MP)', ref_text: 'Negative' }
        ]
      }, 700);

      addIfMissing('TYPHIDOT (IgG/IgM)', 'Serology', {
        components: [
          { name: 'Typhidot IgG', ref_text: 'Negative' },
          { name: 'Typhidot IgM', ref_text: 'Negative' }
        ]
      }, 1000);

      addIfMissing('CALCIUM (Total/Ionized)', 'Biochemistry', {
        components: [
          { name: 'Calcium (Total)', unit: 'mg/dL', ref_low: 8.5, ref_high: 10.5 },
          { name: 'Calcium (Ionized)', unit: 'mmol/L', ref_low: 1.15, ref_high: 1.35 }
        ]
      }, 800);

      // A few illustrative stratified bands so the age/sex resolution feature
      // (test_reference_ranges, migration v13) has real, useful defaults out of
      // the box for the tests where it matters most clinically. A hospital can
      // add, edit, or remove any of these later from Admin -> Lab Test Catalog
      // -> Ranges; nothing here is required for the tests above to work.
      const addBand = db.prepare(`
        INSERT INTO test_reference_ranges (test_name, component_name, sex, age_min_years, age_max_years, unit, ref_low, ref_high, ref_text, label)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const bandExists = (test_name, sex, age_min, age_max) =>
        !!db.prepare('SELECT id FROM test_reference_ranges WHERE test_name = ? AND sex = ? AND age_min_years = ? AND age_max_years = ?').get(test_name, sex, age_min, age_max);
      const addBandIfMissing = (test_name, sex, age_min, age_max, unit, ref_low, ref_high, label) => {
        if (bandExists(test_name, sex, age_min, age_max)) return;
        addBand.run(test_name, null, sex, age_min, age_max, unit, ref_low, ref_high, null, label);
      };

      if (exists('FSH')) {
        addBandIfMissing('FSH', 'M', 0, 150, 'mIU/mL', 1.5, 12.4, 'Adult male');
        addBandIfMissing('FSH', 'F', 0, 50, 'mIU/mL', 3.5, 12.5, 'Reproductive age');
        addBandIfMissing('FSH', 'F', 50, 150, 'mIU/mL', 25.8, 134.8, 'Post-menopausal');
      }
      if (exists('PROLACTIN')) {
        addBandIfMissing('PROLACTIN', 'M', 0, 150, 'ng/mL', 4.0, 15.2, 'Adult male');
        addBandIfMissing('PROLACTIN', 'F', 0, 150, 'ng/mL', 4.8, 23.3, 'Adult female (non-pregnant)');
      }
      if (exists('TSH')) {
        addBandIfMissing('TSH', 'ANY', 0, 0.08, 'mIU/L', 1.0, 39.0, 'Neonate (0-1 month)');
        addBandIfMissing('TSH', 'ANY', 0.08, 18, 'mIU/L', 0.7, 6.4, 'Pediatric');
      }
      if (exists('ALT/SGPT')) {
        addBandIfMissing('ALT/SGPT', 'M', 0, 150, 'U/L', 10, 40, 'Adult male');
        addBandIfMissing('ALT/SGPT', 'F', 0, 150, 'U/L', 7, 35, 'Adult female');
      }
    }
  },
  {
    version: 15,
    description: 'Analyzer interfacing (Phase 2): analyzer_config (per-device connection settings), analyzer_result_inbox (a staging area every incoming analyzer message lands in — NEVER written directly into lab_orders.results; a human always reviews/imports via the normal result-entry screen), and analyzer_test_map (admin-maintained mapping from an analyzer\'s own code/name for a parameter to this system\'s test/component name, since that mapping cannot be known until real hardware output has been observed). Seeds three disabled analyzer_config rows for the hospital\'s actual hardware (Swelab Alfa Plus over TCP/HL7, Microlab 300 over serial, i-Chroma II via folder-watch) so Admin has something to switch on and configure rather than starting from nothing.',
    up() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS analyzer_config (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          analyzer_key TEXT UNIQUE NOT NULL,
          display_name TEXT NOT NULL,
          connection_type TEXT NOT NULL CHECK(connection_type IN ('tcp_server','serial','file_watch')),
          enabled INTEGER NOT NULL DEFAULT 0,
          config_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS analyzer_result_inbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          analyzer_key TEXT NOT NULL,
          received_at TEXT NOT NULL DEFAULT (datetime('now')),
          raw_payload TEXT NOT NULL,
          parsed_json TEXT NOT NULL DEFAULT '{}',
          specimen_id_guess TEXT,
          match_status TEXT NOT NULL DEFAULT 'unmatched' CHECK(match_status IN ('unmatched','matched','imported','discarded')),
          matched_order_id INTEGER,
          matched_by TEXT,
          matched_at TEXT,
          imported_by TEXT,
          imported_at TEXT,
          notes TEXT,
          FOREIGN KEY (matched_order_id) REFERENCES lab_orders(id)
        );
        CREATE INDEX IF NOT EXISTS idx_analyzer_inbox_status ON analyzer_result_inbox(match_status);
        CREATE INDEX IF NOT EXISTS idx_analyzer_inbox_received ON analyzer_result_inbox(received_at);
        CREATE INDEX IF NOT EXISTS idx_analyzer_inbox_specimen ON analyzer_result_inbox(specimen_id_guess);

        CREATE TABLE IF NOT EXISTS analyzer_test_map (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          analyzer_key TEXT NOT NULL,
          source_code TEXT NOT NULL,
          target_test_name TEXT NOT NULL,
          target_component_name TEXT,
          unit_override TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(analyzer_key, source_code)
        );
      `);

      const insertConfig = db.prepare(`
        INSERT INTO analyzer_config (analyzer_key, display_name, connection_type, enabled, config_json)
        VALUES (?, ?, ?, 0, ?)
      `);
      const configExists = (key) => !!db.prepare('SELECT id FROM analyzer_config WHERE analyzer_key = ?').get(key);
      const seedConfig = (key, display_name, connection_type, config) => {
        if (configExists(key)) return;
        insertConfig.run(key, display_name, connection_type, JSON.stringify(config));
      };

      // Swelab Alfa Plus talks HL7 over a network (TCP) connection, not classic
      // serial ASTM — our server just listens on a port and the analyzer's own
      // LIS/network settings menu is pointed at this PC's IP and this port.
      seedConfig('swelab_alfa', 'Swelab Alfa Plus (Hematology)', 'tcp_server', { port: 6661 });

      // Microlab 300's exact RS-232 output format is not publicly documented,
      // so this starts with placeholder serial settings the hospital's own IT/
      // biomedical engineer must confirm against the analyzer's own communication
      // setup menu once it's wired up (COM port, baud rate, parity, data/stop bits).
      seedConfig('microlab_300', 'Microlab 300 (Chemistry)', 'serial', {
        comPort: 'COM3', baudRate: 9600, parity: 'None', dataBits: 8, stopBits: 1
      });

      // i-Chroma II has no documented open serial/network protocol for direct
      // integration — Boditech's own PC software is required, and (per its own
      // manual) that software's export/print-to-file capability is unconfirmed.
      // This watches a folder for whatever delimited export file that software
      // can produce; the column mapping is configured once a real file is seen.
      seedConfig('ichroma_ii', 'i-Chroma II (Special Chemistry / Immunoassay)', 'file_watch', {
        watchFolder: '', filePattern: '*.csv', delimiter: 'auto', hasHeaderRow: true, columnMap: {}
      });
    }
  },
  {
    version: 16,
    description: 'Correct the Swelab analyzer_config default: v15 seeded it as a "Swelab Alfa Plus" networked (HL7/TCP) device, based on that newer model\'s published manual — the hospital\'s actual unit is the older/base "Swelab Alfa" (no "Plus"), whose manual documents only a classic RS-232 serial port, no LAN/HL7 interface. Switches the seeded row to a serial connection (matching Microlab 300\'s bridge) — but ONLY if nobody has already changed it away from the original v15 default, so a hospital that already customized this analyzer\'s settings is never silently overwritten.',
    up() {
      const row = db.prepare("SELECT * FROM analyzer_config WHERE analyzer_key = 'swelab_alfa'").get();
      if (!row) return; // nothing to correct on a brand-new install seeded directly at v16+
      const stillOriginalDefault = row.connection_type === 'tcp_server' && row.config_json === JSON.stringify({ port: 6661 });
      if (!stillOriginalDefault) return; // already reconfigured by an admin — leave it alone
      db.prepare(`
        UPDATE analyzer_config
        SET display_name = 'Swelab Alfa (Hematology)',
            connection_type = 'serial',
            config_json = ?,
            updated_at = datetime('now')
        WHERE analyzer_key = 'swelab_alfa'
      `).run(JSON.stringify({ comPort: 'COM3', baudRate: 9600, parity: 'None', dataBits: 8, stopBits: 1 }));
    }
  },
  {
    version: 17,
    description: 'Fix OPD status desync: dispensing a prescription never closed the visit it belonged to (visits.status stayed \'waiting_pharmacy\' forever), so the Admin dashboard\'s "In OPD" census kept counting patients the Doctor Portal\'s own queue had already stopped showing as waiting. routes/pharmacy.routes.js now auto-closes a visit the moment nothing is left pending on it (see closeVisitIfNothingPending there) — this migration is the one-time catch-up for visits that were already stuck this way before that fix existed, so hospitals upgrading from an earlier build don\'t have to wait for a fresh dispense on each one to see their OPD count correct itself. Deliberately conservative, same rule as the ongoing fix: only closes a visit with zero pending prescriptions, zero pending lab orders, zero pending radiology orders, and no unreviewed results_ready flag — anything ambiguous is left exactly as-is for a doctor to close manually.',
    up() {
      const LAB_RESOLVED = ['done', 'DELIVERED', 'VERIFIED', 'RESULT_ENTERED', 'cancelled'];
      const RAD_RESOLVED = ['done', 'cancelled'];
      const candidates = db.prepare("SELECT id FROM visits WHERE status != 'closed' AND results_ready = 0").all();
      let closedCount = 0;
      for (const { id: visitId } of candidates) {
        const pendingRx = db.prepare("SELECT COUNT(*) c FROM prescriptions WHERE visit_id = ? AND status != 'dispensed'").get(visitId).c;
        if (pendingRx > 0) continue;
        const pendingLab = db.prepare(
          `SELECT COUNT(*) c FROM lab_orders WHERE visit_id = ? AND status NOT IN (${LAB_RESOLVED.map(() => '?').join(',')})`
        ).get(visitId, ...LAB_RESOLVED).c;
        if (pendingLab > 0) continue;
        const pendingRad = db.prepare(
          `SELECT COUNT(*) c FROM radiology_orders WHERE visit_id = ? AND status NOT IN (${RAD_RESOLVED.map(() => '?').join(',')})`
        ).get(visitId, ...RAD_RESOLVED).c;
        if (pendingRad > 0) continue;
        // A visit with NO prescriptions, lab orders, or radiology orders at all
        // (e.g. a consultation-only visit the doctor simply never clicked "Close
        // this visit" on) technically also passes all three checks above with
        // zero pending counts. Retroactively closing those too is deliberate:
        // this migration runs once, right after upgrade, specifically to make
        // the OPD count reflect reality again — a visit with nothing outstanding
        // belongs in 'closed' either way.
        db.prepare("UPDATE visits SET status = 'closed' WHERE id = ?").run(visitId);
        closedCount++;
      }
      if (closedCount > 0) console.log(`[migrations] v17: retroactively closed ${closedCount} stale OPD visit(s) with nothing pending`);
    }
  },
  {
    version: 18,
    description: 'Pharmacy Management System upgrade: supplier/Purchase-Order workflow (suppliers, purchase_orders, purchase_order_items), controlled-substance (narcotics) register (drugs_master.is_controlled + narcotics_log, written automatically on every dispense/sale of a flagged drug), a lightweight drug-drug and drug-allergy interaction check (drug_interactions, seeded with a handful of well-established pairs, plus patients.allergies so a prescriber/pharmacist can see what a patient is allergic to), and insurance/split-payment fields on dispenses (insurance_provider, insurance_covered_amount, patient_payable) for POS billing. All additive — existing prescriptions/dispenses/batches keep working exactly as before.',
    up() {
      ensureColumn('patients', 'allergies', 'TEXT');
      ensureColumn('drugs_master', 'is_controlled', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn('dispenses', 'insurance_provider', 'TEXT');
      ensureColumn('dispenses', 'insurance_covered_amount', 'REAL NOT NULL DEFAULT 0');
      ensureColumn('dispenses', 'patient_payable', 'REAL');
      // Backfill: for every existing sale, the patient paid the full amount out of
      // pocket (insurance didn't exist as a concept yet) — patient_payable should
      // equal payment_amount, not be left NULL/0, so old receipts still total correctly.
      db.exec(`UPDATE dispenses SET patient_payable = payment_amount WHERE patient_payable IS NULL`);

      db.exec(`
        CREATE TABLE IF NOT EXISTS suppliers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          contact_person TEXT,
          phone TEXT,
          email TEXT,
          address TEXT,
          license_number TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);

        CREATE TABLE IF NOT EXISTS purchase_orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          po_number TEXT UNIQUE NOT NULL,
          supplier_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft', -- draft, ordered, partially_received, received, cancelled
          notes TEXT,
          expected_date TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT,
          FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
        );
        CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);

        CREATE TABLE IF NOT EXISTS purchase_order_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          po_id INTEGER NOT NULL,
          drug_name TEXT NOT NULL,
          qty_ordered INTEGER NOT NULL,
          qty_received INTEGER NOT NULL DEFAULT 0,
          unit_cost REAL NOT NULL DEFAULT 0,
          FOREIGN KEY (po_id) REFERENCES purchase_orders(id)
        );
        CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id);

        -- One row per controlled-drug dispensing event, whether it came off a
        -- doctor's prescription or a walk-in counter sale — the register a
        -- narcotics inspection actually asks for: who received it, how much,
        -- which batch, who dispensed it, and (when there was one) which doctor
        -- prescribed it and which visit it belongs to. Never edited or deleted
        -- from the app once written.
        CREATE TABLE IF NOT EXISTS narcotics_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          drug_name TEXT NOT NULL,
          batch_id INTEGER,
          batch_number TEXT,
          qty INTEGER NOT NULL,
          patient_id INTEGER,
          patient_name TEXT,
          prescription_id INTEGER,
          prescriber_id TEXT,
          dispense_id INTEGER,
          receipt_no TEXT,
          dispensed_by TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_narcotics_drug ON narcotics_log(drug_name);
        CREATE INDEX IF NOT EXISTS idx_narcotics_created ON narcotics_log(created_at);

        -- Deliberately a short, conservative reference list, not an attempt at a
        -- complete drug-interaction database (no open, offline-usable dataset of
        -- that scope exists to seed this from) — a starting set of well-established
        -- pairs a hospital pharmacist can immediately recognize as correct, with an
        -- admin-editable table so more can be added as the hospital's own formulary
        -- calls for it. Matching is by substring against a prescription/sale's drug
        -- names, so it also catches brand names that contain the generic name.
        CREATE TABLE IF NOT EXISTS drug_interactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          drug_a TEXT NOT NULL,
          drug_b TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'moderate', -- minor, moderate, severe
          note TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      const seedInteractions = [
        ['Warfarin', 'Aspirin', 'severe', 'Combined anticoagulant/antiplatelet effect — significantly increased bleeding risk.'],
        ['Warfarin', 'Ibuprofen', 'severe', 'NSAIDs increase bleeding risk and can displace warfarin from protein binding.'],
        ['Warfarin', 'Metronidazole', 'severe', 'Metronidazole inhibits warfarin metabolism — can sharply raise INR.'],
        ['Methotrexate', 'Ibuprofen', 'severe', 'NSAIDs reduce methotrexate renal clearance — risk of toxicity.'],
        ['ACE Inhibitor', 'Potassium', 'moderate', 'Combined use raises hyperkalemia risk — applies to ACE-inhibitor-class drugs (e.g. Lisinopril, Enalapril, Captopril).'],
        ['Metformin', 'Contrast', 'moderate', 'Hold metformin around iodinated contrast studies — risk of contrast-induced lactic acidosis in renal impairment.'],
        ['Sildenafil', 'Nitrate', 'severe', 'Severe, potentially fatal hypotension — applies to nitrate-class drugs (e.g. Isosorbide, Nitroglycerin, GTN).'],
        ['Clarithromycin', 'Statin', 'severe', 'Strong CYP3A4 inhibition raises statin levels — risk of rhabdomyolysis (e.g. with Simvastatin, Atorvastatin).'],
        ['Aspirin', 'Ibuprofen', 'minor', 'Ibuprofen can blunt aspirin\'s antiplatelet effect if taken together regularly.'],
        ['Tramadol', 'SSRI', 'moderate', 'Combined serotonergic effect — risk of serotonin syndrome (applies to SSRI-class antidepressants, e.g. Fluoxetine, Sertraline).']
      ];
      const insertInteraction = db.prepare('INSERT INTO drug_interactions (drug_a, drug_b, severity, note) VALUES (?, ?, ?, ?)');
      for (const [a, b, severity, note] of seedInteractions) insertInteraction.run(a, b, severity, note);
    }
  }
];

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function runMigrations() {
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      m.up();
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
      db.exec('COMMIT');
      console.log(`[migrations] applied v${m.version}: ${m.description}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration v${m.version} failed: ${err.message}`);
    }
  }
}
runMigrations();

// ---------- Helpers ----------
function nextCounter(name, prefix, pad = 5) {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name);
  let val;
  if (!row) {
    val = 1;
    db.prepare('INSERT INTO counters (name, value) VALUES (?, ?)').run(name, val);
  } else {
    val = row.value + 1;
    db.prepare('UPDATE counters SET value = ? WHERE name = ?').run(val, name);
  }
  return prefix + String(val).padStart(pad, '0');
}

function logAudit(staff_id, action, mr_number, detail) {
  db.prepare('INSERT INTO audit_log (staff_id, action, mr_number, detail) VALUES (?, ?, ?, ?)')
    .run(staff_id || null, action, mr_number || null, detail || null);
}

// Graceful shutdown: SQLite in WAL mode can leave -wal/-shm files if killed
// mid-write. Closing the handle properly on exit checkpoints WAL back into the
// main file and prevents corruption on the next start.
function closeDatabase() {
  try { db.close(); console.log('[db] closed cleanly'); }
  catch (err) { console.error('[db] error closing:', err.message); }
}

// ---------- Transaction helper ----------
// Wraps a sequence of db.prepare(...).run/get/all calls in BEGIN/COMMIT, rolling
// back automatically if `fn` throws. Route handlers that perform more than one
// write that must succeed or fail together (stock deduction + receipt insert,
// certificate issuance, discharge processing, etc.) should use this instead of
// issuing bare statements, so a mid-operation failure never leaves the database
// in a half-written state (e.g. stock deducted but no receipt recorded).
// node:sqlite's DatabaseSync has no built-in `.transaction()` wrapper (unlike
// better-sqlite3), so this hand-rolls the same BEGIN/COMMIT/ROLLBACK pattern
// already used by runMigrations() above. A flat transaction is sufficient for
// every call site in this codebase — nothing here nests transactions.
function withTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
  }
}

module.exports = { db, DB_PATH, nextCounter, logAudit, closeDatabase, withTransaction };
