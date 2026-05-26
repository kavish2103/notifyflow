const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getDbPool } = require('./db');
const { getRedisClient } = require('@notifyflow/redis');
const { logger } = require('@notifyflow/logger');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is not defined.');
}

/**
 * 1. B2B Tenant API Key Authentication Middleware
 * 
 * Intercepts requests destined for B2B channels. Validates API keys sent via 
 * 'x-api-key' or 'Authorization: ApiKey <key>' against PostgreSQL secure hashes.
 * Employs a Cache-Aside pattern via Redis to eliminate PostgreSQL query latency.
 */
async function authenticateTenant(req, res, next) {
  try {
    // 1. Extract API Key from standard locations
    let apiKey = req.headers['x-api-key'];
    const authHeader = req.headers['authorization'];

    if (!apiKey && authHeader && authHeader.startsWith('ApiKey ')) {
      apiKey = authHeader.substring(7).trim();
    }

    if (!apiKey) {
      logger.warn('Authentication rejected: Missing API Key in request headers');
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Access denied. Missing API key.'
      });
    }

    // 2. Hash the raw key using SHA-256 to match the database hash structure
    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    // 3. Query Redis Cache first (Cache-Aside pattern)
    const redisClient = getRedisClient();
    const cacheKey = `tenant:key:${apiKeyHash}`;
    const cachedTenant = await redisClient.get(cacheKey);

    if (cachedTenant) {
      const tenant = JSON.parse(cachedTenant);
      req.tenant = tenant;
      // Propagate tenant identity downstream to all downstream microservices
      req.headers['x-tenant-id'] = tenant.id;
      return next();
    }

    // 4. Cache Miss: Query PostgreSQL
    const db = getDbPool();
    const result = await db.query(
      'SELECT id, name, rate_limit_per_minute FROM tenants WHERE api_key_hash = $1 LIMIT 1',
      [apiKeyHash]
    );

    if (result.rows.length === 0) {
      logger.warn('Authentication rejected: Invalid API Key hash matched', { apiKeyHash });
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Access denied. Invalid API key.'
      });
    }

    const tenant = result.rows[0];

    // 5. Populate Redis Cache with 10-minute expiration (600 seconds)
    await redisClient.set(cacheKey, JSON.stringify(tenant), 'EX', 600);

    req.tenant = tenant;
    req.headers['x-tenant-id'] = tenant.id;
    return next();

  } catch (error) {
    logger.error('API key authentication process failed', {
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'An unexpected failure occurred during credentials verification.'
    });
  }
}

/**
 * 2. Portal User JWT Verification Middleware
 * 
 * Intercepts requests heading to dashboard endpoints (e.g., preference controls).
 * Validates 'Authorization: Bearer <token>' signatures using JWT standard.
 */
function authenticateJWT(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('Authentication rejected: Missing JWT bearer token');
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Access denied. Missing bearer token.'
      });
    }

    const token = authHeader.substring(7).trim();

    // Verify token cryptographic signature
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) {
        logger.warn('Authentication rejected: Invalid JWT signature', { 
          reason: err.message 
        });
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Access denied. The provided token is expired or invalid.'
        });
      }

      req.user = decoded; // Bind decoded identity payload
      
      // If user session is scoped to a B2B tenant, propagate tenant ID downstream
      if (decoded.tenantId) {
        req.headers['x-tenant-id'] = decoded.tenantId;
      }
      
      return next();
    });

  } catch (error) {
    logger.error('JWT authentication process failed', { 
      error: error.message 
    });
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'An unexpected failure occurred during token verification.'
    });
  }
}

module.exports = {
  authenticateTenant,
  authenticateJWT
};
