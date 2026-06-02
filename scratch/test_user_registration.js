async function test() {
  const apiKey = 'nf_key_70ac6777c160303a1c3375970e946662b4b07458531eb914';
  const body = {
    externalUserId: `ext-user-${Date.now()}`,
    email: 'kavish@example.com',
    phone: '+1555019999'
  };

  console.log('Sending user registration request to API Gateway on port 3000...');
  try {
    const res = await fetch('http://localhost:3000/v1/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: JSON.stringify(body)
    });
    
    console.log(`Status Code: ${res.status}`);
    const data = await res.json();
    console.log('Response Payload:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Registration request failed:', err.message);
  }
}

test();
