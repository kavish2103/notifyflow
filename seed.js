require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('\x1b[31mError: DATABASE_URL is not defined in your .env file.\x1b[0m');
  process.exit(1);
}

// Open Postgres connection pool
const pool = new Pool({ connectionString: databaseUrl });

async function seed() {
  try {
    console.log('Seeding B2B test tenant into local PostgreSQL database...');

    // 1. Generate a high-entropy B2B API Key
    const rawApiKey = 'nf_key_' + crypto.randomBytes(24).toString('hex');
    // Compute cryptographic SHA-256 hash (only hash is stored in DB)
    const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');

    const tenantId = `tenant-${crypto.randomUUID()}`;
    const tenantName = 'Acme Billing Solutions';
    const rateLimit = 100; // Allow 100 requests per minute

    // Check if database is already seeded
    const checkResult = await pool.query('SELECT id FROM tenants LIMIT 1');
    if (checkResult.rows.length > 0) {
      console.log('\x1b[33mDatabase already has seeded B2B tenants. Skipping seeding.\x1b[0m');
      await pool.end();
      return;
    }

    // Insert record
    await pool.query(
      'INSERT INTO tenants (id, name, api_key_hash, rate_limit_per_minute) VALUES ($1, $2, $3, $4)',
      [tenantId, tenantName, apiKeyHash, rateLimit]
    );

    console.log('\n\x1b[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('=== B2B TEST TENANT SEEDED SUCCESSFULLY ===');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    console.log(`Tenant ID:   ${tenantId}`);
    console.log(`Tenant Name: ${tenantName}`);
    console.log(`API Key:     \x1b[36m${rawApiKey}\x1b[0m`);
    console.log(`API Hash:    ${apiKeyHash}`);
    console.log('\x1b[33m\nIMPORTANT: Copy the cyan "API Key" above. You must pass this key\nin the "x-api-key" header during testing!\x1b[0m\n');

    await pool.end();
  } catch (error) {
    console.error('\x1b[31mSeeding failed:\x1b[0m', error.message);
    process.exit(1);
  }
}

seed();
