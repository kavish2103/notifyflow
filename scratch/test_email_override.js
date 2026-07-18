require('dotenv').config();

// Test email override: userId does NOT exist in DB, but payload.email is set
// The email-worker should use payload.email as fallback and deliver successfully
async function test() {
  const res = await fetch('http://localhost:3000/v1/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'nf_key_05073d65cbe342cfd37d01c98167dfe113ddcf8e44ce5691'
    },
    body: JSON.stringify({
      clientEventId: `recruiter-test-${Date.now()}`,
      tenantId: 'tenant-d74c9509-f66a-402f-89dd-add83b368e68',
      userId: 'user-recruiter-demo-99', // does NOT exist in DB
      eventType: 'order delivered',
      payload: {
        name: 'Recruiter',
        email: 'kvsinghal2103@gmail.com'  // override — worker uses this as fallback
      }
    })
  });
  const data = await res.json();
  console.log('Event ID:', data.eventId);
  console.log('Status:', data.status);
}
test().catch(console.error);
