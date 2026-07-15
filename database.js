const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'sales_order_automation.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    credit_limit REAL NOT NULL DEFAULT 0,
    outstanding_balance REAL NOT NULL DEFAULT 0,
    credit_status TEXT NOT NULL DEFAULT 'good',      -- 'good' | 'watch' | 'blocked'
    payment_terms TEXT NOT NULL DEFAULT 'Net 30',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    source TEXT NOT NULL,                            -- 'customer' | 'sales_team'
    notes TEXT,
    requested_delivery_terms TEXT,
    requested_payment_terms TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  );

  CREATE TABLE IF NOT EXISTS inquiry_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inquiry_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity REAL NOT NULL,
    target_price REAL,
    FOREIGN KEY (inquiry_id) REFERENCES inquiries(id)
  );

  CREATE TABLE IF NOT EXISTS quotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inquiry_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',             -- 'draft' | 'sent'
    delivery_terms TEXT NOT NULL,
    payment_terms TEXT NOT NULL,
    total REAL NOT NULL,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (inquiry_id) REFERENCES inquiries(id),
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  );

  CREATE TABLE IF NOT EXISTS quotation_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quotation_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit_price REAL NOT NULL,
    line_total REAL NOT NULL,
    FOREIGN KEY (quotation_id) REFERENCES quotations(id)
  );

  CREATE TABLE IF NOT EXISTS lpos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quotation_id INTEGER NOT NULL,
    lpo_reference TEXT,
    customer_name_on_lpo TEXT NOT NULL,
    delivery_terms TEXT NOT NULL,
    payment_terms TEXT NOT NULL,
    total REAL NOT NULL,
    match_status TEXT NOT NULL DEFAULT 'pending',      -- 'pending' | 'matched' | 'flagged' | 'approved_override'
    match_detail TEXT,
    financial_status TEXT NOT NULL DEFAULT 'not_checked', -- 'not_checked' | 'pass' | 'hold'
    financial_detail TEXT,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (quotation_id) REFERENCES quotations(id)
  );

  CREATE TABLE IF NOT EXISTS lpo_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lpo_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit_price REAL NOT NULL,
    line_total REAL NOT NULL,
    FOREIGN KEY (lpo_id) REFERENCES lpos(id)
  );

  CREATE TABLE IF NOT EXISTS sales_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lpo_id INTEGER NOT NULL,
    quotation_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'issued',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (lpo_id) REFERENCES lpos(id),
    FOREIGN KEY (quotation_id) REFERENCES quotations(id),
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function logAudit(entityType, entityId, action, detail) {
  db.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, detail) VALUES (?, ?, ?, ?)`
  ).run(entityType, entityId, action, detail == null ? null : JSON.stringify(detail));
}

module.exports = { db, logAudit };