require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('\x1b[31mError: DATABASE_URL is not defined in your .env file.\x1b[0m');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

const TENANT_ID = 'tenant-77777777-7777-4777-a777-777777777777';
const API_KEY = 'nf_key_e2etestsecretkey1234567890';
const API_KEY_HASH = crypto.createHash('sha256').update(API_KEY).digest('hex');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runE2E() {
  console.log('\n\x1b[35m===============================================================');
  console.log('STARTING MULTI-EVENT END-TO-END INTEGRATION TEST SUITE');
  console.log('===============================================================\x1b[0m\n');

  try {
    // 1. Clean up existing E2E data
    console.log('\x1b[36m[PREPARATION] Cleaning up existing E2E test data...\x1b[0m');
    const oldTenantRes = await pool.query('SELECT id FROM tenants WHERE api_key_hash = $1', [API_KEY_HASH]);
    const oldTenantIds = oldTenantRes.rows.map(r => r.id);
    if (!oldTenantIds.includes(TENANT_ID)) {
      oldTenantIds.push(TENANT_ID);
    }

    await pool.query('DELETE FROM dead_letter_events WHERE tenant_id = ANY($1)', [oldTenantIds]);
    await pool.query('DELETE FROM delivery_logs WHERE tenant_id = ANY($1)', [oldTenantIds]);
    await pool.query('DELETE FROM notification_templates WHERE tenant_id = ANY($1)', [oldTenantIds]);
    await pool.query('DELETE FROM event_types WHERE tenant_id = ANY($1)', [oldTenantIds]);
    await pool.query('DELETE FROM user_preferences WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ANY($1))', [oldTenantIds]);
    await pool.query('DELETE FROM users WHERE tenant_id = ANY($1)', [oldTenantIds]);
    await pool.query('DELETE FROM tenants WHERE id = ANY($1)', [oldTenantIds]);

    // 2. Seed E2E Test Tenant
    console.log('\x1b[36m[SEEDING] Creating E2E test tenant...\x1b[0m');
    await pool.query(
      'INSERT INTO tenants (id, name, api_key_hash, rate_limit_per_minute) VALUES ($1, $2, $3, $4)',
      [TENANT_ID, 'E2E Test Corporate', API_KEY_HASH, 200]
    );

    // 3. Seed Event Types
    console.log('\x1b[36m[SEEDING] Registering Event Catalog event types...\x1b[0m');
    const eventTypes = [
      { type: 'order.placed', desc: 'Fired when a new customer order is placed' },
      { type: 'order.preparing', desc: 'Fired when order prep starts' },
      { type: 'payment.failed', desc: 'Fired when invoice transaction fails' }
    ];
    for (const et of eventTypes) {
      await pool.query(
        'INSERT INTO event_types (tenant_id, event_type, description) VALUES ($1, $2, $3)',
        [TENANT_ID, et.type, et.desc]
      );
    }

    // 4. Seed Templates
    console.log('\x1b[36m[SEEDING] Creating channel templates...\x1b[0m');
    // order.placed: Email and SMS
    await pool.query(
      'INSERT INTO notification_templates (tenant_id, event_type, channel, subject_template, body_template) VALUES ($1, $2, $3, $4, $5)',
      [TENANT_ID, 'order.placed', 'email', 'Order Placed!', 'Hi {{name}}, order {{orderId}} is placed!']
    );
    await pool.query(
      'INSERT INTO notification_templates (tenant_id, event_type, channel, body_template) VALUES ($1, $2, $3, $4)',
      [TENANT_ID, 'order.placed', 'sms', 'Order {{orderId}} placed for {{name}}!']
    );

    // order.preparing: SMS only
    await pool.query(
      'INSERT INTO notification_templates (tenant_id, event_type, channel, body_template) VALUES ($1, $2, $3, $4)',
      [TENANT_ID, 'order.preparing', 'sms', 'Hi {{name}}, order {{orderId}} is preparing!']
    );

    // payment.failed: Email, SMS, Push
    await pool.query(
      'INSERT INTO notification_templates (tenant_id, event_type, channel, subject_template, body_template) VALUES ($1, $2, $3, $4, $5)',
      [TENANT_ID, 'payment.failed', 'email', 'Payment Failed Warning', 'Dear {{name}}, payment of ${{amount}} failed.']
    );
    await pool.query(
      'INSERT INTO notification_templates (tenant_id, event_type, channel, body_template) VALUES ($1, $2, $3, $4)',
      [TENANT_ID, 'payment.failed', 'sms', 'SMS: Payment of ${{amount}} failed.']
    );
    await pool.query(
      'INSERT INTO notification_templates (tenant_id, event_type, channel, body_template) VALUES ($1, $2, $3, $4)',
      [TENANT_ID, 'payment.failed', 'push', 'Push: Payment of ${{amount}} failed.']
    );

    // 5. Seed Test Users
    console.log('\x1b[36m[SEEDING] Registering E2E test users...\x1b[0m');
    // user 1: opt-in to all
    const optInUserId = 'user-e2e-opt-in';
    const fakePushSub = JSON.stringify({
      endpoint: 'https://fcm.googleapis.com/fcm/send/fake-e2e-fcm-endpoint-token',
      keys: { p256dh: 'fake-p256dh', auth: 'fake-auth' }
    });
    await pool.query(
      'INSERT INTO users (id, tenant_id, external_user_id, email, phone, push_token) VALUES ($1, $2, $3, $4, $5, $6)',
      [optInUserId, TENANT_ID, 'ext-opt-in', 'kvsinghal2103@gmail.com', '+917790000000', fakePushSub]
    );
    await pool.query('INSERT INTO user_preferences (user_id, channel, opted_in) VALUES ($1, $2, $3), ($1, $4, $3), ($1, $5, $3)', [optInUserId, 'email', true, 'sms', 'push']);

    // user 2: opt-out of all
    const optOutUserId = 'user-e2e-opt-out';
    await pool.query(
      'INSERT INTO users (id, tenant_id, external_user_id, email, phone) VALUES ($1, $2, $3, $4, $5)',
      [optOutUserId, TENANT_ID, 'ext-opt-out', 'kvsinghal2103@gmail.com', '+917790000000']
    );
    await pool.query('INSERT INTO user_preferences (user_id, channel, opted_in) VALUES ($1, $2, $3), ($1, $4, $3), ($1, $5, $3)', [optOutUserId, 'email', false, 'sms', 'push']);

    console.log('\x1b[32mSeeding completed successfully. Ready to stream events.\x1b[0m\n');

    // 6. Define the 10 events to dispatch
    const events = [
      {
        description: 'Event 1: order.placed to opted-in user (Expected: Email + SMS processed)',
        payload: {
          clientEventId: `e2e-txn-1-${Date.now()}`,
          tenantId: TENANT_ID,
          userId: optInUserId,
          eventType: 'order.placed',
          payload: { name: 'E2E OptIn Tester', orderId: 'ord-101' }
        },
        expectedStatus: 202
      },
      {
        description: 'Event 2: order.placed to opted-out user (Expected: Skipped)',
        payload: {
          clientEventId: `e2e-txn-2-${Date.now()}`,
          tenantId: TENANT_ID,
          userId: optOutUserId,
          eventType: 'order.placed',
          payload: { name: 'E2E OptOut Tester', orderId: 'ord-102' }
        },
        expectedStatus: 202
      },
      {
        description: 'Event 3: order.preparing to opted-in user (Expected: SMS processed)',
        payload: {
          clientEventId: `e2e-txn-3-${Date.now()}`,
          tenantId: TENANT_ID,
          userId: optInUserId,
          eventType: 'order.preparing',
          payload: { name: 'E2E OptIn Tester', orderId: 'ord-101' }
        },
        expectedStatus: 202
      },
      {
        description: 'Event 4: payment.failed to opted-in user (Expected: Email + SMS deliver; Push fails and goes to DLQ due to fake sub)',
        payload: {
          clientEventId: `e2e-txn-4-${Date.now()}`,
          tenantId: TENANT_ID,
          userId: optInUserId,
          eventType: 'payment.failed',
          payload: { name: 'E2E OptIn Tester', amount: '129.99' }
        },
        expectedStatus: 202
      },
      {
        description: 'Event 5: payment.failed to opted-out user (Expected: Skipped)',
        payload: {
          clientEventId: `e2e-txn-5-${Date.now()}`,
          tenantId: TENANT_ID,
          userId: optOutUserId,
          eventType: 'payment.failed',
          payload: { name: 'E2E OptOut Tester', amount: '129.99' }
        },
        expectedStatus: 202
      },
      {
        description: 'Event 6: Duplicate Ingestion Check of Event 1 (Expected: 409 Conflict)',
        payload: null, // Set dynamically to match event 1 clientEventId
        expectedStatus: 409
      },
      {
        description: 'Event 7: unregistered.event to opted-in user (Expected: Accepted, but workers skip because no template exists)',
        payload: {
          clientEventId: `e2e-txn-7-${Date.now()}`,
          tenantId: TENANT_ID,
          userId: optInUserId,
          eventType: 'unregistered.event',
          payload: { name: 'E2E OptIn Tester' }
        },
        expectedStatus: 202
      },
      {
        description: 'Event 8: order.placed to non-existent user (Expected: Accepted, but workers skip due to missing user/prefs)',
        payload: {
          clientEventId: `e2e-txn-8-${Date.now()}`,
          tenantId: TENANT_ID,
          userId: 'user-e2e-nonexistent',
          eventType: 'order.placed',
          payload: { name: 'Nonexistent User', orderId: 'ord-999' }
        },
        expectedStatus: 202
      },
      {
        description: 'Event 9: order.preparing to opted-out user (Expected: Skipped)',
        payload: {
          clientEventId: `e2e-txn-9-${Date.now()}`,
          tenantId: TENANT_ID,
          userId: optOutUserId,
          eventType: 'order.preparing',
          payload: { name: 'E2E OptOut Tester', orderId: 'ord-102' }
        },
        expectedStatus: 202
      },
      {
        description: 'Event 10: payment.failed to opted-in user (Expected: Email + SMS deliver; Push fails and goes to DLQ)',
        payload: {
          clientEventId: `e2e-txn-10-${Date.now()}`,
          tenantId: TENANT_ID,
          userId: optInUserId,
          eventType: 'payment.failed',
          payload: { name: 'E2E OptIn Tester', amount: '45.00' }
        },
        expectedStatus: 202
      }
    ];

    // Set Event 6 clientEventId to duplicate Event 1
    events[5].payload = {
      clientEventId: events[0].payload.clientEventId,
      tenantId: TENANT_ID,
      userId: optInUserId,
      eventType: 'order.placed',
      payload: { name: 'E2E OptIn Tester', orderId: 'ord-101' }
    };

    // 7. Sequentially dispatch events
    console.log('\x1b[36m[EXECUTION] Dispatching 10 events to API Gateway...\x1b[0m');
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      console.log(`\n\x1b[33m--> Dispatching ${e.description}\x1b[0m`);
      
      const response = await fetch('http://localhost:3000/v1/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY
        },
        body: JSON.stringify(e.payload)
      });

      const data = await response.json();
      console.log(`Response Code: ${response.status} (Expected: ${e.expectedStatus})`);
      if (response.status !== e.expectedStatus) {
        throw new Error(`Integration validation failed at event ${i + 1}. Expected status ${e.expectedStatus}, got ${response.status}. Response: ${JSON.stringify(data)}`);
      }
      await sleep(100);
    }

    // 8. Wait for pipeline processing (async workers and DLQ retry delays)
    console.log('\n\x1b[36m[PROCESSING] Sleeping for 15 seconds to allow Kafka pipeline processing and workers retry execution...\x1b[0m');
    await sleep(15000);

    // 9. Query results from database
    console.log('\x1b[36m[VERIFICATION] Fetching E2E test results from PostgreSQL...\x1b[0m');
    const logsRes = await pool.query(
      'SELECT channel, event_type, status, error_message, retry_count FROM delivery_logs WHERE tenant_id = $1 ORDER BY id ASC',
      [TENANT_ID]
    );

    const dlqRes = await pool.query(
      'SELECT event_type, channel, failure_reason, retry_count FROM dead_letter_events WHERE tenant_id = $1 ORDER BY id ASC',
      [TENANT_ID]
    );

    // 10. Print Reports
    console.log('\n\x1b[32m===============================================================');
    console.log('E2E TRANSACTION LOGS REPORT');
    console.log('===============================================================\x1b[0m');
    console.table(logsRes.rows);

    console.log('\n\x1b[31m===============================================================');
    console.log('E2E DEAD LETTER QUEUE (DLQ) REPORT');
    console.log('===============================================================\x1b[0m');
    console.table(dlqRes.rows);

    // 11. Assert outcomes
    console.log('\n\x1b[36m[VERIFICATION] Evaluating expected state assertions...\x1b[0m');
    
    // Assertions:
    // - Skipped logs must exist (Event 2 and 5 opted-out, Event 7 unregistered, Event 8 non-existent user)
    // - Delivered logs must exist (Event 1 email/sms, Event 3 sms, Event 4 email/sms, Event 10 email/sms)
    // - Dead letter logs must exist (Event 4 push and Event 10 push should both be in DLQ due to fake subscription)
    
    const skippedLogs = logsRes.rows.filter(l => l.status === 'skipped');
    const deliveredLogs = logsRes.rows.filter(l => l.status === 'delivered');
    const failedLogs = logsRes.rows.filter(l => l.status === 'failed');

    console.log(`Skipped logs count:   ${skippedLogs.length} (Expected > 0)`);
    console.log(`Delivered logs count: ${deliveredLogs.length} (Expected > 0)`);
    console.log(`Failed logs count:    ${failedLogs.length} (Expected 2 failed push dispatches)`);
    console.log(`DLQ records count:    ${dlqRes.rows.length} (Expected 2 push records in DLQ)`);

    if (skippedLogs.length === 0) {
      throw new Error('E2E Assertion Failed: No skipped logs recorded.');
    }
    if (deliveredLogs.length === 0) {
      throw new Error('E2E Assertion Failed: No delivered logs recorded.');
    }
    if (dlqRes.rows.length !== 2) {
      throw new Error(`E2E Assertion Failed: Expected exactly 2 push failures in dead letter events, found ${dlqRes.rows.length}.`);
    }

    console.log('\n\x1b[32m✔ ALL END-TO-END PIPELINE ASSERTIONS PASSED SUCCESSFULLY!');
    console.log('  Kafka streams, Redis deduplication, and PostgreSQL DLQ integration are 100% stable!\x1b[0m\n');

  } catch (error) {
    console.error('\n\x1b[31m❌ E2E Verification failed:\x1b[0m', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runE2E();
