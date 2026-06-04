const http = require('http');

const API_KEY = 'nf_key_70ac6777c160303a1c3375970e946662b4b07458531eb914';
const GATEWAY_URL = 'http://localhost:3000';

function makeRequest(path, method, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers: {
        'x-api-key': API_KEY,
      }
    };

    let dataString = '';
    if (body) {
      dataString = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(dataString);
    }

    const req = http.request(`${GATEWAY_URL}${path}`, options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: responseBody ? JSON.parse(responseBody) : null
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            body: responseBody
          });
        }
      });
    });

    req.on('error', (err) => reject(err));
    if (body) {
      req.write(dataString);
    }
    req.end();
  });
}

async function run() {
  console.log('--- 1. Get Initial Event Catalog ---');
  let getRes = await makeRequest('/v1/event-types', 'GET');
  console.log(`Status: ${getRes.statusCode}`, JSON.stringify(getRes.body, null, 2));

  console.log('\n--- 2. Create Event Type with Email and SMS Templates ---');
  const payload = {
    eventType: 'order.preparing',
    description: 'Triggered when the chef starts preparing the order.',
    templates: {
      email: {
        subject: 'Preparing your meal!',
        body: 'Hi {{name}}, your order of {{amount}} is now being prepared.'
      },
      sms: {
        body: 'Chef is preparing your meal! {{amount}}.'
      }
    }
  };
  let postRes = await makeRequest('/v1/event-types', 'POST', payload);
  console.log(`Status: ${postRes.statusCode}`, JSON.stringify(postRes.body, null, 2));

  console.log('\n--- 3. Get Event Catalog (Verify new item and templates) ---');
  getRes = await makeRequest('/v1/event-types', 'GET');
  console.log(`Status: ${getRes.statusCode}`, JSON.stringify(getRes.body, null, 2));

  console.log('\n--- 4. Delete the order.preparing Event Type ---');
  let deleteRes = await makeRequest('/v1/event-types/order.preparing', 'DELETE');
  console.log(`Status: ${deleteRes.statusCode}`, JSON.stringify(deleteRes.body, null, 2));

  console.log('\n--- 5. Get Event Catalog (Verify deletion) ---');
  getRes = await makeRequest('/v1/event-types', 'GET');
  console.log(`Status: ${getRes.statusCode}`, JSON.stringify(getRes.body, null, 2));
}

// Wait 3 seconds for gateway to boot before executing
setTimeout(() => {
  run().catch(console.error);
}, 3000);
