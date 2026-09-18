// seed.js — pre-populates drugs_master and tests_master with common defaults.
// Runs once (idempotent — uses INSERT OR IGNORE) at server startup.
// Test prices are seeded with reasonable defaults so the lab isn't blocked on day
// one; admin can adjust any of them afterward from the Admin > Test Pricing screen.

const { db } = require('./db');

const DRUGS = [
  ['Paracetamol', 'Analgesic/Antipyretic', 'tablet'],
  ['Paracetamol Syrup', 'Analgesic/Antipyretic', 'bottle'],
  ['Ibuprofen', 'NSAID', 'tablet'],
  ['Diclofenac Sodium', 'NSAID', 'tablet'],
  ['Aspirin', 'NSAID/Antiplatelet', 'tablet'],
  ['Tramadol', 'Analgesic', 'tablet'],
  ['Amoxicillin', 'Antibiotic', 'capsule'],
  ['Amoxicillin Syrup', 'Antibiotic', 'bottle'],
  ['Augmentin (Amoxicillin+Clavulanate)', 'Antibiotic', 'tablet'],
  ['Azithromycin', 'Antibiotic', 'tablet'],
  ['Ciprofloxacin', 'Antibiotic', 'tablet'],
  ['Metronidazole', 'Antibiotic', 'tablet'],
  ['Ceftriaxone Injection', 'Antibiotic', 'vial'],
  ['Cefixime', 'Antibiotic', 'tablet'],
  ['Doxycycline', 'Antibiotic', 'capsule'],
  ['Omeprazole', 'Antacid/PPI', 'capsule'],
  ['Pantoprazole', 'Antacid/PPI', 'tablet'],
  ['Ranitidine', 'Antacid', 'tablet'],
  ['Domperidone', 'Antiemetic', 'tablet'],
  ['Metoclopramide', 'Antiemetic', 'tablet'],
  ['Ondansetron', 'Antiemetic', 'tablet'],
  ['Metformin', 'Antidiabetic', 'tablet'],
  ['Glimepiride', 'Antidiabetic', 'tablet'],
  ['Insulin (Regular)', 'Antidiabetic', 'vial'],
  ['Amlodipine', 'Antihypertensive', 'tablet'],
  ['Losartan', 'Antihypertensive', 'tablet'],
  ['Atenolol', 'Antihypertensive/Beta-blocker', 'tablet'],
  ['Furosemide', 'Diuretic', 'tablet'],
  ['Atorvastatin', 'Statin', 'tablet'],
  ['Cetirizine', 'Antihistamine', 'tablet'],
  ['Loratadine', 'Antihistamine', 'tablet'],
  ['Salbutamol Inhaler', 'Bronchodilator', 'inhaler'],
  ['Prednisolone', 'Corticosteroid', 'tablet'],
  ['Dexamethasone', 'Corticosteroid', 'injection'],
  ['Hydrocortisone', 'Corticosteroid', 'injection'],
  ['Vitamin B Complex', 'Supplement', 'tablet'],
  ['Folic Acid', 'Supplement', 'tablet'],
  ['Ferrous Sulfate', 'Supplement', 'tablet'],
  ['Iron Syrup', 'Supplement', 'bottle'],
  ['Calcium Carbonate', 'Supplement', 'tablet'],
  ['Multivitamin', 'Supplement', 'tablet'],
  ['ORS (Oral Rehydration Salts)', 'Fluid/Electrolyte', 'sachet'],
  ['Diazepam', 'Sedative', 'tablet'],
  ['Misoprostol', 'Obstetric', 'tablet'],
  ['Oxytocin Injection', 'Obstetric', 'ampule'],
  ['Magnesium Sulfate Injection', 'Obstetric', 'ampule'],
  ['Methylergometrine', 'Obstetric', 'ampule'],
];

// [name, category, unit, ref_low, ref_high, ref_text, components, default_price]
const TESTS = [
  // Hematology
  ['CBC (Complete Blood Count)', 'Hematology', null, null, null, null, JSON.stringify([
    { name: 'Hemoglobin (Hb)', unit: 'g/dL', ref_low: 12, ref_high: 16 },
    { name: 'RBC Count', unit: 'x10^12/L', ref_low: 4.2, ref_high: 5.9 },
    { name: 'WBC Count', unit: 'x10^9/L', ref_low: 4, ref_high: 11 },
    { name: 'Platelet Count', unit: 'x10^9/L', ref_low: 150, ref_high: 450 },
    { name: 'Neutrophils', unit: '%', ref_low: 40, ref_high: 75 },
    { name: 'Lymphocytes', unit: '%', ref_low: 20, ref_high: 45 },
    { name: 'Monocytes', unit: '%', ref_low: 2, ref_high: 10 },
    { name: 'Eosinophils', unit: '%', ref_low: 1, ref_high: 6 },
    { name: 'Basophils', unit: '%', ref_low: 0, ref_high: 1 },
  ]), 500],
  ['ESR', 'Hematology', 'mm/hr', 0, 20, null, null, 200],
  ['Bleeding Time', 'Hematology', 'min', 1, 6, null, null, 150],
  ['Clotting Time', 'Hematology', 'min', 5, 15, null, null, 150],
  ['Blood Group & Rh', 'Hematology', null, null, null, 'A/B/AB/O, Rh+/-', null, 200],
  ['PT/INR', 'Hematology', null, 0.8, 1.2, null, null, 600],
  ['APTT', 'Hematology', 'sec', 25, 35, null, null, 600],

  // Biochemistry
  ['Blood Sugar Random', 'Biochemistry', 'mg/dL', 70, 140, null, null, 150],
  ['Blood Sugar Fasting', 'Biochemistry', 'mg/dL', 70, 100, null, null, 150],
  ['Blood Sugar 2hr PP', 'Biochemistry', 'mg/dL', 70, 140, null, null, 150],
  ['HbA1c', 'Biochemistry', '%', 4, 5.6, null, null, 1200],
  ['Blood Urea', 'Biochemistry', 'mg/dL', 15, 40, null, null, 250],
  ['Serum Creatinine', 'Biochemistry', 'mg/dL', 0.6, 1.3, null, null, 250],
  ['Uric Acid', 'Biochemistry', 'mg/dL', 3.5, 7.2, null, null, 300],
  ['LFTs (Liver Function Tests)', 'Biochemistry', null, null, null, null, JSON.stringify([
    { name: 'Bilirubin Total', unit: 'mg/dL', ref_low: 0.3, ref_high: 1.2 },
    { name: 'Bilirubin Direct', unit: 'mg/dL', ref_low: 0, ref_high: 0.3 },
    { name: 'SGPT/ALT', unit: 'U/L', ref_low: 7, ref_high: 56 },
    { name: 'SGOT/AST', unit: 'U/L', ref_low: 10, ref_high: 40 },
    { name: 'Alkaline Phosphatase', unit: 'U/L', ref_low: 44, ref_high: 147 },
    { name: 'Total Protein', unit: 'g/dL', ref_low: 6.4, ref_high: 8.3 },
    { name: 'Albumin', unit: 'g/dL', ref_low: 3.5, ref_high: 5.0 },
  ]), 1500],
  ['RFTs (Renal Function Tests)', 'Biochemistry', null, null, null, null, JSON.stringify([
    { name: 'Urea', unit: 'mg/dL', ref_low: 15, ref_high: 40 },
    { name: 'Creatinine', unit: 'mg/dL', ref_low: 0.6, ref_high: 1.3 },
    { name: 'Sodium', unit: 'mmol/L', ref_low: 135, ref_high: 145 },
    { name: 'Potassium', unit: 'mmol/L', ref_low: 3.5, ref_high: 5.1 },
  ]), 1200],
  ['Lipid Profile', 'Biochemistry', null, null, null, null, JSON.stringify([
    { name: 'Total Cholesterol', unit: 'mg/dL', ref_low: 0, ref_high: 200 },
    { name: 'Triglycerides', unit: 'mg/dL', ref_low: 0, ref_high: 150 },
    { name: 'HDL', unit: 'mg/dL', ref_low: 40, ref_high: 60 },
    { name: 'LDL', unit: 'mg/dL', ref_low: 0, ref_high: 100 },
  ]), 1500],
  ['Serum Electrolytes', 'Biochemistry', null, null, null, null, JSON.stringify([
    { name: 'Sodium', unit: 'mmol/L', ref_low: 135, ref_high: 145 },
    { name: 'Potassium', unit: 'mmol/L', ref_low: 3.5, ref_high: 5.1 },
    { name: 'Chloride', unit: 'mmol/L', ref_low: 98, ref_high: 107 },
  ]), 800],

  // Special Chemistry
  ['Serum Amylase', 'Special Chemistry', 'U/L', 30, 110, null, null, 800],
  ['Serum Lipase', 'Special Chemistry', 'U/L', 10, 140, null, null, 800],
  ['CPK (Creatine Phosphokinase)', 'Special Chemistry', 'U/L', 22, 198, null, null, 900],
  ['Troponin I', 'Special Chemistry', 'ng/mL', 0, 0.04, null, null, 2000],
  ['D-Dimer', 'Special Chemistry', 'µg/mL', 0, 0.5, null, null, 2500],
  ['CRP (C-Reactive Protein)', 'Special Chemistry', 'mg/L', 0, 10, null, null, 800],

  // Immunology
  ['Widal Test', 'Immunology', null, null, null, 'Titre < 1:80', null, 400],
  ['Dengue NS1 Antigen', 'Immunology', null, null, null, 'Negative', null, 1500],
  ['Dengue IgM/IgG', 'Immunology', null, null, null, 'Negative', null, 1800],
  ['HBsAg', 'Immunology', null, null, null, 'Negative', null, 600],
  ['Anti-HCV', 'Immunology', null, null, null, 'Negative', null, 800],
  ['HIV Screening', 'Immunology', null, null, null, 'Negative', null, 800],
  ['Serum Beta HCG', 'Immunology', 'mIU/mL', 0, 5, null, null, 1000],
  ['Urine Pregnancy Test', 'Immunology', null, null, null, 'Negative', null, 200],
  ['RA Factor', 'Immunology', 'IU/mL', 0, 14, null, null, 700],
  ['ASO Titre', 'Immunology', 'IU/mL', 0, 200, null, null, 700],
  ['VDRL', 'Immunology', null, null, null, 'Non-reactive', null, 400],
  ['Urine R/E', 'Immunology', null, null, null, null, JSON.stringify([
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
    { name: 'Mucus Threads', ref_text: 'Nil / Occasional' },
  ]), 250],

  // Radiology (for referral autocomplete)
  ['X-Ray Chest', 'Radiology', null, null, null, null, null, 800],
  ['X-Ray Abdomen', 'Radiology', null, null, null, null, null, 800],
  ['X-Ray Pelvis', 'Radiology', null, null, null, null, null, 800],
  ['X-Ray Limb', 'Radiology', null, null, null, null, null, 700],
  ['Ultrasound Abdomen', 'Radiology', null, null, null, null, null, 1500],
  ['Ultrasound Pelvis', 'Radiology', null, null, null, null, null, 1500],
  ['Ultrasound Obstetric', 'Radiology', null, null, null, null, null, 1800],
  ['CT Scan Head', 'Radiology', null, null, null, null, null, 6000],
  ['CT Scan Abdomen', 'Radiology', null, null, null, null, null, 7000],
  ['MRI Spine', 'Radiology', null, null, null, null, null, 12000],
  ['MRI Brain', 'Radiology', null, null, null, null, null, 12000],
  ['ECG', 'Radiology', null, null, null, null, null, 500],
];

function seedDrugs() {
  const insert = db.prepare('INSERT OR IGNORE INTO drugs_master (name, category, default_unit) VALUES (?, ?, ?)');
  for (const [name, category, unit] of DRUGS) insert.run(name, category, unit);
}

function seedTests() {
  const insert = db.prepare(`
    INSERT INTO tests_master (name, category, unit, ref_low, ref_high, ref_text, components, default_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      default_price = CASE WHEN tests_master.default_price IS NULL OR tests_master.default_price = 0
                            THEN excluded.default_price ELSE tests_master.default_price END
  `);
  for (const [name, category, unit, ref_low, ref_high, ref_text, components, default_price] of TESTS) {
    insert.run(name, category, unit, ref_low, ref_high, ref_text, components, default_price || 0);
  }
}

function seedAll() {
  seedDrugs();
  seedTests();
}

module.exports = { seedAll };
