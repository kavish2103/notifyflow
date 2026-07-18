require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  const r = await p.query(
    'SELECT channel, status, error_message FROM delivery_logs WHERE event_id = $1',
    ['evt-0b3de0dc-2f6f-436c-810f-f5037b199d92']
  );
  if (r.rows.length === 0) {
    console.log('No logs yet - workers still processing');
  } else {
    r.rows.forEach(row => console.log(JSON.stringify(row)));
  }
  await p.end();
}
check().catch(e => { console.error(e.message); p.end(); });
