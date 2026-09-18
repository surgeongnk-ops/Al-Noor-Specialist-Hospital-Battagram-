// routes/pharmacy.routes.js — Pharmacy Management System (PMS)
//
// Unit tracking note: quantity / quantity_remaining on drug_batches ALWAYS store
// individual units (tablets, capsules, ml, etc.) — never packs. units_per_pack is
// purely for pack-based data entry convenience (so a pharmacist can say "2 strips
// of 20" instead of doing the multiplication themselves) and for display. Because
// stock is always tracked in units, dispensing any partial quantity — 5 tablets
// out of a 20-tablet strip — needs no special handling: it's just a normal
// quantity passed to deductStockFEFO, exactly like whole-pack dispensing.
const { createRouter } = require('../router');
const { db, logAudit, withTransaction, nextCounter } = require('../db');
const { sendJSON, sendError, readBody, requireAuth, asyncHandler, receiptNo, expiryStatus, isLowStock } = require('../middleware');

const router = createRouter();

router.get('/api/pharmacy/prescriptions', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const status = url.searchParams.get('status') || 'pending';
  const rows = db.prepare(`
    SELECT pr.*, pt.mr_number, pt.name AS patient_name
    FROM prescriptions pr JOIN patients pt ON pt.id = pr.patient_id
    WHERE pr.status = ? ORDER BY pr.created_at ASC
  `).all(status).map(r => ({ ...r, medicines: JSON.parse(r.medicines) }));
  return sendJSON(res, 200, rows);
}));

// Deducts `qty` UNITS of `drugName` from batches, earliest-expiry-first (FEFO).
// This and the approved-adjustment path below are the ONLY two places in the
// entire codebase that write to drug_batches.quantity_remaining — there is no
// manual stock edit for pharmacy staff (admin's batch-edit endpoint further down
// is a separate, explicitly-logged superuser correction tool, not part of the
// normal sale flow). Snapshots purchase_price per batch consumed so daily
// closing reports can compute true cost of goods sold later.
function deductStockFEFO(drugName, qty) {
  let remaining = qty;
  const batchesUsed = [];
  let lastPrice = 0;
  const batches = db.prepare(`
    SELECT * FROM drug_batches WHERE drug_name = ? AND quantity_remaining > 0
    ORDER BY (expiry_date IS NULL), expiry_date ASC, created_at ASC
  `).all(drugName);
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, b.quantity_remaining);
    const result = db.prepare('UPDATE drug_batches SET quantity_remaining = quantity_remaining - ? WHERE id = ? AND quantity_remaining >= ?').run(take, b.id, take);
    // The `quantity_remaining >= ?` guard makes this UPDATE a no-op (changes === 0)
    // if another statement in this same transaction already consumed the batch out
    // from under us — belt-and-suspenders on top of the availability check the
    // caller runs first, so quantity_remaining can never be driven below zero.
    if (result.changes === 0) continue;
    batchesUsed.push({ batch_number: b.batch_number, qty: take, purchase_price: b.purchase_price });
    lastPrice = b.selling_price;
    remaining -= take;
  }
  return { ok: remaining <= 0, unitPriceUsed: lastPrice, batchesUsed, shortfall: remaining };
}

// Pre-flight check: does total stock on hand cover every requested line item?
// Sums requested quantities per drug name first (a sale can list the same drug
// twice) and compares against SUM(quantity_remaining) across all its batches.
// Run BEFORE any deduction so a short order is rejected atomically — the old
// behavior deducted whatever partial stock existed and still charged the
// patient for the full requested quantity, silently "selling" medicine that
// was never actually in stock.
function checkStockAvailable(items) {
  const requested = new Map();
  for (const item of items) {
    const qty = Number(item.qty) || 0;
    if (qty <= 0) continue;
    requested.set(item.name, (requested.get(item.name) || 0) + qty);
  }
  const shortages = [];
  for (const [name, qty] of requested) {
    const row = db.prepare('SELECT COALESCE(SUM(quantity_remaining), 0) AS total FROM drug_batches WHERE drug_name = ?').get(name);
    if (row.total < qty) shortages.push({ name, requested: qty, available: row.total });
  }
  return shortages;
}

// THE OPD DESYNC FIX — read this before touching visit status anywhere else.
//
// A visit's lifecycle (visits.status) is: waiting_doctor -> with_doctor ->
// waiting_lab / waiting_pharmacy -> ... -> closed. The lab/radiology side of
// that lifecycle already loops back correctly: once every lab/radiology order
// on a visit reaches a final state, lab.routes.js / radiology.routes.js flips
// the visit back to 'with_doctor' with results_ready=1 so it resurfaces in
// the doctor's Results-Ready queue. Dispensing had no equivalent — once a
// doctor wrote a prescription (visit -> 'waiting_pharmacy'), NOTHING ever
// moved that visit to 'closed' after pharmacy handed the medicine over. The
// doctor's own queue (`/api/visits/queue`, status = 'waiting_doctor') quite
// correctly stopped showing that patient — they'd already been seen — but
// the visit stayed permanently "open" everywhere else, including the Admin
// dashboard's "In OPD (Clinic)" census count (`status != 'closed'`). That's
// the exact symptom reported: Admin keeps counting a patient as still
// in-clinic/waiting long after the Doctor Portal has already moved on from
// them, because nothing ever closed the visit out.
//
// This closes that gap the same way the lab/radiology side already does:
// after each dispense, check whether anything is still outstanding on this
// visit (another undispensed prescription, or a lab/radiology order that
// hasn't reached a final status yet) — if nothing is, and the doctor doesn't
// have a still-unreviewed results_ready flag sitting on it, close the visit.
// Deliberately conservative: on any doubt, it leaves the visit exactly as it
// was and falls back to the existing manual "Close this visit" button in the
// Doctor Portal (patient search -> Open History -> Open This Visit) rather
// than risk closing a visit the doctor still needs to act on.
const LAB_ORDER_RESOLVED_STATUSES = ['done', 'DELIVERED', 'VERIFIED', 'RESULT_ENTERED', 'cancelled'];
const RAD_ORDER_RESOLVED_STATUSES = ['done', 'cancelled'];
function closeVisitIfNothingPending(visitId) {
  if (!visitId) return;
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
  if (!visit || visit.status === 'closed' || visit.results_ready) return;
  const otherPendingRx = db.prepare("SELECT COUNT(*) c FROM prescriptions WHERE visit_id = ? AND status != 'dispensed'").get(visitId).c;
  if (otherPendingRx > 0) return;
  const pendingLab = db.prepare(
    `SELECT COUNT(*) c FROM lab_orders WHERE visit_id = ? AND status NOT IN (${LAB_ORDER_RESOLVED_STATUSES.map(() => '?').join(',')})`
  ).get(visitId, ...LAB_ORDER_RESOLVED_STATUSES).c;
  if (pendingLab > 0) return;
  const pendingRad = db.prepare(
    `SELECT COUNT(*) c FROM radiology_orders WHERE visit_id = ? AND status NOT IN (${RAD_ORDER_RESOLVED_STATUSES.map(() => '?').join(',')})`
  ).get(visitId, ...RAD_ORDER_RESOLVED_STATUSES).c;
  if (pendingRad > 0) return;
  db.prepare("UPDATE visits SET status = 'closed' WHERE id = ? AND status != 'closed'").run(visitId);
}

// ===== Narcotics / controlled-substance register =====
// Returns the subset of `names` that drugs_master has flagged is_controlled=1
// (exact name match — the same matching this codebase already uses everywhere
// else a drug name crosses a table boundary, e.g. the drugs_master INSERT OR
// IGNORE on every batch add). Admin sets the flag via PUT
// /api/pharmacy/drugs/:name/controlled.
function getControlledDrugNames(names) {
  const unique = [...new Set(names)].filter(Boolean);
  if (!unique.length) return new Set();
  const rows = db.prepare(
    `SELECT name FROM drugs_master WHERE is_controlled = 1 AND name IN (${unique.map(() => '?').join(',')})`
  ).all(...unique);
  return new Set(rows.map(r => r.name));
}

// Writes one narcotics_log row per controlled-drug line item in a completed
// sale/dispense. Called from inside the same transaction as the sale itself so
// a controlled drug can never leave the pharmacy without a register entry —
// either both the dispense and the register row are committed, or neither is.
function logNarcotics(lineItems, ctx) {
  const controlled = getControlledDrugNames(lineItems.map(i => i.name));
  if (!controlled.size) return;
  const insert = db.prepare(`
    INSERT INTO narcotics_log (drug_name, batch_id, batch_number, qty, patient_id, patient_name, prescription_id, prescriber_id, dispense_id, receipt_no, dispensed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of lineItems) {
    if (!controlled.has(item.name)) continue;
    const batches = item.batches || [];
    const batchNumbers = batches.map(b => b.batch_number).filter(Boolean).join(', ') || null;
    insert.run(item.name, null, batchNumbers, item.qty, ctx.patientId || null, ctx.patientName || null,
      ctx.prescriptionId || null, ctx.prescriberId || null, ctx.dispenseId, ctx.receiptNo, ctx.dispensedBy);
  }
}

// Non-blocking drug-drug and drug-allergy decision support — this NEVER stops a
// prescription or a sale, it only informs. Called by the Doctor Portal while a
// prescription is being written and by the Pharmacy dispense/POS screens right
// before a sale is completed, so the same check backs up both ends of the
// e-prescribing workflow. Matching is deliberately loose (case-insensitive
// substring, either direction) because drug_interactions entries are often a
// drug CLASS ("ACE Inhibitor") rather than one brand, and allergy text is
// whatever a human typed, not a coded value.
function checkDrugSafety(drugNames, allergiesText) {
  const interactionWarnings = [];
  if (drugNames.length >= 2) {
    const allInteractions = db.prepare('SELECT * FROM drug_interactions').all();
    for (let i = 0; i < drugNames.length; i++) {
      for (let j = i + 1; j < drugNames.length; j++) {
        const nameI = drugNames[i].toLowerCase();
        const nameJ = drugNames[j].toLowerCase();
        for (const row of allInteractions) {
          const a = row.drug_a.toLowerCase(), b = row.drug_b.toLowerCase();
          const hit = (nameI.includes(a) && nameJ.includes(b)) || (nameI.includes(b) && nameJ.includes(a));
          if (hit) interactionWarnings.push({ drugA: drugNames[i], drugB: drugNames[j], severity: row.severity, note: row.note });
        }
      }
    }
  }
  const allergyWarnings = [];
  const allergyTerms = (allergiesText || '').split(/[,;\n]/).map(t => t.trim().toLowerCase()).filter(t => t.length >= 3);
  if (allergyTerms.length) {
    for (const drug of drugNames) {
      const nameLower = drug.toLowerCase();
      for (const term of allergyTerms) {
        if (nameLower.includes(term) || term.includes(nameLower)) {
          allergyWarnings.push({ drug, allergyTerm: term });
          break;
        }
      }
    }
  }
  return { interactionWarnings, allergyWarnings, hasWarnings: interactionWarnings.length > 0 || allergyWarnings.length > 0 };
}

router.post(/^\/api\/pharmacy\/prescriptions\/(\d+)\/dispense$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const prescriptionId = Number(match[1]);
  const { items, discount_percent, insurance_provider, insurance_covered_amount } = await readBody(req);
  const prescription = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(prescriptionId);
  if (!prescription) return sendError(res, 404, 'Not found');
  if (!items || !items.length) return sendError(res, 400, 'No items to dispense');
  if (prescription.status === 'dispensed') return sendError(res, 400, 'This prescription has already been dispensed');

  const shortages = checkStockAvailable(items);
  if (shortages.length) {
    return sendError(res, 400, 'Insufficient stock: ' + shortages.map(s => `${s.name} (need ${s.requested}, have ${s.available})`).join('; '));
  }

  const discount = Math.min(1, Math.max(0, Number(discount_percent) || 0)); // capped at 1% server-side
  const insuranceCovered = Math.max(0, Number(insurance_covered_amount) || 0);
  let result;
  try {
    result = withTransaction(() => {
      const lineItems = [];
      let subtotal = 0;
      for (const item of items) {
        const qty = Number(item.qty) || 0; // in units — dispensing e.g. 5 of a 20-unit pack works exactly like any other qty
        if (qty <= 0) continue;
        const deduction = deductStockFEFO(item.name, qty);
        if (!deduction.ok) {
          // Stock moved between the pre-flight check and here (e.g. another sale in
          // the same synchronous tick, or an admin correction) — abort the whole
          // transaction rather than charge for medicine that was never handed over.
          throw new Error(`STOCK_RACE: ${item.name}`);
        }
        const unitPrice = Number(item.unit_price) || deduction.unitPriceUsed || 0;
        const total = unitPrice * qty;
        subtotal += total;
        lineItems.push({ name: item.name, qty, unit_price: unitPrice, total, batches: deduction.batchesUsed });
      }
      const payment_amount = subtotal * (1 - discount / 100);
      const patient_payable = Math.max(0, payment_amount - Math.min(insuranceCovered, payment_amount));
      const receipt = receiptNo();
      const dispenseResult = db.prepare(`
        INSERT INTO dispenses (prescription_id, patient_id, items, subtotal, discount_percent, payment_amount, receipt_no, dispensed_by, insurance_provider, insurance_covered_amount, patient_payable)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(prescriptionId, prescription.patient_id, JSON.stringify(lineItems), subtotal, discount, payment_amount, receipt, staff.staff_id,
        insurance_provider || null, Math.min(insuranceCovered, payment_amount), patient_payable);
      db.prepare("UPDATE prescriptions SET status = 'dispensed' WHERE id = ?").run(prescriptionId);
      closeVisitIfNothingPending(prescription.visit_id);
      const patient = db.prepare('SELECT name FROM patients WHERE id = ?').get(prescription.patient_id);
      logNarcotics(lineItems, {
        patientId: prescription.patient_id, patientName: patient?.name, prescriptionId,
        prescriberId: prescription.doctor_id, dispenseId: dispenseResult.lastInsertRowid, receiptNo: receipt, dispensedBy: staff.staff_id
      });
      return { receipt, subtotal, payment_amount, patient_payable, insurance_covered_amount: Math.min(insuranceCovered, payment_amount), lineItems };
    });
  } catch (err) {
    if (String(err.message).startsWith('STOCK_RACE:')) {
      return sendError(res, 409, 'Stock changed while processing this sale — please retry. ' + err.message.replace('STOCK_RACE: ', 'Short item: '));
    }
    throw err;
  }

  logAudit(staff.staff_id, 'prescription_dispensed', null, `Rx #${prescriptionId} — receipt ${result.receipt}, Rs. ${result.payment_amount.toFixed(2)}`);
  return sendJSON(res, 200, {
    ok: true, receipt_no: result.receipt, subtotal: result.subtotal, discount_percent: discount,
    payment_amount: result.payment_amount, patient_payable: result.patient_payable, insurance_covered_amount: result.insurance_covered_amount,
    items: result.lineItems
  });
}));

// Direct walk-in / counter sale — with or without a doctor's prescription. If an
// MR number is given, the patient's name is looked up and returned so it can be
// printed on the receipt.
router.post('/api/pharmacy/sale', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const { mr_number, items, discount_percent, insurance_provider, insurance_covered_amount } = await readBody(req);
  if (!items || !items.length) return sendError(res, 400, 'No items specified');
  let patient_id = null;
  let patient_name = null;
  if (mr_number) {
    const patient = db.prepare('SELECT * FROM patients WHERE mr_number = ?').get(mr_number);
    if (!patient) return sendError(res, 404, 'No patient found with that MR number');
    patient_id = patient.id;
    patient_name = patient.name;
  }
  const shortages = checkStockAvailable(items);
  if (shortages.length) {
    return sendError(res, 400, 'Insufficient stock: ' + shortages.map(s => `${s.name} (need ${s.requested}, have ${s.available})`).join('; '));
  }

  const discount = Math.min(1, Math.max(0, Number(discount_percent) || 0));
  const insuranceCovered = Math.max(0, Number(insurance_covered_amount) || 0);
  let result;
  try {
    result = withTransaction(() => {
      const lineItems = [];
      let subtotal = 0;
      for (const item of items) {
        const qty = Number(item.qty) || 0;
        if (qty <= 0) continue;
        const deduction = deductStockFEFO(item.name, qty);
        if (!deduction.ok) throw new Error(`STOCK_RACE: ${item.name}`);
        const unitPrice = Number(item.unit_price) || deduction.unitPriceUsed || 0;
        const total = unitPrice * qty;
        subtotal += total;
        lineItems.push({ name: item.name, qty, unit_price: unitPrice, total, batches: deduction.batchesUsed });
      }
      const payment_amount = subtotal * (1 - discount / 100);
      const patient_payable = Math.max(0, payment_amount - Math.min(insuranceCovered, payment_amount));
      const receipt = receiptNo();
      const dispenseResult = db.prepare(`
        INSERT INTO dispenses (prescription_id, patient_id, items, subtotal, discount_percent, payment_amount, receipt_no, dispensed_by, insurance_provider, insurance_covered_amount, patient_payable)
        VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(patient_id, JSON.stringify(lineItems), subtotal, discount, payment_amount, receipt, staff.staff_id,
        insurance_provider || null, Math.min(insuranceCovered, payment_amount), patient_payable);
      logNarcotics(lineItems, {
        patientId: patient_id, patientName: patient_name, prescriptionId: null,
        prescriberId: null, dispenseId: dispenseResult.lastInsertRowid, receiptNo: receipt, dispensedBy: staff.staff_id
      });
      return { receipt, subtotal, payment_amount, patient_payable, insurance_covered_amount: Math.min(insuranceCovered, payment_amount), lineItems };
    });
  } catch (err) {
    if (String(err.message).startsWith('STOCK_RACE:')) {
      return sendError(res, 409, 'Stock changed while processing this sale — please retry. ' + err.message.replace('STOCK_RACE: ', 'Short item: '));
    }
    throw err;
  }

  logAudit(staff.staff_id, 'pharmacy_sale', mr_number || null, `receipt ${result.receipt}, Rs. ${result.payment_amount.toFixed(2)}`);
  return sendJSON(res, 200, {
    ok: true, receipt_no: result.receipt, subtotal: result.subtotal, discount_percent: discount,
    payment_amount: result.payment_amount, patient_payable: result.patient_payable, insurance_covered_amount: result.insurance_covered_amount,
    items: result.lineItems, mr_number: mr_number || null, patient_name
  });
}));

router.get('/api/pharmacy/batches', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const rows = db.prepare('SELECT * FROM drug_batches ORDER BY expiry_date ASC').all()
    .map(b => ({
      ...b,
      status: expiryStatus(b.expiry_date),
      low_stock: isLowStock(b.quantity_remaining, b.units_per_pack),
      packs_remaining: b.units_per_pack > 1 ? Math.floor(b.quantity_remaining / b.units_per_pack) : null,
      loose_units_remaining: b.units_per_pack > 1 ? b.quantity_remaining % b.units_per_pack : null
    }));
  return sendJSON(res, 200, rows);
}));

// Adding inventory: the pharmacist may enter pack-based figures (pack size,
// number of packs, price per pack) OR unit-based figures directly (units_per_pack
// left at 1). Either way, everything is converted to and stored as individual
// units — see the module-level note at the top of this file.
router.post('/api/pharmacy/batches', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const {
    drug_name, batch_number, expiry_date, company_name, distributor_name, invoice_number,
    units_per_pack, pack_quantity, quantity,
    pack_purchase_price, pack_selling_price, purchase_price, selling_price
  } = await readBody(req);
  if (!drug_name) return sendError(res, 400, 'Drug name is required');

  const perPack = Math.max(1, Number(units_per_pack) || 1);
  let totalUnits, unitPurchasePrice, unitSellingPrice;

  if (perPack > 1) {
    // Pack-based entry: convert packs -> units, pack price -> unit price.
    const packs = Number(pack_quantity) || 0;
    if (packs <= 0) return sendError(res, 400, 'Number of packs is required when a pack size is set');
    totalUnits = packs * perPack;
    unitPurchasePrice = (Number(pack_purchase_price) || 0) / perPack;
    unitSellingPrice = (Number(pack_selling_price) || 0) / perPack;
  } else {
    // Loose/unit entry (e.g. syrup bottles, or tablets already counted individually).
    totalUnits = Number(quantity) || 0;
    if (totalUnits <= 0) return sendError(res, 400, 'Quantity is required');
    unitPurchasePrice = Number(purchase_price) || 0;
    unitSellingPrice = Number(selling_price) || 0;
  }

  withTransaction(() => {
    db.prepare(`
      INSERT INTO drug_batches (drug_name, batch_number, quantity, quantity_remaining, expiry_date, purchase_price, selling_price, company_name, distributor_name, created_by, units_per_pack, invoice_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(drug_name, batch_number || '', totalUnits, totalUnits, expiry_date || null, unitPurchasePrice, unitSellingPrice, company_name || '', distributor_name || '', staff.staff_id, perPack, invoice_number || null);
    db.prepare('INSERT OR IGNORE INTO drugs_master (name, category, default_unit) VALUES (?, ?, ?)').run(drug_name, 'Custom', '');
  });
  return sendJSON(res, 200, { ok: true, total_units_added: totalUnits, unit_purchase_price: unitPurchasePrice, unit_selling_price: unitSellingPrice });
}));

// ---- Admin: direct batch correction (quantity miscounts, wrong batch number,
// wrong expiry date typed at entry, etc.) — separate from, and NOT a replacement
// for, the wastage/damage/return approval workflow further down. This bypasses
// that workflow entirely, so it's restricted to admin and fully audit-logged.
router.put(/^\/api\/pharmacy\/batches\/(\d+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const batchId = Number(match[1]);
  const existing = db.prepare('SELECT * FROM drug_batches WHERE id = ?').get(batchId);
  if (!existing) return sendError(res, 404, 'Batch not found');
  const body = await readBody(req);
  const updated = {
    drug_name: body.drug_name ?? existing.drug_name,
    batch_number: body.batch_number ?? existing.batch_number,
    expiry_date: body.expiry_date ?? existing.expiry_date,
    quantity_remaining: body.quantity_remaining != null ? Number(body.quantity_remaining) : existing.quantity_remaining,
    purchase_price: body.purchase_price != null ? Number(body.purchase_price) : existing.purchase_price,
    selling_price: body.selling_price != null ? Number(body.selling_price) : existing.selling_price,
    company_name: body.company_name ?? existing.company_name,
    distributor_name: body.distributor_name ?? existing.distributor_name,
    invoice_number: body.invoice_number ?? existing.invoice_number,
    units_per_pack: body.units_per_pack != null ? Math.max(1, Number(body.units_per_pack)) : existing.units_per_pack
  };
  if (updated.quantity_remaining < 0) return sendError(res, 400, 'Quantity cannot be negative');
  db.prepare(`
    UPDATE drug_batches SET drug_name=?, batch_number=?, expiry_date=?, quantity_remaining=?, purchase_price=?, selling_price=?, company_name=?, distributor_name=?, units_per_pack=?, invoice_number=?
    WHERE id = ?
  `).run(updated.drug_name, updated.batch_number, updated.expiry_date, updated.quantity_remaining, updated.purchase_price, updated.selling_price, updated.company_name, updated.distributor_name, updated.units_per_pack, updated.invoice_number, batchId);
  logAudit(staff.staff_id, 'batch_edited_by_admin', null,
    `batch #${batchId} (${existing.drug_name}): qty ${existing.quantity_remaining}->${updated.quantity_remaining}`);
  return sendJSON(res, 200, { ok: true });
}));

router.del(/^\/api\/pharmacy\/batches\/(\d+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const batch = db.prepare('SELECT * FROM drug_batches WHERE id = ?').get(Number(match[1]));
  if (!batch) return sendError(res, 404, 'Batch not found');
  db.prepare('DELETE FROM drug_batches WHERE id = ?').run(batch.id);
  logAudit(staff.staff_id, 'batch_deleted_by_admin', null, `${batch.drug_name} batch ${batch.batch_number} (had ${batch.quantity_remaining} units remaining)`);
  return sendJSON(res, 200, { ok: true });
}));

router.get('/api/pharmacy/stock-summary', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, null); if (!staff) return;
  const q = `%${url.searchParams.get('q') || ''}%`;
  const rows = db.prepare(`
    SELECT drug_name,
      SUM(quantity_remaining) AS total_remaining,
      MIN(CASE WHEN quantity_remaining > 0 THEN expiry_date END) AS nearest_expiry,
      (SELECT selling_price FROM drug_batches b2 WHERE b2.drug_name = b1.drug_name AND b2.quantity_remaining > 0 ORDER BY (b2.expiry_date IS NULL), b2.expiry_date ASC LIMIT 1) AS current_price,
      (SELECT units_per_pack FROM drug_batches b3 WHERE b3.drug_name = b1.drug_name AND b3.quantity_remaining > 0 ORDER BY (b3.expiry_date IS NULL), b3.expiry_date ASC LIMIT 1) AS units_per_pack
    FROM drug_batches b1
    WHERE drug_name LIKE ?
    GROUP BY drug_name
    HAVING total_remaining > 0
    ORDER BY drug_name ASC LIMIT 20
  `).all(q);
  return sendJSON(res, 200, rows.map(r => ({ ...r, status: expiryStatus(r.nearest_expiry), low_stock: isLowStock(r.total_remaining, r.units_per_pack) })));
}));

// All drugs currently below the low-stock threshold (5 packs / 5 units), across
// the whole inventory — used for an admin/pharmacy low-stock alert panel.
router.get('/api/pharmacy/low-stock', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const rows = db.prepare(`
    SELECT drug_name,
      SUM(quantity_remaining) AS total_remaining,
      (SELECT units_per_pack FROM drug_batches b2 WHERE b2.drug_name = b1.drug_name AND b2.quantity_remaining > 0 ORDER BY (b2.expiry_date IS NULL), b2.expiry_date ASC LIMIT 1) AS units_per_pack
    FROM drug_batches b1
    GROUP BY drug_name
  `).all().map(r => ({ ...r, packs_remaining: r.total_remaining / (r.units_per_pack || 1) }))
    .filter(r => isLowStock(r.total_remaining, r.units_per_pack))
    .sort((a, b) => a.packs_remaining - b.packs_remaining);
  return sendJSON(res, 200, rows);
}));

router.post('/api/pharmacy/adjustments', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const { batch_id, adjustment_type, qty, reason } = await readBody(req);
  const batch = db.prepare('SELECT * FROM drug_batches WHERE id = ?').get(Number(batch_id) || 0);
  if (!batch) return sendError(res, 404, 'Batch not found');
  if (!['wastage', 'damaged', 'expired', 'return'].includes(adjustment_type)) return sendError(res, 400, 'Invalid adjustment type');
  const q = Number(qty) || 0;
  if (q <= 0 || q > batch.quantity_remaining) return sendError(res, 400, `Quantity must be between 1 and ${batch.quantity_remaining} (current remaining stock)`);
  db.prepare('INSERT INTO stock_adjustments (batch_id, drug_name, adjustment_type, qty, reason, requested_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(batch.id, batch.drug_name, adjustment_type, q, reason || '', staff.staff_id);
  return sendJSON(res, 200, { ok: true });
}));

router.get('/api/pharmacy/adjustments', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const status = url.searchParams.get('status') || 'pending';
  const rows = db.prepare('SELECT * FROM stock_adjustments WHERE status = ? ORDER BY requested_at DESC').all(status);
  return sendJSON(res, 200, rows);
}));

router.post(/^\/api\/pharmacy\/adjustments\/(\d+)\/approve$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const adjId = Number(match[1]);
  let outcome;
  try {
    outcome = withTransaction(() => {
      const adj = db.prepare('SELECT * FROM stock_adjustments WHERE id = ?').get(adjId);
      if (!adj) throw new Error('NOT_FOUND');
      // Claim the row first with a status-guarded UPDATE — if two approve clicks
      // land back to back, only the first one's WHERE status='pending' matches;
      // the second sees changes===0 and is rejected instead of double-deducting
      // stock for the same adjustment.
      const claim = db.prepare(`UPDATE stock_adjustments SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ? AND status = 'pending'`)
        .run(staff.staff_id, adjId);
      if (claim.changes === 0) throw new Error('ALREADY_PROCESSED');
      const batch = db.prepare('SELECT * FROM drug_batches WHERE id = ?').get(adj.batch_id);
      if (!batch) throw new Error('BATCH_MISSING');
      const take = Math.min(adj.qty, batch.quantity_remaining);
      db.prepare('UPDATE drug_batches SET quantity_remaining = quantity_remaining - ? WHERE id = ? AND quantity_remaining >= ?').run(take, batch.id, take);
      return { drug_name: adj.drug_name, take, adjustment_type: adj.adjustment_type };
    });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return sendError(res, 404, 'Not found');
    if (err.message === 'ALREADY_PROCESSED') return sendError(res, 400, 'Already processed');
    if (err.message === 'BATCH_MISSING') return sendError(res, 404, 'Underlying batch not found');
    throw err;
  }
  logAudit(staff.staff_id, 'stock_adjustment_approved', null, `${outcome.drug_name} x${outcome.take} (${outcome.adjustment_type})`);
  return sendJSON(res, 200, { ok: true });
}));

router.post(/^\/api\/pharmacy\/adjustments\/(\d+)\/reject$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const result = db.prepare(`UPDATE stock_adjustments SET status = 'rejected', approved_by = ?, approved_at = datetime('now') WHERE id = ? AND status = 'pending'`)
    .run(staff.staff_id, Number(match[1]));
  if (result.changes === 0) return sendError(res, 400, 'Not found, or already processed');
  return sendJSON(res, 200, { ok: true });
}));

// ===== Medicine Return (customer refund, self-service — no admin approval) =====
// This is deliberately separate from the stock_adjustments 'return' type above,
// which is an admin-approval-gated disposal/write-off workflow (medicine going
// OUT of usable stock). This flow is the opposite: a patient brings back
// unused/unopened medicine they already paid for, the pharmacist verifies it
// against the original sale receipt on the spot, and it goes back INTO usable
// stock immediately with an immediate refund — no admin sign-off needed, exactly
// like a retail pharmacy counter return.

// Look up a past sale by receipt number so the pharmacist can pick which item(s)
// are being returned, and see how much of each has already been returned before
// (so the same medicine can't be refunded twice from one sale).
router.get(/^\/api\/pharmacy\/sale-by-receipt\/([^/]+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const receiptNoParam = decodeURIComponent(match[1]);
  const sale = db.prepare('SELECT * FROM dispenses WHERE receipt_no = ?').get(receiptNoParam);
  if (!sale) return sendError(res, 404, 'No pharmacy sale found with that receipt number');
  const items = JSON.parse(sale.items);
  const alreadyReturned = db.prepare('SELECT drug_name, COALESCE(SUM(qty), 0) AS returned_qty FROM medicine_returns WHERE dispense_id = ? GROUP BY drug_name').all(sale.id);
  const returnedMap = Object.fromEntries(alreadyReturned.map(r => [r.drug_name, r.returned_qty]));
  let patient_name = null;
  if (sale.patient_id) {
    const p = db.prepare('SELECT name, mr_number FROM patients WHERE id = ?').get(sale.patient_id);
    if (p) patient_name = p.name;
  }
  return sendJSON(res, 200, {
    dispense_id: sale.id,
    receipt_no: sale.receipt_no,
    created_at: sale.created_at,
    discount_percent: sale.discount_percent,
    patient_name,
    items: items.map(it => ({
      name: it.name, qty: it.qty, unit_price: it.unit_price,
      already_returned: returnedMap[it.name] || 0,
      returnable_qty: Math.max(0, it.qty - (returnedMap[it.name] || 0))
    }))
  });
}));

router.post('/api/pharmacy/returns', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const { receipt_no, drug_name, qty, reason } = await readBody(req);
  if (!receipt_no || !drug_name) return sendError(res, 400, 'Original receipt number and drug name are required');
  const q = Number(qty) || 0;
  if (q <= 0) return sendError(res, 400, 'Quantity to return must be greater than zero');

  const sale = db.prepare('SELECT * FROM dispenses WHERE receipt_no = ?').get(receipt_no);
  if (!sale) return sendError(res, 404, 'No pharmacy sale found with that receipt number');
  const items = JSON.parse(sale.items);
  const line = items.find(it => it.name === drug_name);
  if (!line) return sendError(res, 400, `${drug_name} was not part of sale ${receipt_no}`);

  const alreadyReturned = db.prepare('SELECT COALESCE(SUM(qty), 0) AS total FROM medicine_returns WHERE dispense_id = ? AND drug_name = ?').get(sale.id, drug_name).total;
  const returnable = line.qty - alreadyReturned;
  if (q > returnable) return sendError(res, 400, `Only ${returnable} unit(s) of ${drug_name} remain returnable from this sale (already returned: ${alreadyReturned})`);

  const unitPrice = Number(line.unit_price) || 0;
  const discount = Number(sale.discount_percent) || 0;
  const refund_amount = Math.round(unitPrice * q * (1 - discount / 100) * 100) / 100;

  const result = withTransaction(() => {
    // Restock into a stable, clearly-labeled batch per drug so returned stock is
    // never invisibly merged into a normal purchased batch's numbers — the daily
    // report and stock views can always tell purchased vs. returned inventory apart.
    let batch = db.prepare(`SELECT * FROM drug_batches WHERE drug_name = ? AND batch_number = 'RETURNED-STOCK'`).get(drug_name);
    const referenceCost = db.prepare('SELECT purchase_price FROM drug_batches WHERE drug_name = ? ORDER BY created_at DESC LIMIT 1').get(drug_name);
    const costBasis = referenceCost ? referenceCost.purchase_price : 0;
    let batchId;
    if (batch) {
      db.prepare('UPDATE drug_batches SET quantity = quantity + ?, quantity_remaining = quantity_remaining + ? WHERE id = ?').run(q, q, batch.id);
      batchId = batch.id;
    } else {
      const insert = db.prepare(`
        INSERT INTO drug_batches (drug_name, batch_number, quantity, quantity_remaining, expiry_date, purchase_price, selling_price, company_name, distributor_name, created_by, units_per_pack)
        VALUES (?, 'RETURNED-STOCK', ?, ?, NULL, ?, ?, '', 'Customer Return', ?, 1)
      `).run(drug_name, q, q, costBasis, unitPrice, staff.staff_id);
      batchId = insert.lastInsertRowid;
    }
    const return_no = nextCounter('medicine_return', 'RET-');
    db.prepare(`
      INSERT INTO medicine_returns (return_no, dispense_id, original_receipt_no, patient_id, drug_name, qty, unit_price, refund_amount, restock_batch_id, reason, processed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(return_no, sale.id, receipt_no, sale.patient_id, drug_name, q, unitPrice, refund_amount, batchId, reason || '', staff.staff_id);
    return { return_no, batchId };
  });

  logAudit(staff.staff_id, 'medicine_returned', null, `${drug_name} x${q} refund Rs. ${refund_amount} (sale ${receipt_no}, return ${result.return_no})`);
  return sendJSON(res, 200, {
    ok: true, return_no: result.return_no, drug_name, qty: q, unit_price: unitPrice,
    refund_amount, original_receipt_no: receipt_no
  });
}));

router.get('/api/pharmacy/returns', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const date = url.searchParams.get('date');
  const rows = date
    ? db.prepare(`SELECT * FROM medicine_returns WHERE date(created_at) = ? ORDER BY created_at DESC`).all(date)
    : db.prepare(`SELECT * FROM medicine_returns ORDER BY created_at DESC LIMIT 100`).all();
  return sendJSON(res, 200, rows);
}));

// ===== Suppliers =====
router.get('/api/pharmacy/suppliers', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, null); if (!staff) return;
  const activeOnly = url.searchParams.get('active') === '1';
  const rows = activeOnly
    ? db.prepare('SELECT * FROM suppliers WHERE active = 1 ORDER BY name ASC').all()
    : db.prepare('SELECT * FROM suppliers ORDER BY name ASC').all();
  return sendJSON(res, 200, rows);
}));

router.post('/api/pharmacy/suppliers', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const { name, contact_person, phone, email, address, license_number } = await readBody(req);
  if (!name) return sendError(res, 400, 'Supplier name is required');
  const result = db.prepare('INSERT INTO suppliers (name, contact_person, phone, email, address, license_number, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, contact_person || '', phone || '', email || '', address || '', license_number || '', staff.staff_id);
  return sendJSON(res, 200, { ok: true, id: result.lastInsertRowid });
}));

router.put(/^\/api\/pharmacy\/suppliers\/(\d+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const supplierId = Number(match[1]);
  const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
  if (!existing) return sendError(res, 404, 'Supplier not found');
  const body = await readBody(req);
  const updated = {
    name: body.name ?? existing.name,
    contact_person: body.contact_person ?? existing.contact_person,
    phone: body.phone ?? existing.phone,
    email: body.email ?? existing.email,
    address: body.address ?? existing.address,
    license_number: body.license_number ?? existing.license_number,
    active: body.active != null ? (body.active ? 1 : 0) : existing.active
  };
  db.prepare('UPDATE suppliers SET name=?, contact_person=?, phone=?, email=?, address=?, license_number=?, active=? WHERE id=?')
    .run(updated.name, updated.contact_person, updated.phone, updated.email, updated.address, updated.license_number, updated.active, supplierId);
  return sendJSON(res, 200, { ok: true });
}));

// ===== Purchase Orders =====
// Creating a PO never touches stock by itself — only /receive does, and it uses
// the exact same drug_batches insert path as manually adding a batch (so
// received stock is immediately visible in Inventory and FEFO-eligible), just
// tagged with the PO number as its reference instead of a manually typed
// invoice number.
router.get('/api/pharmacy/purchase-orders', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const status = url.searchParams.get('status');
  const rows = (status
    ? db.prepare('SELECT po.*, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.status = ? ORDER BY po.created_at DESC').all(status)
    : db.prepare('SELECT po.*, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id ORDER BY po.created_at DESC').all()
  ).map(po => ({ ...po, items: db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(po.id) }));
  return sendJSON(res, 200, rows);
}));

router.get(/^\/api\/pharmacy\/purchase-orders\/(\d+)$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const po = db.prepare('SELECT po.*, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?').get(Number(match[1]));
  if (!po) return sendError(res, 404, 'Purchase order not found');
  po.items = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(po.id);
  return sendJSON(res, 200, po);
}));

router.post('/api/pharmacy/purchase-orders', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const { supplier_id, items, notes, expected_date } = await readBody(req);
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(supplier_id) || 0);
  if (!supplier) return sendError(res, 400, 'Valid supplier is required');
  if (!items || !items.length) return sendError(res, 400, 'At least one line item is required');
  const po_number = nextCounter('purchase_order', 'PO-');
  const poId = withTransaction(() => {
    const result = db.prepare('INSERT INTO purchase_orders (po_number, supplier_id, status, notes, expected_date, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(po_number, supplier.id, 'ordered', notes || '', expected_date || null, staff.staff_id);
    const insertItem = db.prepare('INSERT INTO purchase_order_items (po_id, drug_name, qty_ordered, unit_cost) VALUES (?, ?, ?, ?)');
    for (const item of items) {
      const qty = Number(item.qty) || 0;
      if (qty <= 0 || !item.name) continue;
      insertItem.run(result.lastInsertRowid, item.name, qty, Number(item.unit_cost) || 0);
    }
    return result.lastInsertRowid;
  });
  logAudit(staff.staff_id, 'purchase_order_created', null, `${po_number} — ${supplier.name} (${items.length} item(s))`);
  return sendJSON(res, 200, { ok: true, id: poId, po_number });
}));

router.post(/^\/api\/pharmacy\/purchase-orders\/(\d+)\/cancel$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(Number(match[1]));
  if (!po) return sendError(res, 404, 'Purchase order not found');
  if (['received', 'cancelled'].includes(po.status)) return sendError(res, 400, `Cannot cancel a ${po.status} purchase order`);
  db.prepare("UPDATE purchase_orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(po.id);
  logAudit(staff.staff_id, 'purchase_order_cancelled', null, po.po_number);
  return sendJSON(res, 200, { ok: true });
}));

router.post(/^\/api\/pharmacy\/purchase-orders\/(\d+)\/receive$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const poId = Number(match[1]);
  const po = db.prepare('SELECT po.*, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?').get(poId);
  if (!po) return sendError(res, 404, 'Purchase order not found');
  if (po.status === 'cancelled') return sendError(res, 400, 'This purchase order was cancelled');
  if (po.status === 'received') return sendError(res, 400, 'This purchase order has already been fully received');
  const { receipts } = await readBody(req); // [{ item_id, qty_received_now, batch_number, expiry_date, selling_price }]
  if (!receipts || !receipts.length) return sendError(res, 400, 'No items to receive');

  const outcome = withTransaction(() => {
    const batchesCreated = [];
    for (const r of receipts) {
      const qtyNow = Number(r.qty_received_now) || 0;
      if (qtyNow <= 0) continue;
      const item = db.prepare('SELECT * FROM purchase_order_items WHERE id = ? AND po_id = ?').get(Number(r.item_id) || 0, poId);
      if (!item) continue;
      const remaining = item.qty_ordered - item.qty_received;
      const take = Math.min(qtyNow, Math.max(0, remaining));
      if (take <= 0) continue;
      db.prepare('UPDATE purchase_order_items SET qty_received = qty_received + ? WHERE id = ?').run(take, item.id);
      // Selling price isn't on the PO by default (only cost is) — this falls back
      // to cost price so the batch is never left at Rs. 0 and unsellable; a
      // pharmacist/admin can correct the margin via the existing batch-edit screen.
      const sellingPrice = Number(r.selling_price) || item.unit_cost;
      const batchResult = db.prepare(`
        INSERT INTO drug_batches (drug_name, batch_number, quantity, quantity_remaining, expiry_date, purchase_price, selling_price, company_name, distributor_name, created_by, units_per_pack, invoice_number)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(item.drug_name, r.batch_number || '', take, take, r.expiry_date || null, item.unit_cost, sellingPrice, po.supplier_name, po.supplier_name, staff.staff_id, po.po_number);
      db.prepare('INSERT OR IGNORE INTO drugs_master (name, category, default_unit) VALUES (?, ?, ?)').run(item.drug_name, 'Custom', '');
      batchesCreated.push({ drug_name: item.drug_name, qty: take, batch_id: batchResult.lastInsertRowid });
    }
    const poItems = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(poId);
    const fullyReceived = poItems.every(i => i.qty_received >= i.qty_ordered);
    const anyReceived = poItems.some(i => i.qty_received > 0);
    const newStatus = fullyReceived ? 'received' : (anyReceived ? 'partially_received' : po.status);
    db.prepare("UPDATE purchase_orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, poId);
    return { batchesCreated, newStatus };
  });

  logAudit(staff.staff_id, 'purchase_order_received', null, `${po.po_number} — ${outcome.batchesCreated.length} item(s) received, now ${outcome.newStatus}`);
  return sendJSON(res, 200, { ok: true, ...outcome });
}));

// ===== Drug master: controlled-substance flag =====
router.get('/api/pharmacy/drugs', asyncHandler(async (req, res) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const rows = db.prepare('SELECT * FROM drugs_master ORDER BY name ASC').all();
  return sendJSON(res, 200, rows);
}));

router.put(/^\/api\/pharmacy\/drugs\/([^/]+)\/controlled$/, asyncHandler(async (req, res, match) => {
  const staff = requireAuth(req, res, ['admin']); if (!staff) return;
  const drugName = decodeURIComponent(match[1]);
  const { is_controlled } = await readBody(req);
  const result = db.prepare('UPDATE drugs_master SET is_controlled = ? WHERE name = ?').run(is_controlled ? 1 : 0, drugName);
  if (result.changes === 0) return sendError(res, 404, 'Drug not found in the master list');
  logAudit(staff.staff_id, 'drug_controlled_flag_changed', null, `${drugName} -> ${is_controlled ? 'controlled' : 'not controlled'}`);
  return sendJSON(res, 200, { ok: true });
}));

// ===== e-Prescribing safety check (drug-drug + drug-allergy) =====
router.get('/api/pharmacy/safety-check', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, null); if (!staff) return;
  const drugsParam = url.searchParams.get('drugs') || '';
  const drugNames = drugsParam.split(',').map(d => d.trim()).filter(Boolean);
  const mr = url.searchParams.get('mr');
  let allergies = '';
  if (mr) {
    const patient = db.prepare('SELECT allergies FROM patients WHERE mr_number = ?').get(mr);
    allergies = patient?.allergies || '';
  }
  return sendJSON(res, 200, checkDrugSafety(drugNames, allergies));
}));

// ===== Narcotics / controlled-substance register (view) =====
router.get('/api/pharmacy/narcotics-log', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const date = url.searchParams.get('date');
  const rows = date
    ? db.prepare('SELECT * FROM narcotics_log WHERE date(created_at) = ? ORDER BY created_at DESC').all(date)
    : db.prepare('SELECT * FROM narcotics_log ORDER BY created_at DESC LIMIT 200').all();
  return sendJSON(res, 200, rows);
}));

module.exports = router;
module.exports.closeVisitIfNothingPending = closeVisitIfNothingPending;
