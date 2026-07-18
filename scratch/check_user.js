require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  const r = await p.query('SELECT id, email, phone FROM users WHERE id = $1', ['user-cust-99']);
  if (r.rows.length === 0) {
    console.log('User user-cust-99 does NOT exist in database!');
  } else {
    console.log('User found:', JSON.stringify(r.rows[0]));
  }
  await p.end();
}
check().catch(e => { console.error(e.message); p.end(); });
