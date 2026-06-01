const { getRedisClient } = require('../shared/redis');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function run() {
  const redis = getRedisClient();
  try {
    await redis.flushall();
    console.log('Redis cache successfully flushed! All cache keys evicted.');
  } catch (err) {
    console.error(err);
  } finally {
    await redis.quit();
  }
}

run();
