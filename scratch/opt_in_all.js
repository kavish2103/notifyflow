const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgres://notifyflow_user:notifyflow_secure_password@localhost:5432/notifyflow_db'
});

async function run() {
  try {
    // Force opt-in for all three channels for user-cust-99
    await pool.query(`
      INSERT INTO user_preferences (user_id, channel, opted_in, updated_at)
      VALUES 
        ('user-cust-99', 'email', true, NOW()),
        ('user-cust-99', 'sms', true, NOW()),
        ('user-cust-99', 'push', true, NOW())
      ON CONFLICT (user_id, channel)
      DO UPDATE SET opted_in = true, updated_at = NOW()
    `);
    console.log('Opted-in user-cust-99 across email, sms, and push in database successfully!');
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
