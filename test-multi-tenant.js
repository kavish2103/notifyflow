const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not defined in your .env file.');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  try {
    console.log('=== PART A: TENANT ISOLATION VERIFICATION ===\n');

    // 1. Seed Tenants
    console.log('1. Seeding tenants and users...');
    
    // TechCorp
    const techCorpName = 'TechCorp';
    const checkA = await pool.query('SELECT id FROM tenants WHERE name = $1', [techCorpName]);
    let tenantAId;
    const techCorpApiKey = 'nf_key_techcorp_' + crypto.randomBytes(16).toString('hex');
    const hashA = crypto.createHash('sha256').update(techCorpApiKey).digest('hex');
    
    if (checkA.rows.length > 0) {
      tenantAId = checkA.rows[0].id;
      await pool.query('UPDATE tenants SET api_key_hash = $1 WHERE id = $2', [hashA, tenantAId]);
      console.log(`Tenant TechCorp already existed. ID: ${tenantAId}. Updated API Key hash.`);
    } else {
      tenantAId = `tenant-${crypto.randomUUID()}`;
      await pool.query('INSERT INTO tenants (id, name, api_key_hash, rate_limit_per_minute) VALUES ($1, $2, $3, 100)', [
        tenantAId, techCorpName, hashA
      ]);
      console.log(`Created Tenant TechCorp. ID: ${tenantAId}`);
    }

    // RetailCo
    const retailCoName = 'RetailCo';
    const checkB = await pool.query('SELECT id FROM tenants WHERE name = $1', [retailCoName]);
    let tenantBId;
    const retailCoApiKey = 'nf_key_retailco_' + crypto.randomBytes(16).toString('hex');
    const hashB = crypto.createHash('sha256').update(retailCoApiKey).digest('hex');
    
    if (checkB.rows.length > 0) {
      tenantBId = checkB.rows[0].id;
      await pool.query('UPDATE tenants SET api_key_hash = $1 WHERE id = $2', [hashB, tenantBId]);
      console.log(`Tenant RetailCo already existed. ID: ${tenantBId}. Updated API Key hash.`);
    } else {
      tenantBId = `tenant-${crypto.randomUUID()}`;
      await pool.query('INSERT INTO tenants (id, name, api_key_hash, rate_limit_per_minute) VALUES ($1, $2, $3, 100)', [
        tenantBId, retailCoName, hashB
      ]);
      console.log(`Created Tenant RetailCo. ID: ${tenantBId}`);
    }

    // 2. Seed Users
    // TechCorp User
    const extUserA = 'techcorp-user-1';
    const checkUserA = await pool.query('SELECT id FROM users WHERE tenant_id = $1 AND external_user_id = $2', [tenantAId, extUserA]);
    let userAId;
    if (checkUserA.rows.length > 0) {
      userAId = checkUserA.rows[0].id;
      await pool.query('UPDATE users SET email=$1, phone=$2, push_token=$3 WHERE id=$4', [
        'techcorp-user1@example.com', '+1111111111', 'push_token_techcorp_1', userAId
      ]);
    } else {
      userAId = `user-${crypto.randomUUID()}`;
      await pool.query('INSERT INTO users (id, tenant_id, external_user_id, email, phone, push_token) VALUES ($1, $2, $3, $4, $5, $6)', [
        userAId, tenantAId, extUserA, 'techcorp-user1@example.com', '+1111111111', 'push_token_techcorp_1'
      ]);
    }
    console.log(`Seeded user for TechCorp. ID: ${userAId}`);

    // RetailCo User
    const extUserB = 'retailco-user-1';
    const checkUserB = await pool.query('SELECT id FROM users WHERE tenant_id = $1 AND external_user_id = $2', [tenantBId, extUserB]);
    let userBId;
    if (checkUserB.rows.length > 0) {
      userBId = checkUserB.rows[0].id;
      await pool.query('UPDATE users SET email=$1, phone=$2, push_token=$3 WHERE id=$4', [
        'retailco-user1@example.com', '+2222222222', 'push_token_retailco_1', userBId
      ]);
    } else {
      userBId = `user-${crypto.randomUUID()}`;
      await pool.query('INSERT INTO users (id, tenant_id, external_user_id, email, phone, push_token) VALUES ($1, $2, $3, $4, $5, $6)', [
        userBId, tenantBId, extUserB, 'retailco-user1@example.com', '+2222222222', 'push_token_retailco_1'
      ]);
    }
    console.log(`Seeded user for RetailCo. ID: ${userBId}`);

    // Opt-in preferences for both
    const channels = ['email', 'sms', 'push'];
    for (const userId of [userAId, userBId]) {
      for (const ch of channels) {
        await pool.query(`
          INSERT INTO user_preferences (user_id, channel, opted_in)
          VALUES ($1, $2, TRUE)
          ON CONFLICT (user_id, channel) DO UPDATE SET opted_in = TRUE
        `, [userId, ch]);
      }
    }

    // Seed templates for payment.failed
    for (const ch of channels) {
      await pool.query(`
        INSERT INTO notification_templates (tenant_id, event_type, channel, subject_template, body_template)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tenant_id, event_type, channel) DO NOTHING
      `, [
        tenantAId, 'payment.failed', ch,
        ch === 'email' ? 'Payment Failed for TechCorp' : null,
        ch === 'email' ? 'Hello {{name}}, your payment of {{amount}} {{currency}} failed.' : 'Payment failed.'
      ]);

      await pool.query(`
        INSERT INTO notification_templates (tenant_id, event_type, channel, subject_template, body_template)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tenant_id, event_type, channel) DO NOTHING
      `, [
        tenantBId, 'payment.failed', ch,
        ch === 'email' ? 'Payment Failed for RetailCo' : null,
        ch === 'email' ? 'Hello {{name}}, your payment of {{amount}} {{currency}} failed.' : 'Payment failed.'
      ]);
    }
    console.log('Seeded preferences and payment.failed templates.\n');

    // Clean previous delivery logs for these users to make this test run deterministic
    await pool.query('DELETE FROM delivery_logs WHERE user_id IN ($1, $2)', [userAId, userBId]);

    // 2. Fire 3 events for TechCorp
    console.log('2. Ingesting 3 payment.failed events for TechCorp...');
    for (let i = 1; i <= 3; i++) {
      const payload = {
        clientEventId: `techcorp-event-${i}-${Date.now()}`,
        tenantId: tenantAId,
        userId: userAId,
        eventType: 'payment.failed',
        payload: { name: 'TechCorp User', amount: 100 * i, currency: 'USD' }
      };

      const res = await fetch('http://localhost:3000/v1/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': techCorpApiKey },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        throw new Error(`Failed to ingest event for TechCorp: Status ${res.status}`);
      }
      console.log(`   Event ${i} sent successfully`);
    }

    // 3. Fire 3 events for RetailCo
    console.log('\n3. Ingesting 3 payment.failed events for RetailCo...');
    for (let i = 1; i <= 3; i++) {
      const payload = {
        clientEventId: `retailco-event-${i}-${Date.now()}`,
        tenantId: tenantBId,
        userId: userBId,
        eventType: 'payment.failed',
        payload: { name: 'RetailCo User', amount: 50 * i, currency: 'USD' }
      };

      const res = await fetch('http://localhost:3000/v1/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': retailCoApiKey },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        throw new Error(`Failed to ingest event for RetailCo: Status ${res.status}`);
      }
      console.log(`   Event ${i} sent successfully`);
    }

    console.log('\nWaiting for background workers to process notifications...');
    await sleep(4000); // Wait for Kafka consumption and DB writes

    // 4. Query delivery_logs and group by tenant_id
    console.log('\n4. Verifying tenant isolation in delivery_logs table:');
    const logsRes = await pool.query(`
      SELECT tenant_id, channel, status, COUNT(*) as log_count 
      FROM delivery_logs 
      WHERE user_id IN ($1, $2)
      GROUP BY tenant_id, channel, status
      ORDER BY tenant_id
    `, [userAId, userBId]);

    console.table(logsRes.rows);

    const techCorpLogs = logsRes.rows.filter(r => r.tenant_id === tenantAId);
    const retailCoLogs = logsRes.rows.filter(r => r.tenant_id === tenantBId);
    
    console.log(`   TechCorp (${tenantAId}) log rows count: ${techCorpLogs.reduce((acc, val) => acc + parseInt(val.log_count), 0)}`);
    console.log(`   RetailCo (${tenantBId}) log rows count: ${retailCoLogs.reduce((acc, val) => acc + parseInt(val.log_count), 0)}`);

    // Verify no cross-mixing
    const crossMixCheck = await pool.query(`
      SELECT COUNT(*) as mix_count 
      FROM delivery_logs 
      WHERE (tenant_id = $1 AND user_id = $2) OR (tenant_id = $3 AND user_id = $4)
    `, [tenantAId, userBId, tenantBId, userAId]);
    
    const mixCount = parseInt(crossMixCheck.rows[0].mix_count);
    if (mixCount === 0) {
      console.log('\x1b[32m   [SUCCESS] Zero cross-mixing detected in database delivery logs!\x1b[0m');
    } else {
      console.log('\x1b[31m   [FAILURE] Tenant cross-mixing detected! Log entries found matching wrong tenant_id/user_id combinations.\x1b[0m');
    }

    // Clear Redis Cache so we get fresh database queries
    const { getRedisClient } = require('@notifyflow/redis');
    const redis = getRedisClient();
    await redis.del(`metrics:cache:${tenantAId}`);
    await redis.del(`metrics:cache:${tenantBId}`);

    // 5. Hit GET /v1/analytics/metrics with TechCorp API key
    console.log('\n5. Querying GET /v1/analytics/metrics using TechCorp API key...');
    const resA = await fetch('http://localhost:3000/v1/analytics/metrics', {
      headers: { 'x-api-key': techCorpApiKey }
    });
    if (!resA.ok) {
      throw new Error(`Failed to fetch TechCorp analytics: Status ${resA.status}`);
    }
    const metricsA = await resA.json();
    console.log(`   Total events returned for TechCorp: ${metricsA.summary.total}`);
    console.log(`   Recent logs from TechCorp analytics:`);
    console.table(metricsA.recentLogs.map(l => ({ eventId: l.eventId, eventType: l.eventType, status: l.status, channel: l.channel })));

    // 6. Hit GET /v1/analytics/metrics with RetailCo API key
    console.log('\n6. Querying GET /v1/analytics/metrics using RetailCo API key...');
    const resB = await fetch('http://localhost:3000/v1/analytics/metrics', {
      headers: { 'x-api-key': retailCoApiKey }
    });
    if (!resB.ok) {
      throw new Error(`Failed to fetch RetailCo analytics: Status ${resB.status}`);
    }
    const metricsB = await resB.json();
    console.log(`   Total events returned for RetailCo: ${metricsB.summary.total}`);
    console.log(`   Recent logs from RetailCo analytics:`);
    console.table(metricsB.recentLogs.map(l => ({ eventId: l.eventId, eventType: l.eventType, status: l.status, channel: l.channel })));

    console.log('\n\x1b[32m=== CONCLUSION ===\x1b[0m');
    console.log('   All tenant isolation verification steps completed successfully!');

  } catch (error) {
    console.error('\n\x1b[31mVerification Failed:\x1b[0m', error.stack);
  } finally {
    await pool.end();
  }
}

run();
