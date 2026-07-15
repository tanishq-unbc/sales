const { db, logAudit } = require('./database');

const tx = db.transaction(() => {
  db.prepare('DELETE FROM sales_orders').run();
  db.prepare('DELETE FROM lpo_items').run();
  db.prepare('DELETE FROM lpos').run();
  db.prepare('DELETE FROM quotation_items').run();
  db.prepare('DELETE FROM quotations').run();
  db.prepare('DELETE FROM inquiry_items').run();
  db.prepare('DELETE FROM inquiries').run();
  db.prepare('DELETE FROM customers').run();
  db.prepare('DELETE FROM audit_log').run();

  const insertCustomer = db.prepare(
    `INSERT INTO customers (name, credit_limit, outstanding_balance, credit_status, payment_terms) VALUES (?,?,?,?,?)`
  );

  const c1 = insertCustomer.run('Al Futtaim Trading LLC', 500000, 120000, 'good', 'Net 30').lastInsertRowid;
  const c2 = insertCustomer.run('Gulf Steel Works', 200000, 190000, 'good', 'Net 45').lastInsertRowid;
  const c3 = insertCustomer.run('Desert Rose Contracting', 100000, 40000, 'watch', 'Net 60').lastInsertRowid;

  logAudit('customer', c1, 'seeded', { name: 'Al Futtaim Trading LLC' });
  logAudit('customer', c2, 'seeded', { name: 'Gulf Steel Works' });
  logAudit('customer', c3, 'seeded', { name: 'Desert Rose Contracting' });

  console.log('Seeded customers:', { c1, c2, c3 });
});

tx();
console.log('Seed complete.');