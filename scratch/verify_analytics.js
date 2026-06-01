const API_KEY = 'nf_key_70ac6777c160303a1c3375970e946662b4b07458531eb914';

async function verify() {
  console.log('Fetching analytics metrics via Gateway...');
  try {
    const response = await fetch('http://localhost:3000/v1/analytics/metrics', {
      method: 'GET',
      headers: {
        'x-api-key': API_KEY
      }
    });

    const data = await response.json();
    console.log('\n\x1b[32m=== ANALYTICS RESPONSE ===\x1b[0m');
    console.log(`Status Code: ${response.status} ${response.statusText}`);
    console.log('Body Payload:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('\x1b[31mRequest failed:\x1b[0m', error.message);
  }
}

verify();
