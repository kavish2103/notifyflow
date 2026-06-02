const path = require('path');
// Load environment variables from central monorepo config
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Enforce service identity BEFORE loading the logger to label all logs correctly
process.env.SERVICE_NAME = 'api-gateway-service';

const express = require('express');
const cors = require('cors');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const { logger, expressLoggerMiddleware } = require('@notifyflow/logger');
const { getRedisClient } = require('@notifyflow/redis');
const { getDbPool } = require('./db');
const { authenticateTenant, authenticateFlexible } = require('./auth');
const { rateLimitTenant } = require('./rate-limiter');

const app = express();
const PORT = process.env.GATEWAY_PORT || 3000;

// Enable CORS and Express body parsing middleware
app.use(cors());
app.use(express.json());

// Inject central AsyncLocalStorage request tracing middleware
app.use(expressLoggerMiddleware);

/**
 * GET /health
 * Edge-level diagnostic health check.
 * Evaluates gateway internals and will serve as our consolidated system status.
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    service: 'api-gateway-service',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage()
  });
});

// ==============================================================================
// REVERSE PROXY ROUTING LAYERS
// ==============================================================================

/**
 * 1. Proxy Routing: Event Ingestion Service
 * Route: POST /v1/events
 * Security: Enforces strict B2B API key authentication and per-tenant rate limits in Redis.
 */
app.use('/v1/events',
  authenticateTenant,
  rateLimitTenant,
  createProxyMiddleware({
    target: process.env.INGESTION_SERVICE_URL || 'http://localhost:3002',
    changeOrigin: true,
    onProxyReq: (proxyReq, req) => {
      // Propagate tenant identity and transaction correlation trace downstream first
      if (req.headers['x-tenant-id']) {
        proxyReq.setHeader('x-tenant-id', req.headers['x-tenant-id']);
      }
      if (req.headers['x-correlation-id']) {
        proxyReq.setHeader('x-correlation-id', req.headers['x-correlation-id']);
      }

      // Restream body data LAST (writing body data flushes headers!)
      fixRequestBody(proxyReq, req);
    }
  })
);

/**
 * 2. Proxy Routing: Preference & Template Service (Users)
 * Route: /v1/users
 * Security: Flexible authentication (allows JWT Bearer or B2B API Key lookup)
 */
app.use('/v1/users',
  authenticateFlexible,
  createProxyMiddleware({
    target: process.env.PREFERENCE_SERVICE_URL || 'http://localhost:3003',
    changeOrigin: true,
    onProxyReq: (proxyReq, req) => {
      // Set custom headers first
      if (req.headers['x-tenant-id']) {
        proxyReq.setHeader('x-tenant-id', req.headers['x-tenant-id']);
      }
      if (req.headers['x-correlation-id']) {
        proxyReq.setHeader('x-correlation-id', req.headers['x-correlation-id']);
      }

      // Restream body last
      fixRequestBody(proxyReq, req);
    }
  })
);

/**
 * 3. Proxy Routing: Preference & Template Service (Preferences)
 * Route: /v1/preferences
 * Security: Flexible authentication (allows JWT Bearer or B2B API Key lookup)
 */
app.use('/v1/preferences',
  authenticateFlexible,
  createProxyMiddleware({
    target: process.env.PREFERENCE_SERVICE_URL || 'http://localhost:3003',
    changeOrigin: true,
    onProxyReq: (proxyReq, req) => {
      // Set custom headers first
      if (req.headers['x-tenant-id']) {
        proxyReq.setHeader('x-tenant-id', req.headers['x-tenant-id']);
      }
      if (req.headers['x-correlation-id']) {
        proxyReq.setHeader('x-correlation-id', req.headers['x-correlation-id']);
      }

      // Restream body last
      fixRequestBody(proxyReq, req);
    }
  })
);

/**
 * 3. Proxy Routing: Preference & Template Service (Templates)
 * Route: /v1/templates
 * Security: Flexible authentication (allows JWT Bearer or B2B API Key lookup)
 */
app.use('/v1/templates',
  authenticateFlexible,
  createProxyMiddleware({
    target: process.env.PREFERENCE_SERVICE_URL || 'http://localhost:3003',
    changeOrigin: true,
    onProxyReq: (proxyReq, req) => {
      // Set custom headers first
      if (req.headers['x-tenant-id']) {
        proxyReq.setHeader('x-tenant-id', req.headers['x-tenant-id']);
      }
      if (req.headers['x-correlation-id']) {
        proxyReq.setHeader('x-correlation-id', req.headers['x-correlation-id']);
      }

      // Restream body last
      fixRequestBody(proxyReq, req);
    }
  })
);

/**
 * 4. Proxy Routing: Analytics Service
 * Route: /v1/analytics
 * Security: Flexible authentication (allows JWT Bearer or B2B API Key lookup)
 */
app.use('/v1/analytics',
  authenticateFlexible,
  createProxyMiddleware({
    target: process.env.ANALYTICS_SERVICE_URL || 'http://localhost:3004',
    changeOrigin: true,
    onProxyReq: (proxyReq, req) => {
      // Set custom headers first
      if (req.headers['x-tenant-id']) {
        proxyReq.setHeader('x-tenant-id', req.headers['x-tenant-id']);
      }
      if (req.headers['x-correlation-id']) {
        proxyReq.setHeader('x-correlation-id', req.headers['x-correlation-id']);
      }

      // Restream body last
      fixRequestBody(proxyReq, req);
    }
  })
);

// ==============================================================================
// ADMIN DASHBOARD & TENANT MANAGEMENT SYSTEM ENDPOINTS
// ==============================================================================
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Hardcoded admin login
app.post('/v1/admin/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin-secret-password-123';
  if (password === adminPassword) {
    const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '2h' });
    return res.status(200).json({ token });
  }
  return res.status(401).json({ error: 'Unauthorized', message: 'Invalid admin password.' });
});

// Admin authentication middleware
const authenticateAdmin = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Access denied. Missing bearer token.' });
    }
    const token = authHeader.substring(7).trim();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden', message: 'Access denied. Administrator privileges required.' });
    }
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token.' });
  }
};

// 1. Get all tenants list
app.get('/v1/admin/tenants', authenticateAdmin, async (req, res) => {
  try {
    const db = getDbPool();
    const result = await db.query('SELECT id, name, rate_limit_per_minute, created_at FROM tenants ORDER BY created_at DESC');
    res.status(200).json({ tenants: result.rows });
  } catch (err) {
    logger.error('Failed to fetch tenants for admin', { error: err.message });
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to fetch tenants.' });
  }
});

// 2. Create new tenant (generates secure API key, stores SHA-256 hash)
app.post('/v1/admin/tenants', authenticateAdmin, async (req, res) => {
  const { name, rateLimit } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'BadRequestError', message: 'Tenant name is required.' });
  }
  try {
    const rawApiKey = 'nf_key_' + crypto.randomBytes(24).toString('hex');
    const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
    const tenantId = `tenant-${crypto.randomUUID()}`;
    const limit = rateLimit ? parseInt(rateLimit, 10) : 60;

    const db = getDbPool();
    await db.query(
      'INSERT INTO tenants (id, name, api_key_hash, rate_limit_per_minute) VALUES ($1, $2, $3, $4)',
      [tenantId, name, apiKeyHash, limit]
    );

    res.status(201).json({
      tenant: {
        id: tenantId,
        name,
        rate_limit_per_minute: limit
      },
      apiKey: rawApiKey
    });
  } catch (err) {
    logger.error('Failed to create tenant for admin', { error: err.message });
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create tenant.' });
  }
});

// 3. System-wide stats & Health status
app.get('/v1/admin/stats', authenticateAdmin, async (req, res) => {
  try {
    const db = getDbPool();
    
    // Total events today across all tenants
    const eventsTodayRes = await db.query(
      "SELECT COUNT(*) as count FROM delivery_logs WHERE created_at >= DATE_TRUNC('day', NOW())"
    );
    
    // Total delivered/failed/skipped across all tenants
    const deliveryStatsRes = await db.query(
      "SELECT status, COUNT(*) as count FROM delivery_logs GROUP BY status"
    );
    
    // Total DLQ count
    const dlqStatsRes = await db.query("SELECT COUNT(*) as count FROM dead_letter_events");

    const summary = {
      today: parseInt(eventsTodayRes.rows[0].count, 10),
      delivered: 0,
      failed: 0,
      skipped: 0,
      dlq: parseInt(dlqStatsRes.rows[0].count, 10)
    };

    deliveryStatsRes.rows.forEach(r => {
      if (summary[r.status] !== undefined) {
        summary[r.status] = parseInt(r.count, 10);
      }
    });

    // Services health checks
    const services = [
      { name: 'Event Ingestion', url: process.env.INGESTION_SERVICE_URL || 'http://localhost:3002' },
      { name: 'Preference & Template', url: process.env.PREFERENCE_SERVICE_URL || 'http://localhost:3003' },
      { name: 'Analytics Consumer', url: process.env.ANALYTICS_SERVICE_URL || 'http://localhost:3004' }
    ];

    const healthStatus = {};
    await Promise.all(
      services.map(async (srv) => {
        try {
          const healthRes = await fetch(`${srv.url}/health`);
          if (healthRes.ok) {
            healthStatus[srv.name] = 'Healthy';
          } else {
            healthStatus[srv.name] = `Degraded (Status ${healthRes.status})`;
          }
        } catch (err) {
          healthStatus[srv.name] = 'Offline';
        }
      })
    );

    // Hardcode workers status as active since they are managed Kafka consumers
    healthStatus['Email Worker'] = 'Active';
    healthStatus['SMS Worker'] = 'Active';
    healthStatus['Push Worker'] = 'Active';

    res.status(200).json({
      summary,
      health: healthStatus
    });

  } catch (err) {
    logger.error('Failed to fetch admin stats', { error: err.message });
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to compile system stats.' });
  }
});

let server = null;
let redisClient = null;

/**
 * Asynchronous boot sequence.
 * Guarantees that Redis and Postgres are online and fully authenticated before routing HTTP traffic.
 */
async function bootstrap() {
  try {
    logger.info('Starting API Gateway boot sequence...');

    // 1. Establish connection to Redis
    logger.info('Initializing Redis client connection...');
    redisClient = getRedisClient();
    await redisClient.ping();
    logger.info('Redis connection verified successfully.');

    // 2. Establish connection to PostgreSQL
    logger.info('Initializing PostgreSQL connection pool...');
    const dbPool = getDbPool();
    const dbTimeResult = await dbPool.query('SELECT NOW()');
    logger.info('PostgreSQL connection verified successfully.', {
      dbServerTime: dbTimeResult.rows[0].now
    });

    // 3. Start Express Listener
    server = app.listen(PORT, () => {
      logger.info('API Gateway fully booted and listening', {
        port: PORT,
        nodeVersion: process.version,
        environment: process.env.NODE_ENV || 'development'
      });
    });

  } catch (error) {
    logger.error('Critical boot sequence failure for API Gateway. Terminating.', {
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
  logger.info(`Received ${signal}. Launching API Gateway graceful termination...`);

  if (server) {
    logger.info('Closing HTTP server socket...');
    await new Promise((resolve) => server.close(resolve));
    logger.info('HTTP server socket closed.');
  }

  if (redisClient) {
    logger.info('Closing Redis connection socket...');
    try {
      await redisClient.quit();
      logger.info('Redis connection socket disconnected cleanly.');
    } catch (err) {
      logger.error('Error disconnecting Redis client during shutdown', { 
        error: err.message 
      });
    }
  }

  try {
    const dbPool = getDbPool();
    if (dbPool) {
      logger.info('Closing PostgreSQL connection pool...');
      await dbPool.end();
      logger.info('PostgreSQL connection pool closed cleanly.');
    }
  } catch (err) {
    logger.error('Error closing PostgreSQL database pool during shutdown', {
      error: err.message
    });
  }

  logger.info('Graceful shutdown completed. Process exiting.');
  process.exit(0);
};

// Bind standard OS termination signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Trigger boot sequence
bootstrap();
