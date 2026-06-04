const { Pool } = require('pg');
const webpush = require('web-push');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
  const privateVapidKey = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@notifyflow.com';

  console.log('VAPID Configuration:');
  console.log('vapidSubject:', vapidSubject);
  console.log('publicVapidKey:', publicVapidKey ? `${publicVapidKey.substring(0, 10)}...` : 'not defined');
  console.log('privateVapidKey:', privateVapidKey ? `${privateVapidKey.substring(0, 10)}...` : 'not defined');

  if (!publicVapidKey || !privateVapidKey) {
    console.error('VAPID keys not configured in environment!');
    return;
  }

  webpush.setVapidDetails(vapidSubject, publicVapidKey, privateVapidKey);

  console.log('\nQuerying push token for user-cust-99...');
  const res = await dbPool.query('SELECT push_token FROM users WHERE id = $1', ['user-cust-99']);
  
  if (res.rows.length === 0 || !res.rows[0].push_token) {
    console.log('No push token found for user-cust-99 in database.');
    return;
  }

  const pushTokenRaw = res.rows[0].push_token;
  console.log('Push token from database:', pushTokenRaw);

  let subscription;
  try {
    subscription = typeof pushTokenRaw === 'string' ? JSON.parse(pushTokenRaw) : pushTokenRaw;
  } catch (e) {
    console.error('Failed to parse push token as JSON:', e.message);
    return;
  }

  console.log('\nSending test push notification...');
  const payloadString = JSON.stringify({
    title: 'Test Notification',
    body: 'Hello from diagnostics!'
  });

  try {
    const info = await webpush.sendNotification(subscription, payloadString);
    console.log('Push notification sent successfully!');
    console.log('Response Status Code:', info.statusCode);
    console.log('Response Headers:', info.headers);
    console.log('Response Body:', info.body);
  } catch (err) {
    console.error('\nWeb Push failed with error:');
    console.error('Message:', err.message);
    console.error('Status Code:', err.statusCode);
    console.error('Headers:', err.headers);
    console.error('Body:', err.body);
  } finally {
    await dbPool.end();
  }
}

run().catch(console.error);
