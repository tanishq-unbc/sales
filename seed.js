const { db } = require('./database');

const customers = [
  { name: 'Al Futtaim Trading LLC', credit_limit: 50000, outstanding_balance: 12000, credit_status: 'good', payment_terms: 'Net 30' },
  { name: 'Gulf Metals FZE', credit_limit: 20000, outstanding_balance: 19500, credit_status: 'watch', payment_terms: 'Net 15' },
  { name: 'Desert Rose Foods', credit_limit: 15000, outstanding_balance: 16200, credit_status: 'blocked', payment_terms: 'Net 30' },
  { name: 'Marina Contracting Co', credit_limit: 100000, outstanding_balance: 5000, credit_status: 'good', payment_terms: 'Net 45' }
];

const insert = db.prepare(
  `INSERT OR IGNORE INTO customers (name, credit_limit, outstanding_balance, credit_status, payment_terms) VALUES (@name, @credit_limit, @outstanding_balance, @credit_status, @payment_terms)`
);

const tx = db.transaction((rows) => {
  for (const c of rows) insert.run(c);
});

tx(customers);

console.log(`Seeded ${customers.length} customers (existing rows skipped).`);
