const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgres://notifyflow_user:notifyflow_secure_password@localhost:5432/notifyflow_db'
});

async function run() {
  try {
    const res = await pool.query(
      "SELECT channel, status, error_message, retry_count, created_at FROM delivery_logs WHERE event_id = 'evt-5d759d12-edb7-4c23-b94e-2d33b133d96b'"
    );
    console.log('\n\x1b[32m=== E2E DATABASE DELIVERY LOGS ===\x1b[0m');
    console.table(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
