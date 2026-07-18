require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // First check what tables exist
  const tables = await p.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' ORDER BY table_name
  `);
  console.log('Tables:', tables.rows.map(r => r.table_name).join(', '));

  // Check columns in delivery_logs
  const cols = await p.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_name = 'delivery_logs' ORDER BY ordinal_position
  `);
  console.log('delivery_logs columns:', cols.rows.map(r => r.column_name).join(', '));

  await p.end();
}
check().catch(e => { console.error(e.message); p.end(); });
