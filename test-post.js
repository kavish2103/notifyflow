const API_KEY = 'nf_key_70ac6777c160303a1c3375970e946662b4b07458531eb914';
const TENANT_ID = 'tenant-d74c9509-f66a-402f-89dd-add83b368e68';

async function runTest() {
  console.log('Sending test payment.failed event to API Gateway at http://localhost:3000/v1/events...');

  const payload = {
    // Generate a fresh unique clientEventId so that Redis deduplication doesn't block it
    clientEventId: `client-txn-${Date.now()}`,
    tenantId: TENANT_ID,
    userId: 'user-cust-99',
    eventType: 'payment.failed',
    payload: {
      amount: 49.99,
      currency: 'USD',
      reason: 'Insufficient funds',
      invoiceId: 'inv-88190'
    }
  };

  try {
    const response = await fetch('http://localhost:3000/v1/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    
    console.log('\n\x1b[32m=== GATEWAY RESPONSE ===\x1b[0m');
    console.log(`Status Code: ${response.status} ${response.statusText}`);
    console.log('Body Payload:', JSON.stringify(data, null, 2));

    // Print headers to show rate limiting in action!
    console.log('\n\x1b[33m=== RATE LIMIT HEADERS ===\x1b[0m');
    console.log(`X-RateLimit-Limit:     ${response.headers.get('x-ratelimit-limit')}`);
    console.log(`X-RateLimit-Remaining: ${response.headers.get('x-ratelimit-remaining')}`);
    console.log(`X-RateLimit-Reset:     ${response.headers.get('x-ratelimit-reset')}\n`);

  } catch (error) {
    console.error('\x1b[31mRequest failed:\x1b[0m', error.message);
  }
}

runTest();
