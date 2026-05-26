const path = require('path');
// Dynamically resolve and load .env from the monorepo root
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Enforce service identity BEFORE loading the logger to label all log statements
process.env.SERVICE_NAME = 'event-ingestion-service';

const express = require('express');
const cors = require('cors');
const { logger, expressLoggerMiddleware } = require('@notifyflow/logger');
const { getKafkaProducer, TOPICS } = require('@notifyflow/kafka');

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

let server = null;
let kafkaProducer = null;

/**
 * Asynchronous Boot Sequence.
 * Establishes connection to backing engines (Kafka) before listening for HTTP traffic.
 */
async function bootstrap() {
  try {
    logger.info('Starting Event Ingestion boot sequence...');

    // 1. Establish connection to Kafka Brokers
    logger.info('Initializing Kafka Producer connection...');
    kafkaProducer = await getKafkaProducer();
    logger.info('Kafka connection established successfully.');

    // 2. Bind and Boot Express Server
    server = app.listen(PORT, () => {
      logger.info(`Event Ingestion service fully booted and listening`, {
        port: PORT,
        nodeVersion: process.version,
        environment: process.env.NODE_ENV || 'development'
      });
    });

  } catch (error) {
    logger.error('Critical boot sequence failure. Terminating process.', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

/**
 * Gracefully cleans up outstanding database connections and closes sockets.
 */
const shutdown = async (signal) => {
  logger.info(`Received ${signal}. Starting graceful termination sequence...`);

  if (server) {
    logger.info('Closing Express HTTP server listener...');
    await new Promise((resolve) => server.close(resolve));
    logger.info('Express server listener closed.');
  }

  if (kafkaProducer) {
    logger.info('Disconnecting Kafka Producer socket...');
    try {
      await kafkaProducer.disconnect();
      logger.info('Kafka Producer socket disconnected cleanly.');
    } catch (err) {
      logger.error('Error disconnecting Kafka Producer during shutdown', { 
        error: err.message 
      });
    }
  }

  logger.info('Graceful shutdown completed. Process exiting.');
  process.exit(0);
};

// Bind OS termination signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start boot sequence
bootstrap();

