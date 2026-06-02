const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  const tenantsRes = await pool.query('SELECT id FROM tenants');
  const tenantIds = tenantsRes.rows.map(r => r.id);

  const eventTypes = ['payment.failed', 'payment.success', 'user.registered', 'order.shipped', 'password.reset'];
  const channels = ['email', 'sms', 'push'];

  console.log(`Found ${tenantIds.length} tenants in the database. Seeding templates...`);

  for (const tenantId of tenantIds) {
    for (const eventType of eventTypes) {
      for (const channel of channels) {
        await pool.query(`
          INSERT INTO notification_templates (tenant_id, event_type, channel, subject_template, body_template)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (tenant_id, event_type, channel) DO NOTHING
        `, [
          tenantId,
          eventType,
          channel,
          channel === 'email' ? `${eventType.toUpperCase()} Notification` : null,
          channel === 'email'
            ? `Hello {{name}}, event ${eventType} has occurred. Details: Amount is {{amount}} {{currency}}.`
            : `Notification: ${eventType} has occurred for user {{userId}}.`
        ]);
      }
    }
  }

  console.log('Seeded all templates for all channels and tenants!');
  await pool.end();
}

seed().catch(err => console.error(err));
