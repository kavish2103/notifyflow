require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Error: DATABASE_URL is not defined in .env');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

async function seedOriginalKey() {
  try {
    console.log('Seeding original B2B tenant and API key...');

    const oldTenantId = 'tenant-d74c9509-f66a-402f-89dd-add83b368e68';
    const oldApiKey = 'nf_key_05073d65cbe342cfd37d01c98167dfe113ddcf8e44ce5691';
    const apiKeyHash = crypto.createHash('sha256').update(oldApiKey).digest('hex');

    // Clean up if it somehow exists
    await pool.query('DELETE FROM tenants WHERE id = $1', [oldTenantId]);

    // Insert original tenant
    await pool.query(
      'INSERT INTO tenants (id, name, api_key_hash, rate_limit_per_minute) VALUES ($1, $2, $3, $4)',
      [oldTenantId, 'Acme Billing Solutions', apiKeyHash, 100]
    );

    console.log('Original B2B tenant and API key seeded successfully!');
    await pool.end();
  } catch (error) {
    console.error('Failed to seed original key:', error.message);
    process.exit(1);
  }
}

seedOriginalKey();
