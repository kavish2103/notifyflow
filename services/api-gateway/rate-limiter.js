const { getRedisClient, KEYS } = require('@notifyflow/redis');
const { logger } = require('@notifyflow/logger');

/**
 * Express Middleware: Per-Tenant API Gateway Rate Limiting.
 * Protects NotifyFlow from traffic spikes or denial-of-service abuse.
 * Employs a Redis transaction block to ensure atomic increments and TTL safety.
 */
async function rateLimitTenant(req, res, next) {
  const tenant = req.tenant;
  if (!tenant) {
    // If request is not authenticated as a B2B tenant (e.g. public routes), bypass rate limits
    return next();
  }

  try {
    const tenantId = tenant.id;
    const limit = tenant.rate_limit_per_minute || 60; // Fallback to 60 req/min if limit is omitted

    // Calculate current fixed minute window index since epoch
    const currentMinute = Math.floor(Date.now() / 60000);
    const redisKey = KEYS.apiRateLimit(tenantId, currentMinute);

    const redisClient = getRedisClient();

    // Atomic transaction: locks both INCR and EXPIRE execution together
    const pipeline = redisClient.multi();
    pipeline.incr(redisKey);
    pipeline.expire(redisKey, 120); // 2-minute TTL ensures key cleaned up automatically

    const results = await pipeline.exec();

    // Pipeline results structure: [ [null, incrValue], [null, expireSuccess] ]
    const count = results[0][1];

    // Inject industry standard B2B rate limiting headers
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - count));
    // Unix epoch timestamp when the current minute window resets
    res.setHeader('X-RateLimit-Reset', (currentMinute + 1) * 60);

    // If quota exceeded, reject request immediately
    if (count > limit) {
      logger.warn('Tenant B2B rate limit quota exceeded at API Gateway', {
        tenantId,
        count,
        limit,
        currentMinute
      });
      return res.status(429).json({
        error: 'TooManyRequests',
        message: `API quota exceeded. Your tenant plan is limited to ${limit} requests per minute. Please upgrade your tier or back off and try again.`
      });
    }

    return next();

  } catch (error) {
    logger.error('API Gateway Rate Limiter middleware encountered a failure', {
      error: error.message,
      stack: error.stack
    });
    // FAIL-OPEN STRATEGY: Prioritize service availability.
    // If Redis suffers an outage, we bypass quota checks to avoid breaking B2B request deliveries.
    return next();
  }
}

module.exports = {
  rateLimitTenant
};
