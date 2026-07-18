require('dotenv').config();
const { Pool } = require('pg');

// Simulate what the analytics consumer does in Postgres-only mode
// (no Redis, no Kafka)
async function testAnalyticsPostgresOnly() {
  const connectionString = process.env.DATABASE_URL;
  console.log('Testing analytics Postgres-only mode...');
  console.log('DATABASE_URL set:', !!connectionString);
  console.log('REDIS_URL set:', !!process.env.REDIS_URL);
  console.log('KAFKA_BROKERS set:', !!process.env.KAFKA_BROKERS);

  const pool = new Pool({ connectionString });

  const tenantId = 'tenant-d74c9509-f66a-402f-89dd-add83b368e68';

  try {
    const statusResult = await pool.query(
      `SELECT channel, status, COUNT(*) as count FROM delivery_logs WHERE tenant_id = $1 GROUP BY channel, status`,
      [tenantId]
    );

    const dlqResult = await pool.query(
      `SELECT COUNT(*) as count FROM dead_letter_events WHERE tenant_id = $1`,
      [tenantId]
    );

    const recentResult = await pool.query(
      `SELECT event_id, channel, status FROM delivery_logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [tenantId]
    );

    console.log('\n✅ /metrics Postgres-only query SUCCESS');
    console.log('Status rows returned:', statusResult.rows.length);
    console.log('DLQ count:', dlqResult.rows[0].count);
    console.log('Recent logs (5):', recentResult.rows.length);
    console.log('\nSample status row:', JSON.stringify(statusResult.rows[0]));
  } catch (e) {
    console.error('❌ Query failed:', e.message);
  } finally {
    await pool.end();
  }
}

testAnalyticsPostgresOnly();
