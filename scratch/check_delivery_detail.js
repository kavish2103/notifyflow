require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Find most recent email delivery for this user
  const r = await p.query(`
    SELECT 
      dl.event_id, dl.channel, dl.status, dl.error_message, 
      dl.rendered_body, dl.recipient_address, dl.created_at
    FROM delivery_logs dl
    JOIN events e ON e.id = dl.event_id
    WHERE e.user_id = 'user-cust-99' AND dl.channel = 'email'
    ORDER BY dl.created_at DESC
    LIMIT 5
  `);
  if (r.rows.length === 0) {
    console.log('No email delivery logs for user-cust-99');
  } else {
    r.rows.forEach(row => console.log(JSON.stringify(row)));
  }
  await p.end();
}
check().catch(e => { console.error(e.message); p.end(); });
