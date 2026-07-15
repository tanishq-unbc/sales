const sqlite3 = require('sqlite3').verbose();

// Create an in-memory database
const db = new sqlite3.Database(':memory:');

db.serialize(() => {
  // 1. Create a table
  db.run("CREATE TABLE sales (id INT, product TEXT, price DECIMAL)");

  // 2. Insert some data
  const stmt = db.prepare("INSERT INTO sales VALUES (?, ?, ?)");
  stmt.run(1, "Laptop", 999.99);
  stmt.run(2, "Mouse", 25.50);
  stmt.finalize();

  // 3. Query the data
  db.each("SELECT id, product, price FROM sales", (err, row) => {
    if (err) {
      console.error(err);
      return;
    }
    console.log(`Successfully read from DB -> ID: ${row.id}, Product: ${row.product}, Price: $${row.price}`);
  });
});

db.close();