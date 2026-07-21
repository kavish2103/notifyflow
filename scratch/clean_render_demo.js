const { Pool } = require('pg');

const p = new Pool({
  connectionString: 'postgresql://notifyflow_db_new_user:dBt1X3PrQHBjF2V8tA6TVU1xuiFPMp6M@dpg-d9d5hegk1i2s73d0rc8g-a.singapore-postgres.render.com/notifyflow_db_new?ssl=true'
});

async function clean() {
  // Cascade delete removes users, prefs, templates, event_types linked to this tenant
  const r = await p.query("DELETE FROM tenants WHERE id='tenant-demo-uuid-1111-2222-3333-4444' OR id='tenant-a1b2c3d4-e5f6-7890-abcd-ef1234567890'");
  console.log('Deleted rows:', r.rowCount);
  await p.end();
}

clean().catch(e => { console.error(e.message); p.end(); });
