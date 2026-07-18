require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });

async function fixTemplates() {
  try {
    const emailRes = await p.query(
      "UPDATE notification_templates SET body_template = $1 WHERE event_type = 'order delivered' AND channel = 'email'",
      ['Your order has been delivered, {{name}}! We hope you enjoy it. Confirmation sent to {{email}}.']
    );
    console.log('Email template fixed, rows updated:', emailRes.rowCount);

    const pushRes = await p.query(
      "UPDATE notification_templates SET body_template = $1 WHERE event_type = 'order delivered' AND channel = 'push'",
      ['Order delivered for {{name}}. Check your email {{email}} for details.']
    );
    console.log('Push template fixed, rows updated:', pushRes.rowCount);

    await p.end();
    console.log('Done!');
  } catch (e) {
    console.error('Error:', e.message);
    await p.end();
  }
}

fixTemplates();
