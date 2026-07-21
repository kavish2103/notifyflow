const { Pool } = require('pg');

const p = new Pool({
  connectionString: 'postgresql://notifyflow_db_new_user:dBt1X3PrQHBjF2V8tA6TVU1xuiFPMp6M@dpg-d9d5hegk1i2s73d0rc8g-a.singapore-postgres.render.com/notifyflow_db_new?ssl=true'
});

async function listTables() {
  const res = await p.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
  console.log('Tables found:', res.rows.map(r => r.table_name));
  await p.end();
}

listTables().catch(e => { console.error(e); p.end(); });
