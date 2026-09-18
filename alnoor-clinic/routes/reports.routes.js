// routes/reports.routes.js — daily closing reports (owner handover)
const { createRouter } = require('../router');
const { db } = require('../db');
const { sendJSON, requireAuth, asyncHandler } = require('../middleware');

const router = createRouter();

router.get('/api/reports/lab-daily', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['lab', 'admin']); if (!staff) return;
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
  // Revenue is recognized the moment payment clears (paid_at), not when the
  // report is finally verified/delivered — per the payment-gate policy, the
  // hospital keeps that money whether or not the patient ever returns for the
  // report, so every order that was PAID that day counts here regardless of
  // which downstream status (PAID..DELIVERED) it currently sits at.
  const rows = db.prepare(`
    SELECT lo.id, pt.name AS patient_name, pt.mr_number, pt.patient_type, lo.tests, lo.payment_amount, lo.receipt_no, lo.paid_at, lo.status, lo.entered_by
    FROM lab_orders lo JOIN patients pt ON pt.id = lo.patient_id
    WHERE lo.paid_at IS NOT NULL AND date(lo.paid_at) = ?
    ORDER BY lo.paid_at ASC
  `).all(date).map(r => ({ ...r, tests: JSON.parse(r.tests).join(', ') }));
  const totalRevenue = rows.reduce((s, r) => s + (r.payment_amount || 0), 0);
  return sendJSON(res, 200, { date, totalTests: rows.length, totalRevenue, rows });
}));

router.get('/api/reports/pharmacy-daily', asyncHandler(async (req, res, match, url) => {
  const staff = requireAuth(req, res, ['pharmacy', 'admin']); if (!staff) return;
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);

  // 'RETURNED-STOCK' batches are inventory that came back from a customer return,
  // not a real distributor purchase — excluded here so purchase totals reflect
  // actual buying activity. They're reported separately, under `returns` below.
  const purchases = db.prepare(`
    SELECT COALESCE(SUM(purchase_price * quantity), 0) AS total, COUNT(*) AS batchCount
    FROM drug_batches WHERE date(created_at) = ? AND batch_number != 'RETURNED-STOCK'
  `).get(date);

  // Itemized purchase detail — one row per batch received that day, with the
  // distributor/supplier and invoice number so the owner can trace every
  // purchase back to a specific supplier bill, not just see a lump total.
  const purchaseDetails = db.prepare(`
    SELECT drug_name, distributor_name, company_name, invoice_number, batch_number,
           quantity, purchase_price, (quantity * purchase_price) AS total_cost, created_at AS purchase_date
    FROM drug_batches WHERE date(created_at) = ? AND batch_number != 'RETURNED-STOCK' ORDER BY created_at ASC
  `).all(date);

  const sales = db.prepare(`
    SELECT * FROM dispenses WHERE date(created_at) = ? ORDER BY created_at ASC
  `).all(date).map(d => ({ ...d, items: JSON.parse(d.items) }));

  const grossSales = sales.reduce((s, d) => s + (d.payment_amount || 0), 0);
  let cogs = 0;
  for (const d of sales) {
    for (const item of d.items) {
      for (const b of (item.batches || [])) {
        cogs += (b.purchase_price || 0) * (b.qty || 0);
      }
    }
  }

  // Customer medicine returns processed that day (self-service pharmacy refund —
  // see routes/pharmacy.routes.js `/api/pharmacy/returns`). Refunds reduce net
  // sales, and the cost of the returned stock — captured on the restocked batch
  // at the moment of return — reverses out of cost of goods sold, since it's
  // back on the shelf unsold, not consumed.
  const returns = db.prepare(`
    SELECT mr.*, db.purchase_price AS restock_cost
    FROM medicine_returns mr LEFT JOIN drug_batches db ON db.id = mr.restock_batch_id
    WHERE date(mr.created_at) = ? ORDER BY mr.created_at ASC
  `).all(date);
  const totalRefunds = returns.reduce((s, r) => s + (r.refund_amount || 0), 0);
  const returnsCogsReversal = returns.reduce((s, r) => s + ((r.restock_cost || 0) * r.qty), 0);

  const netSales = grossSales - totalRefunds;
  const adjustedCogs = cogs - returnsCogsReversal;
  const netProfit = netSales - adjustedCogs;

  return sendJSON(res, 200, {
    date,
    purchases: { total: purchases.total, batchesAdded: purchases.batchCount, details: purchaseDetails },
    grossSales, costOfGoodsSold: cogs,
    returns: returns.map(r => ({ return_no: r.return_no, drug_name: r.drug_name, qty: r.qty, unit_price: r.unit_price, refund_amount: r.refund_amount, original_receipt_no: r.original_receipt_no, processed_by: r.processed_by, created_at: r.created_at })),
    returnCount: returns.length, totalRefunds, returnsCogsReversal,
    netSales, adjustedCogs, netProfit,
    saleCount: sales.length,
    sales: sales.map(d => ({ receipt_no: d.receipt_no, items: d.items, subtotal: d.subtotal, discount_percent: d.discount_percent, payment_amount: d.payment_amount, dispensed_by: d.dispensed_by, created_at: d.created_at }))
  });
}));

module.exports = router;
