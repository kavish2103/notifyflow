const { getRedisClient } = require('../shared/redis');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function run() {
  const redis = getRedisClient();
  const eventId = 'evt-5d759d12-edb7-4c23-b94e-2d33b133d96b';
  
  try {
    const emailKey = `idem:email:${eventId}`;
    const smsKey = `idem:sms:${eventId}`;
    const pushKey = `idem:push:${eventId}`;

    const emailVal = await redis.get(emailKey);
    const smsVal = await redis.get(smsKey);
    const pushVal = await redis.get(pushKey);

    console.log('\n\x1b[32m=== REDIS IDEMPOTENCY KEYS ===\x1b[0m');
    console.log(`${emailKey}: ${emailVal ? 'EXISTS (value: ' + emailVal + ')' : 'MISSING'}`);
    console.log(`${smsKey}: ${smsVal ? 'EXISTS (value: ' + smsVal + ')' : 'MISSING'}`);
    console.log(`${pushKey}: ${pushVal ? 'EXISTS (value: ' + pushVal + ')' : 'MISSING'}`);
  } catch (err) {
    console.error(err);
  } finally {
    await redis.quit();
  }
}

run();
