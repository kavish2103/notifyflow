const path = require('path');
// Dynamically resolve and load .env from the monorepo root
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Enforce service identity BEFORE loading the logger to label all log statements
process.env.SERVICE_NAME = 'event-ingestion-service';

const express = require('express');
const cors = require('cors');
const { logger, expressLoggerMiddleware } = require('@notifyflow/logger');

const app = express();
const PORT = process.env.INGESTION_PORT || 3002;

// Enable CORS and raw body parsers
app.use(cors());
app.use(express.json());

// Apply our Winston AsyncLocalStorage correlation middleware
app.use(expressLoggerMiddleware);

/**
 * GET /health
 * Diagnostic probe endpoint used by monitoring systems and load balancers.
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    service: 'event-ingestion-service',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage()
  });
});

// Boot HTTP listener
const server = app.listen(PORT, () => {
  logger.info(`Event Ingestion service boot sequence completed`, {
    port: PORT,
    nodeVersion: process.version,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received. Commencing graceful Express shutdown...');
  server.close(() => {
    logger.info('Express server shutdown complete. Thread terminated.');
    process.exit(0);
  });
});
