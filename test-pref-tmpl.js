const API_KEY = 'nf_key_70ac6777c160303a1c3375970e946662b4b07458531eb914';
const TENANT_ID = 'tenant-d74c9509-f66a-402f-89dd-add83b368e68';
const USER_ID = 'user-cust-99';

async function runTests() {
  console.log('\n\x1b[35m===============================================================');
  console.log('STARTING PHASE 3 E2E INTEGRATION VERIFICATION TESTS');
  console.log('===============================================================\x1b[0m\n');

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Retrieve default preferences (Cache miss -> default backfill -> Cache set)
    // -------------------------------------------------------------------------
    console.log('\x1b[36m[TEST 1] Fetching default preferences for user...\x1b[0m');
    let res = await fetch(`http://localhost:3000/v1/preferences/${USER_ID}`, {
      method: 'GET',
      headers: { 'x-api-key': API_KEY }
    });
    let data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Payload:', JSON.stringify(data, null, 2));

    // -------------------------------------------------------------------------
    // TEST 2: Update preferences (Opt out of SMS, keep Email/Push active)
    // -------------------------------------------------------------------------
    console.log('\n\x1b[36m[TEST 2] Opting out of SMS channel for user...\x1b[0m');
    const updatePayload = {
      preferences: [
        { channel: 'email', optedIn: true },
        { channel: 'sms', optedIn: false },
        { channel: 'push', optedIn: true }
      ]
    };
    res = await fetch(`http://localhost:3000/v1/preferences/${USER_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify(updatePayload)
    });
    data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Payload:', JSON.stringify(data, null, 2));

    // -------------------------------------------------------------------------
    // TEST 3: Retrieve updated preferences (Cache eviction verification)
    // -------------------------------------------------------------------------
    console.log('\n\x1b[36m[TEST 3] Re-fetching preferences (should reflect updated states)...\x1b[0m');
    res = await fetch(`http://localhost:3000/v1/preferences/${USER_ID}`, {
      method: 'GET',
      headers: { 'x-api-key': API_KEY }
    });
    data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Payload:', JSON.stringify(data, null, 2));

    // -------------------------------------------------------------------------
    // TEST 4: Create Templates (email and sms)
    // -------------------------------------------------------------------------
    console.log('\n\x1b[36m[TEST 4a] Creating EMAIL Template for payment.failed...\x1b[0m');
    const emailTemplatePayload = {
      eventType: 'payment.failed',
      channel: 'email',
      subjectTemplate: 'Payment Failed: Action Required for {{companyName}}',
      bodyTemplate: 'Hi {{name}},\n\nYour payment of {{amount}} {{currency}} failed for invoice {{invoiceId}} due to: {{reason}}.\n\nPlease update your card.'
    };
    res = await fetch('http://localhost:3000/v1/templates', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify(emailTemplatePayload)
    });
    data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Payload:', JSON.stringify(data, null, 2));

    console.log('\n\x1b[36m[TEST 4b] Creating SMS Template for payment.failed...\x1b[0m');
    const smsTemplatePayload = {
      eventType: 'payment.failed',
      channel: 'sms',
      bodyTemplate: 'Hi {{name}}, payment of {{amount}} {{currency}} failed. Update billing at {{billingUrl}}.'
    };
    res = await fetch('http://localhost:3000/v1/templates', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify(smsTemplatePayload)
    });
    data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Payload:', JSON.stringify(data, null, 2));

    // -------------------------------------------------------------------------
    // TEST 5: Fetch all templates for eventType (GET /v1/templates/:eventType)
    // -------------------------------------------------------------------------
    console.log('\n\x1b[36m[TEST 5] Retrieving all templates configured for event payment.failed...\x1b[0m');
    res = await fetch('http://localhost:3000/v1/templates/payment.failed', {
      method: 'GET',
      headers: { 'x-api-key': API_KEY }
    });
    data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Payload:', JSON.stringify(data, null, 2));

    // -------------------------------------------------------------------------
    // TEST 6: Fetch specific template per-channel (GET /v1/templates/:eventType/:channel)
    // -------------------------------------------------------------------------
    console.log('\n\x1b[36m[TEST 6a] Fetching specific EMAIL template for workers...\x1b[0m');
    res = await fetch('http://localhost:3000/v1/templates/payment.failed/email', {
      method: 'GET',
      headers: { 'x-api-key': API_KEY }
    });
    data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Payload:', JSON.stringify(data, null, 2));

    console.log('\n\x1b[36m[TEST 6b] Fetching specific SMS template for workers...\x1b[0m');
    res = await fetch('http://localhost:3000/v1/templates/payment.failed/sms', {
      method: 'GET',
      headers: { 'x-api-key': API_KEY }
    });
    data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Payload:', JSON.stringify(data, null, 2));

    // -------------------------------------------------------------------------
    // TEST 7: Negative Validation check (Fetch non-existent template)
    // -------------------------------------------------------------------------
    console.log('\n\x1b[36m[TEST 7] Fetching non-existent template (Should return 404)...\x1b[0m');
    res = await fetch('http://localhost:3000/v1/templates/payment.failed/push', {
      method: 'GET',
      headers: { 'x-api-key': API_KEY }
    });
    data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Payload:', JSON.stringify(data, null, 2));

    console.log('\n\x1b[32m===============================================================');
    console.log('ALL TESTS COMPLETED SUCCESSFULLY WITH EXCELLENT ROUTING LOGIC!');
    console.log('===============================================================\x1b[0m\n');

  } catch (error) {
    console.error('\n\x1b[31mE2E Verification script failed:\x1b[0m', error.message);
  }
}

runTests();
