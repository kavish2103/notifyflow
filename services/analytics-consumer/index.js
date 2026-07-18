const path = require('path');
// Load environment variables from central monorepo config
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Enforce service identity BEFORE loading the logger to label all logs correctly
process.env.SERVICE_NAME = 'analytics-consumer-service';

const { logger } = require('@notifyflow/logger');
const { getKafkaClient, TOPICS, CONSUMER_GROUPS } = require('@notifyflow/kafka');
const { getRedisClient } = require('@notifyflow/redis');
const express = require('express');
const cors = require('cors');

const { getDbPool } = require('./db');

const app = express();
const PORT = process.env.ANALYTICS_PORT || 3004;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', service: 'analytics-consumer-service', timestamp: new Date().toISOString() });
});

let dbPool = null;
let kafkaConsumer = null;
let server = null;

/**
 * ==============================================================================
 * ARCHITECTURAL TRADEOFF ANALYSIS (EXCELLENT FOR DISCUSSING IN INTERVIEWS)
 * ==============================================================================
 *
 * PATTERN ADOPTED: Read-Time Aggregation with Redis Cache-Aside
 * Under this pattern, PostgreSQL is treated as our durable single-source-of-truth.
 * Aggregations (counts, status distributions, timeline averages) are calculated
 * on-demand using SQL GROUP BY queries and cached in Redis with a 10-second TTL.
 *
 * PROS:
 * 1. High Data Consistency & Integrity: Relational PostgreSQL logs are perfectly durable.
 *    There is zero risk of Redis counters drifting or deviating from the source truth.
 * 2. Decoupled Workers: Completed workers (Email, SMS, Push) do not need to know about
 *    analytics Redis keys or schemas, preserving clean microservice boundaries.
 * 3. Low Redis Memory Footprint: Only active tenant metrics aggregates are cached with 10s TTL,
 *    avoiding perpetual memory usage for inactive users.
 * 4. High Read Performance: Subsequent dashboard requests resolve from memory in ~1ms.
 *
 * CONS:
 * 1. Initial Read Latency: On cache-misses, we must hit the database (indexed counts minimize this).
 * 2. CPU Overload under Massive Scales: If millions of events are logged, heavy SQL aggregates
 *    can degrade database performance (though read-replica or partitioning mitigates this).
 *
 * ------------------------------------------------------------------------------
 *
 * ALTERNATIVE PATTERN: Write-Time Aggregation (Real-Time Redis Counter Increments)
 * Under this model, each Worker microservice would atomically increment Redis metric
 * keys (using INCRBY or HINCRBY) in real-time as notifications are successfully sent or fail.
 *
 * PROS:
 * 1. Immediate Sub-millisecond Reads: Metrics are pre-compiled and read instantly from Redis memory.
 * 2. Zero Database aggregation overhead: PostgreSQL is never hit for metrics.
 *
 * CONS:
 * 1. High Coupling: Workers must import Redis clients and carry the explicit database analytics schema
 *    keyspace, making future metric additions require modifying worker source code.
 * 2. Data Loss & Key Drift: If Redis crashes, evicts keys under memory constraints, or fails
 *    a write, the analytics counters permanently drift from the Postgres truth, requiring
 *    complex periodic DB reconciliation batch scripts.
 */

/**
 * GET /v1/analytics/metrics
 * Returns real-time delivery stats and timeline trends for the caller's tenant.
 * Uses a Redis Cache-aside model to shield PostgreSQL from heavy aggregate query load.
 */
app.get('/v1/analytics/metrics', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  const correlationId = req.headers['x-correlation-id'] || 'req-unknown';

  if (!tenantId) {
    logger.warn('Metrics request rejected: Missing x-tenant-id header', { correlationId });
    return res.status(400).json({ error: 'BadRequestError', message: 'Missing x-tenant-id header' });
  }

  const cacheKey = `metrics:cache:${tenantId}`;

  // Redis is optional — gracefully degrade to direct DB query if unavailable
  let redis = null;
  try {
    if (process.env.REDIS_URL) {
      redis = getRedisClient();
    } else {
      logger.debug('REDIS_URL not set, skipping cache layer for this request.');
    }
  } catch (redisInitErr) {
    logger.warn('Redis client unavailable, skipping cache layer.', { error: redisInitErr.message });
  }

  try {
    // 1. Check Redis Cache (skip if Redis is unavailable)
    if (redis) {
      try {
        const cachedData = await redis.get(cacheKey);
        if (cachedData) {
          logger.debug('Analytics cache HIT. Returning cached payload.', { tenantId, cacheKey });
          return res.status(200).json(JSON.parse(cachedData));
        }
      } catch (cacheReadErr) {
        logger.warn('Redis cache read failed, falling back to database.', { error: cacheReadErr.message });
        redis = null; // disable further Redis use for this request
      }
    }

    logger.info('Analytics cache MISS. Executing database aggregates...', { tenantId, cacheKey });

    // 2. Fetch Aggregated Metrics from PostgreSQL
    // 2a. Total Status Counts grouped by Channel and Status
    const statusQuery = `
      SELECT channel, status, COUNT(*) as count
      FROM delivery_logs
      WHERE tenant_id = $1
      GROUP BY channel, status
    `;
    const statusResult = await dbPool.query(statusQuery, [tenantId]);

    // 2b. 7-Day History Timeline (Count successes & failures per day)
    const timelineQuery = `
      SELECT DATE_TRUNC('day', created_at) as date, status, COUNT(*) as count
      FROM delivery_logs
      WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE_TRUNC('day', created_at), status
      ORDER BY date ASC
    `;
    const timelineResult = await dbPool.query(timelineQuery, [tenantId]);

    // 2c. DLQ permanent failures count
    const dlqCountQuery = `
      SELECT COUNT(*) as count
      FROM dead_letter_events
      WHERE tenant_id = $1
    `;
    const dlqCountResult = await dbPool.query(dlqCountQuery, [tenantId]);

    // 2d. Recent Activity Log Feed (Last 10 entries)
    const recentLogsQuery = `
      SELECT event_id as "eventId", channel, event_type as "eventType", status, error_message as "errorMessage", created_at as "createdAt"
      FROM delivery_logs
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT 10
    `;
    const recentLogsResult = await dbPool.query(recentLogsQuery, [tenantId]);

    // 3. Compile the Response Payload
    const summary = {
      total: 0,
      delivered: 0,
      failed: 0,
      skipped: 0
    };

    const channelStats = {
      email: { total: 0, delivered: 0, failed: 0, skipped: 0 },
      sms: { total: 0, delivered: 0, failed: 0, skipped: 0 },
      push: { total: 0, delivered: 0, failed: 0, skipped: 0 }
    };

    statusResult.rows.forEach(row => {
      const count = parseInt(row.count, 10);
      summary.total += count;
      if (summary[row.status] !== undefined) {
        summary[row.status] += count;
      }

      if (channelStats[row.channel]) {
        channelStats[row.channel].total += count;
        if (channelStats[row.channel][row.status] !== undefined) {
          channelStats[row.channel][row.status] += count;
        }
      }
    });

    const timelineData = {};
    timelineResult.rows.forEach(row => {
      const dateStr = new Date(row.date).toISOString().split('T')[0];
      if (!timelineData[dateStr]) {
        timelineData[dateStr] = { date: dateStr, delivered: 0, failed: 0 };
      }
      const count = parseInt(row.count, 10);
      if (row.status === 'delivered') {
        timelineData[dateStr].delivered += count;
      } else if (row.status === 'failed') {
        timelineData[dateStr].failed += count;
      }
    });

    const metricsPayload = {
      tenantId,
      summary: {
        ...summary,
        dlqDepth: parseInt(dlqCountResult.rows[0].count, 10)
      },
      channelStats,
      timeline: Object.values(timelineData),
      recentLogs: recentLogsResult.rows,
      cachedAt: new Date().toISOString()
    };

    // 4. Save to Redis Cache (Cache TTL = 10 seconds) — only if Redis is available
    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(metricsPayload), 'EX', 10);
        logger.info('Aggregated analytics saved in Redis cache successfully.', { tenantId, cacheKey });
      } catch (cacheWriteErr) {
        logger.warn('Redis cache write failed, continuing without caching.', { error: cacheWriteErr.message });
      }
    }

    res.status(200).json(metricsPayload);

  } catch (err) {
    logger.error('Failed to compile tenant metrics payload from PostgreSQL', {
      error: err.message,
      tenantId,
      correlationId
    });
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to compile metrics.' });
  }
});

/**
 * Asynchronous boot sequence for the Analytics microservice.
 * Establishes DB client connection, Redis connector, and Kafka DLQ stream listeners.
 */
async function bootstrap() {
  try {
    logger.info('Starting Analytics Service boot sequence...');

    // 1. PostgreSQL pool connection verification
    dbPool = getDbPool();
    const dbTimeResult = await dbPool.query('SELECT NOW()');
    logger.info('PostgreSQL connection verified successfully.', {
      dbServerTime: dbTimeResult.rows[0].now
    });

    // 2. Redis connector pool verification (optional — degrades gracefully if unavailable)
    try {
      if (!process.env.REDIS_URL) {
        logger.warn('REDIS_URL not set. Analytics cache layer will be disabled (Postgres-only mode).');
      } else {
        const redis = getRedisClient();
        await redis.ping();
        logger.info('Redis connection verified successfully.');
      }
    } catch (redisErr) {
      logger.warn('Redis connection unavailable. Analytics cache layer will be disabled.', {
        error: redisErr.message
      });
    }

    // 3. Kafka client initialization and subscription setup
    try {
      const kafka = getKafkaClient();

      // 4. Initialize Kafka DLQ Monitor Consumer Group
      kafkaConsumer = kafka.consumer({
        groupId: CONSUMER_GROUPS.DLQ_MONITOR
      });

      logger.info('Connecting DLQ Monitor Kafka consumer...');
      await kafkaConsumer.connect();
      logger.info('Kafka consumer connected successfully.');

      logger.info(`Subscribing to DLQ stream topic: ${TOPICS.DLQ}...`);
      await kafkaConsumer.subscribe({
        topic: TOPICS.DLQ,
        fromBeginning: false
      });

      // 5. Start consuming DLQ metrics in real-time
      logger.info('DLQ Monitor is listening and active.');
      await kafkaConsumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          logger.info('DLQ stream intercept. Incrementing global DLQ depth in Redis...');
          try {
            const depthKey = 'dlq:depth';
            await redis.incr(depthKey);
            logger.info('Successfully incremented Redis dlq:depth counter', { key: depthKey });
          } catch (redisErr) {
            logger.error('Failed to update real-time Redis DLQ depth counter', { error: redisErr.message });
          }
        }
      });
    } catch (kafkaError) {
      logger.warn('Failed to initialize Kafka DLQ consumer. DLQ monitoring will be disabled.', {
        error: kafkaError.message
      });
    }

    // 6. Start Express HTTP Server
    server = app.listen(PORT, () => {
      logger.info('Analytics REST API Server successfully listening', { port: PORT });
    });

  } catch (error) {
    logger.error('Critical boot sequence failure for Analytics Consumer. Terminating.', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

/**
 * Graceful termination handler to close connections cleanly.
 */
const shutdown = async (signal) => {
  logger.info(`Received ${signal}. Launching Analytics Service graceful termination...`);

  if (server) {
    logger.info('Closing Express server socket...');
    await new Promise((resolve) => server.close(resolve));
    logger.info('Express server socket closed.');
  }

  if (kafkaConsumer) {
    logger.info('Closing Kafka consumer stream...');
    try {
      await kafkaConsumer.disconnect();
      logger.info('Kafka consumer disconnected cleanly.');
    } catch (err) {
      logger.error('Error disconnecting Kafka consumer during shutdown', {
        error: err.message
      });
    }
  }

  try {
    const redis = getRedisClient();
    if (redis) {
      logger.info('Closing Redis connection socket...');
      await redis.quit();
      logger.info('Redis connection socket closed.');
    }
  } catch (err) {
    logger.error('Error closing Redis connection socket during shutdown', { error: err.message });
  }

  try {
    if (dbPool) {
      logger.info('Closing PostgreSQL connection pool...');
      await dbPool.end();
      logger.info('PostgreSQL connection pool closed cleanly.');
    }
  } catch (err) {
    logger.error('Error closing PostgreSQL pool during shutdown', { error: err.message });
  }

  logger.info('Graceful shutdown completed. Process exiting.');
  process.exit(0);
};

// Bind standard OS termination signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

bootstrap();
