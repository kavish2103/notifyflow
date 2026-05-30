const Redis = require('ioredis');
const { logger } = require('@notifyflow/logger');

let redisClientInstance = null;

/**
 * Returns the configured Redis client instance (Singleton).
 * Manages the connection lifecycle and connects error handling to our Winston logger.
 */
function getRedisClient() {
  if (redisClientInstance) {
    return redisClientInstance;
  }

  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error('REDIS_URL environment variable is not defined.');
  }

  logger.info('Initializing Redis client connection...');

  // Configure ioredis with connection fallback strategies
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      // Exponential backoff with a max retry window of 2 seconds
      const delay = Math.min(times * 50, 2000);
      return delay;
    }
  });

  client.on('connect', () => {
    logger.info('Redis client connected successfully');
  });

  client.on('error', (err) => {
    logger.error('Redis client error occurred', {
      error: err.message,
      stack: err.stack
    });
  });

  redisClientInstance = client;
  return redisClientInstance;
}

/**
 * Strict key-space generators for Redis namespaces.
 * Having these in a single location guarantees all services read and write to the same key formats,
 * eliminating key mismatch bugs entirely.
 */
const KEYS = {
  /**
   * Idempotency verification key for worker delivery.
   * Format: idem:{channel}:{eventId}
   */
  idempotency: (channel, eventId) => `idem:${channel}:${eventId}`,

  /**
   * User rate limiting per channel.
   * Format: rl:{tenantId}:{userId}:{channel}:{min}
   */
  rateLimit: (tenantId, userId, channel, min) => `rl:${tenantId}:${userId}:${channel}:${min}`,

  /**
   * User preference cached record.
   * Format: pref:{userId}
   */
  preference: (userId) => `pref:${userId}`,

  /**
   * Render template cached record.
   * Format: tmpl:{tenantId}:{eventType}:{channel}
   */
  template: (tenantId, eventType, channel) => `tmpl:${tenantId}:${eventType}:${channel}`,

  /**
   * Tenant api key/limit cached record.
   * Format: tenant:{tenantId}
   */
  tenant: (tenantId) => `tenant:${tenantId}`,

  /**
   * Gateway API request rate limiter.
   * Format: apirl:{tenantId}:{min}
   */
  apiRateLimit: (tenantId, min) => `apirl:${tenantId}:${min}`,

  /**
   * Analytics: Total events count for a tenant.
   * Format: metrics:total_events:{tenantId}:{date}
   */
  metricsTotalEvents: (tenantId, date) => `metrics:total_events:${tenantId}:${date}`,

  /**
   * Analytics: Successfully delivered events per channel for a tenant.
   * Format: metrics:delivered:{channel}:{tenantId}:{date}
   */
  metricsDelivered: (channel, tenantId, date) => `metrics:delivered:${channel}:${tenantId}:${date}`,

  /**
   * Analytics: Failed events per channel for a tenant.
   * Format: metrics:failed:{channel}:{tenantId}:{date}
   */
  metricsFailed: (channel, tenantId, date) => `metrics:failed:${channel}:${tenantId}:${date}`,

  /**
   * Realtime dashboard tracking: depth of DLQ.
   * Format: dlq:depth
   */
  dlqDepth: () => 'dlq:depth',

  /**
   * Ingestion-level request deduplication key.
   * Format: ingest:{clientEventId}
   */
  ingestDedup: (clientEventId) => `ingest:${clientEventId}`
};

module.exports = {
  getRedisClient,
  KEYS
};
