const path = require('path');
const Database = require('better-sqlite3');

// Vercel environments are read-only, so we redirect the DB to /tmp in production
const dbPath = process.env.VERCEL 
  ? path.join('/tmp', 'sales_orders.db') 
  : path.join(__dirname, 'sales_orders.db');

const db = new Database(dbPath);

// These will now execute perfectly since /tmp allows file writing
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  credit_limit REAL NOT NULL DEFAULT 0,
  outstanding_balance REAL NOT NULL DEFAULT 0,
  credit_status TEXT NOT NULL DEFAULT 'good' CHECK (credit_status IN ('good','watch','blocked')),
  payment_terms TEXT NOT NULL DEFAULT 'Net 30'
);

CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  source TEXT NOT NULL CHECK (source IN ('customer','sales_team')),
  notes TEXT,
  requested_delivery_terms TEXT,
  requested_payment_terms TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','quoted','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inquiry_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
  product_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  target_price REAL
);

CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','superseded')),
  delivery_terms TEXT NOT NULL,
  payment_terms TEXT NOT NULL,
  total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS quotation_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id),
  product_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  line_total REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS lpos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id),
  lpo_reference TEXT,
  customer_name_on_lpo TEXT NOT NULL,
  delivery_terms TEXT NOT NULL,
  payment_terms TEXT NOT NULL,
  total REAL NOT NULL DEFAULT 0,
  match_status TEXT NOT NULL DEFAULT 'pending' CHECK (match_status IN ('pending','matched','flagged','approved_override')),
  match_detail TEXT,
  financial_status TEXT NOT NULL DEFAULT 'not_checked' CHECK (financial_status IN ('not_checked','pass','hold')),
  financial_detail TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lpo_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lpo_id INTEGER NOT NULL REFERENCES lpos(id),
  product_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  line_total REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lpo_id INTEGER NOT NULL REFERENCES lpos(id),
  quotation_id INTEGER NOT NULL REFERENCES quotations(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'issued',
  issued_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

function logAudit(entityType, entityId, action, detail, actor) {
  db.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, detail, actor) VALUES (?, ?, ?, ?, ?)`
  ).run(entityType, entityId, action, detail ? JSON.stringify(detail) : null, actor || 'system');
}

module.exports = { db, logAudit };
