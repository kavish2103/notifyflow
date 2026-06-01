const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgres://notifyflow_user:notifyflow_secure_password@localhost:5432/notifyflow_db'
});

async function run() {
  try {
    const res = await pool.query("UPDATE users SET email = 'kvsinghal2103@gmail.com' WHERE id = 'user-cust-99'");
    console.log('User email updated successfully in PostgreSQL. Row count:', res.rowCount);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
