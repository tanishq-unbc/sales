const CENTS = 0.01; // tolerance for float rounding on money comparisons

function moneyEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < CENTS;
}

function normalizeText(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Compares a submitted LPO against the exact quotation that was sent.
 * Returns { status: 'matched' | 'flagged', differences: [...] }
 */
function matchLpoToQuotation(quotation, quotationItems, lpo, lpoItems, customer) {
  const differences = [];

  // 1. Customer name must match the customer the quotation was issued to
  if (normalizeText(lpo.customer_name_on_lpo) !== normalizeText(customer.name)) {
    differences.push({
      field: 'customer_name',
      expected: customer.name,
      received: lpo.customer_name_on_lpo
    });
  }

  // 2. Products & quantities & prices — build maps keyed by normalized product name
  const qMap = new Map();
  for (const item of quotationItems) {
    qMap.set(normalizeText(item.product_name), item);
  }
  const lMap = new Map();
  for (const item of lpoItems) {
    lMap.set(normalizeText(item.product_name), item);
  }

  // Items on the quotation missing or altered on the LPO
  for (const [key, qItem] of qMap.entries()) {
    const lItem = lMap.get(key);
    if (!lItem) {
      differences.push({ field: 'line_item_missing', product: qItem.product_name, expected_quantity: qItem.quantity });
      continue;
    }
    if (Number(lItem.quantity) !== Number(qItem.quantity)) {
      differences.push({
        field: 'quantity',
        product: qItem.product_name,
        expected: qItem.quantity,
        received: lItem.quantity
      });
    }
    if (!moneyEqual(lItem.unit_price, qItem.unit_price)) {
      differences.push({
        field: 'unit_price',
        product: qItem.product_name,
        expected: qItem.unit_price,
        received: lItem.unit_price
      });
    }
    if (!moneyEqual(lItem.line_total, qItem.line_total)) {
      differences.push({
        field: 'line_total',
        product: qItem.product_name,
        expected: qItem.line_total,
        received: lItem.line_total
      });
    }
  }

  // Extra items on the LPO that were never quoted
  for (const [key, lItem] of lMap.entries()) {
    if (!qMap.has(key)) {
      differences.push({ field: 'unquoted_line_item', product: lItem.product_name, quantity: lItem.quantity });
    }
  }

  // 3. Grand total
  if (!moneyEqual(lpo.total, quotation.total)) {
    differences.push({ field: 'total', expected: quotation.total, received: lpo.total });
  }

  // 4. Delivery terms
  if (normalizeText(lpo.delivery_terms) !== normalizeText(quotation.delivery_terms)) {
    differences.push({ field: 'delivery_terms', expected: quotation.delivery_terms, received: lpo.delivery_terms });
  }

  // 5. Payment terms
  if (normalizeText(lpo.payment_terms) !== normalizeText(quotation.payment_terms)) {
    differences.push({ field: 'payment_terms', expected: quotation.payment_terms, received: lpo.payment_terms });
  }

  return {
    status: differences.length === 0 ? 'matched' : 'flagged',
    differences
  };
}

/**
 * Checks the customer ledger: outstanding balance vs credit limit, credit status,
 * and that the LPO's payment terms match what's on file for the customer.
 */
function checkCustomerLedger(customer, lpo, quotation) {
  const reasons = [];

  if (customer.credit_status === 'blocked') {
    reasons.push(`Customer credit status is blocked`);
  } else if (customer.credit_status === 'watch') {
    reasons.push(`Customer credit status is on watch — manual review recommended`);
  }

  const projectedBalance = customer.outstanding_balance + quotation.total;
  if (projectedBalance > customer.credit_limit) {
    reasons.push(
      `Projected outstanding balance (${projectedBalance.toFixed(2)}) would exceed credit limit (${customer.credit_limit.toFixed(2)})`
    );
  }

  if (normalizeText(lpo.payment_terms) !== normalizeText(customer.payment_terms)) {
    reasons.push(
      `LPO payment terms ("${lpo.payment_terms}") do not match customer's approved terms ("${customer.payment_terms}")`
    );
  }

  // "watch" status alone doesn't hard-block, only "blocked" and the numeric checks do
  const hardFail = customer.credit_status === 'blocked' ||
    projectedBalance > customer.credit_limit ||
    normalizeText(lpo.payment_terms) !== normalizeText(customer.payment_terms);

  return {
    status: hardFail ? 'hold' : 'pass',
    reasons
  };
}

module.exports = { matchLpoToQuotation, checkCustomerLedger, moneyEqual, normalizeText };
