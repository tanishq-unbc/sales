const express = require('express');
const path = require('path');
const { db, logAudit } = require('./database');
const { matchLpoToQuotation, checkCustomerLedger } = require('./logic');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

function lineTotal(qty, price) {
  return Math.round(Number(qty) * Number(price) * 100) / 100;
}
function sumTotal(items) {
  return Math.round(items.reduce((s, i) => s + Number(i.line_total), 0) * 100) / 100;
}

// ---------- Customers ----------
app.get('/api/customers', (req, res) => {
  res.json(db.prepare('SELECT * FROM customers ORDER BY name').all());
});

app.post('/api/customers', (req, res) => {
  const { name, credit_limit, outstanding_balance, credit_status, payment_terms } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db
    .prepare(
      `INSERT INTO customers (name, credit_limit, outstanding_balance, credit_status, payment_terms) VALUES (?,?,?,?,?)`
    )
    .run(name, credit_limit || 0, outstanding_balance || 0, credit_status || 'good', payment_terms || 'Net 30');
  logAudit('customer', info.lastInsertRowid, 'created', req.body);
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
});

// ---------- 1. Inquiry received ----------
app.post('/api/inquiries', (req, res) => {
  const { customer_id, source, notes, requested_delivery_terms, requested_payment_terms, items } = req.body;
  if (!customer_id || !source || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'customer_id, source, and at least one item are required' });
  }
  if (!['customer', 'sales_team'].includes(source)) {
    return res.status(400).json({ error: "source must be 'customer' or 'sales_team'" });
  }

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO inquiries (customer_id, source, notes, requested_delivery_terms, requested_payment_terms) VALUES (?,?,?,?,?)`
      )
      .run(customer_id, source, notes || null, requested_delivery_terms || null, requested_payment_terms || null);
    const inquiryId = info.lastInsertRowid;
    const insertItem = db.prepare(
      `INSERT INTO inquiry_items (inquiry_id, product_name, quantity, target_price) VALUES (?,?,?,?)`
    );
    for (const it of items) {
      insertItem.run(inquiryId, it.product_name, it.quantity, it.target_price || null);
    }
    return inquiryId;
  });

  const inquiryId = tx();
  logAudit('inquiry', inquiryId, 'received', { source, customer_id });
  res.json(getInquiryFull(inquiryId));
});

function getInquiryFull(id) {
  const inquiry = db.prepare('SELECT * FROM inquiries WHERE id = ?').get(id);
  if (!inquiry) return null;
  inquiry.items = db.prepare('SELECT * FROM inquiry_items WHERE inquiry_id = ?').all(id);
  inquiry.customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(inquiry.customer_id);
  return inquiry;
}

app.get('/api/inquiries', (req, res) => {
  const rows = db.prepare('SELECT * FROM inquiries ORDER BY created_at DESC').all();
  res.json(rows.map((r) => getInquiryFull(r.id)));
});

app.get('/api/inquiries/:id', (req, res) => {
  const full = getInquiryFull(req.params.id);
  if (!full) return res.status(404).json({ error: 'not found' });
  res.json(full);
});

// ---------- 2. Quotation created and sent ----------
app.post('/api/inquiries/:id/quotation', (req, res) => {
  const inquiry = getInquiryFull(req.params.id);
  if (!inquiry) return res.status(404).json({ error: 'inquiry not found' });

  const { items, delivery_terms, payment_terms } = req.body;
  // items: [{ product_name, quantity, unit_price }]
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items with unit_price are required to build a quotation' });
  }
  if (!delivery_terms || !payment_terms) {
    return res.status(400).json({ error: 'delivery_terms and payment_terms are required' });
  }

  const priced = items.map((it) => ({
    product_name: it.product_name,
    quantity: Number(it.quantity),
    unit_price: Number(it.unit_price),
    line_total: lineTotal(it.quantity, it.unit_price)
  }));
  const total = sumTotal(priced);

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO quotations (inquiry_id, customer_id, status, delivery_terms, payment_terms, total) VALUES (?,?,?,?,?,?)`
      )
      .run(inquiry.id, inquiry.customer_id, 'draft', delivery_terms, payment_terms, total);
    const quotationId = info.lastInsertRowid;
    const insertItem = db.prepare(
      `INSERT INTO quotation_items (quotation_id, product_name, quantity, unit_price, line_total) VALUES (?,?,?,?,?)`
    );
    for (const it of priced) insertItem.run(quotationId, it.product_name, it.quantity, it.unit_price, it.line_total);
    db.prepare(`UPDATE inquiries SET status = 'quoted' WHERE id = ?`).run(inquiry.id);
    return quotationId;
  });

  const quotationId = tx();
  logAudit('quotation', quotationId, 'created', { inquiry_id: inquiry.id, total });
  res.json(getQuotationFull(quotationId));
});

function getQuotationFull(id) {
  const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id);
  if (!q) return null;
  q.items = db.prepare('SELECT * FROM quotation_items WHERE quotation_id = ?').all(id);
  q.customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(q.customer_id);
  return q;
}

app.get('/api/quotations', (req, res) => {
  const rows = db.prepare('SELECT * FROM quotations ORDER BY created_at DESC').all();
  res.json(rows.map((r) => getQuotationFull(r.id)));
});

app.get('/api/quotations/:id', (req, res) => {
  const full = getQuotationFull(req.params.id);
  if (!full) return res.status(404).json({ error: 'not found' });
  res.json(full);
});

// Locks the quotation as the exact reference version sent to the customer
app.post('/api/quotations/:id/send', (req, res) => {
  const q = getQuotationFull(req.params.id);
  if (!q) return res.status(404).json({ error: 'not found' });
  if (q.status !== 'draft') return res.status(400).json({ error: `quotation is already ${q.status}` });
  db.prepare(`UPDATE quotations SET status = 'sent', sent_at = datetime('now') WHERE id = ?`).run(q.id);
  logAudit('quotation', q.id, 'sent', null);
  res.json(getQuotationFull(q.id));
});

// ---------- 3 & 4. LPO received, checked against quotation ----------
app.post('/api/quotations/:id/lpo', (req, res) => {
  const quotation = getQuotationFull(req.params.id);
  if (!quotation) return res.status(404).json({ error: 'quotation not found' });
  if (quotation.status !== 'sent') {
    return res.status(400).json({ error: 'an LPO can only be checked against a quotation that has been sent' });
  }

  const { lpo_reference, customer_name_on_lpo, delivery_terms, payment_terms, items } = req.body;
  if (!customer_name_on_lpo || !delivery_terms || !payment_terms || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'customer_name_on_lpo, delivery_terms, payment_terms, and items are required' });
  }

  const priced = items.map((it) => ({
    product_name: it.product_name,
    quantity: Number(it.quantity),
    unit_price: Number(it.unit_price),
    line_total: it.line_total != null ? Number(it.line_total) : lineTotal(it.quantity, it.unit_price)
  }));
  const total = req.body.total != null ? Number(req.body.total) : sumTotal(priced);

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO lpos (quotation_id, lpo_reference, customer_name_on_lpo, delivery_terms, payment_terms, total) VALUES (?,?,?,?,?,?)`
      )
      .run(quotation.id, lpo_reference || null, customer_name_on_lpo, delivery_terms, payment_terms, total);
    const lpoId = info.lastInsertRowid;
    const insertItem = db.prepare(
      `INSERT INTO lpo_items (lpo_id, product_name, quantity, unit_price, line_total) VALUES (?,?,?,?,?)`
    );
    for (const it of priced) insertItem.run(lpoId, it.product_name, it.quantity, it.unit_price, it.line_total);
    return lpoId;
  });

  const lpoId = tx();
  const result = runMatchCheck(lpoId);
  res.json(result);
});

function runMatchCheck(lpoId) {
  const lpo = db.prepare('SELECT * FROM lpos WHERE id = ?').get(lpoId);
  const lpoItems = db.prepare('SELECT * FROM lpo_items WHERE lpo_id = ?').all(lpoId);
  const quotation = getQuotationFull(lpo.quotation_id);
  const match = matchLpoToQuotation(quotation, quotation.items, lpo, lpoItems, quotation.customer);

  db.prepare(`UPDATE lpos SET match_status = ?, match_detail = ? WHERE id = ?`).run(
    match.status,
    JSON.stringify(match.differences),
    lpoId
  );
  logAudit('lpo', lpoId, match.status === 'matched' ? 'matched' : 'flagged', match.differences);
  return getLpoFull(lpoId);
}

function getLpoFull(id) {
  const lpo = db.prepare('SELECT * FROM lpos WHERE id = ?').get(id);
  if (!lpo) return null;
  lpo.items = db.prepare('SELECT * FROM lpo_items WHERE lpo_id = ?').all(id);
  lpo.match_detail = lpo.match_detail ? JSON.parse(lpo.match_detail) : [];
  lpo.financial_detail = lpo.financial_detail ? JSON.parse(lpo.financial_detail) : [];
  lpo.quotation = getQuotationFull(lpo.quotation_id);
  const so = db.prepare('SELECT * FROM sales_orders WHERE lpo_id = ?').get(id);
  lpo.sales_order = so || null;
  return lpo;
}

app.get('/api/lpos', (req, res) => {
  const rows = db.prepare('SELECT id FROM lpos ORDER BY received_at DESC').all();
  res.json(rows.map((r) => getLpoFull(r.id)));
});

app.get('/api/lpos/:id', (req, res) => {
  const full = getLpoFull(req.params.id);
  if (!full) return res.status(404).json({ error: 'not found' });
  res.json(full);
});

// A corrected LPO is resubmitted here — re-runs the match check (workflow loops back to step 4)
app.post('/api/lpos/:id/resubmit', (req, res) => {
  const existing = getLpoFull(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.match_status !== 'flagged') {
    return res.status(400).json({ error: 'only a flagged LPO can be resubmitted' });
  }
  const { lpo_reference, customer_name_on_lpo, delivery_terms, payment_terms, items } = req.body;
  const priced = items.map((it) => ({
    product_name: it.product_name,
    quantity: Number(it.quantity),
    unit_price: Number(it.unit_price),
    line_total: it.line_total != null ? Number(it.line_total) : lineTotal(it.quantity, it.unit_price)
  }));
  const total = req.body.total != null ? Number(req.body.total) : sumTotal(priced);

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE lpos SET lpo_reference=?, customer_name_on_lpo=?, delivery_terms=?, payment_terms=?, total=?, match_status='pending', financial_status='not_checked' WHERE id=?`
    ).run(lpo_reference || existing.lpo_reference, customer_name_on_lpo, delivery_terms, payment_terms, total, existing.id);
    db.prepare(`DELETE FROM lpo_items WHERE lpo_id = ?`).run(existing.id);
    const insertItem = db.prepare(
      `INSERT INTO lpo_items (lpo_id, product_name, quantity, unit_price, line_total) VALUES (?,?,?,?,?)`
    );
    for (const it of priced) insertItem.run(existing.id, it.product_name, it.quantity, it.unit_price, it.line_total);
  });
  tx();
  logAudit('lpo', existing.id, 'resubmitted', null);
  res.json(runMatchCheck(existing.id));
});

// Manual approval to override a flagged mismatch (logged, not silent)
app.post('/api/lpos/:id/approve-override', (req, res) => {
  const lpo = getLpoFull(req.params.id);
  if (!lpo) return res.status(404).json({ error: 'not found' });
  if (lpo.match_status !== 'flagged') return res.status(400).json({ error: 'only a flagged LPO can be overridden' });
  const { approver, reason } = req.body;
  if (!approver || !reason) return res.status(400).json({ error: 'approver and reason are required for an override' });

  db.prepare(`UPDATE lpos SET match_status = 'approved_override' WHERE id = ?`).run(lpo.id);
  logAudit('lpo', lpo.id, 'override_approved', { approver, reason });
  res.json(getLpoFull(lpo.id));
});

// ---------- 5. Customer ledger and payment terms checked ----------
app.post('/api/lpos/:id/check-financials', (req, res) => {
  const lpo = getLpoFull(req.params.id);
  if (!lpo) return res.status(404).json({ error: 'not found' });
  if (!['matched', 'approved_override'].includes(lpo.match_status)) {
    return res.status(400).json({ error: 'LPO must match the quotation (or be override-approved) before the financial check runs' });
  }
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(lpo.quotation.customer_id);
  const result = checkCustomerLedger(customer, lpo, lpo.quotation);

  db.prepare(`UPDATE lpos SET financial_status = ?, financial_detail = ? WHERE id = ?`).run(
    result.status,
    JSON.stringify(result.reasons),
    lpo.id
  );
  logAudit('lpo', lpo.id, `financial_${result.status}`, result.reasons);
  res.json(getLpoFull(lpo.id));
});

// ---------- 6. Sales order issued ----------
app.post('/api/lpos/:id/issue-order', (req, res) => {
  const lpo = getLpoFull(req.params.id);
  if (!lpo) return res.status(404).json({ error: 'not found' });
  if (!['matched', 'approved_override'].includes(lpo.match_status)) {
    return res.status(400).json({ error: 'LPO does not match the quotation' });
  }
  if (lpo.financial_status !== 'pass') {
    return res.status(400).json({ error: 'customer ledger / credit check has not passed' });
  }
  if (lpo.sales_order) {
    return res.status(400).json({ error: 'a sales order has already been issued for this LPO' });
  }

  const info = db
    .prepare(`INSERT INTO sales_orders (lpo_id, quotation_id, customer_id, status) VALUES (?,?,?, 'issued')`)
    .run(lpo.id, lpo.quotation_id, lpo.quotation.customer_id);
  logAudit('sales_order', info.lastInsertRowid, 'issued', { lpo_id: lpo.id });
  res.json(getLpoFull(lpo.id));
});

// ---------- Audit log ----------
app.get('/api/audit-log', (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all());
});

app.listen(PORT, () => {
  console.log(`Sales order automation running at http://localhost:${PORT}`);
});
