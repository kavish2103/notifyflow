const path = require('path');
// Load environment variables from central monorepo config
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Enforce service identity BEFORE loading the logger to label all logs correctly
process.env.SERVICE_NAME = 'api-gateway-service';

const express = require('express');
const cors = require('cors');
const { logger, expressLoggerMiddleware } = require('@notifyflow/logger');
const { getRedisClient } = require('@notifyflow/redis');

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

let server = null;
let redisClient = null;

/**
 * Asynchronous boot sequence.
 * Guarantees that Redis is online and fully authenticated before routing HTTP traffic.
 */
async function bootstrap() {
  try {
    logger.info('Starting API Gateway boot sequence...');

    // 1. Establish connection to Redis
    logger.info('Initializing Redis client connection...');
    redisClient = getRedisClient();
    await redisClient.ping();
    logger.info('Redis connection verified successfully.');

    // 2. Start Express Listener
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

  logger.info('Graceful shutdown completed. Process exiting.');
  process.exit(0);
};

// Bind standard OS termination signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Trigger boot sequence
bootstrap();
