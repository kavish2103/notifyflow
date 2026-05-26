const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { logger, expressLoggerMiddleware } = require('@notifyflow/logger');
const { getKafkaProducer, TOPICS } = require('@notifyflow/kafka');
const { validateClientEvent } = require('@notifyflow/schemas');

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
 * POST /v1/events
 * Public ingestion channel for B2B tenants. Validates requests,
 * enriches payloads with system tracking metadata, and streams onto Kafka.
 */
app.post('/v1/events', async (req, res) => {
  // Defensive guard: Reject if service is booting and Kafka is not active
  if (!kafkaProducer) {
    logger.error('Attempted to ingest event, but Kafka producer is offline');
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'Ingestion pipeline connection is offline. Please retry shortly.'
    });
  }

  try {
    // 1. Zod schema validation
    const validationResult = validateClientEvent(req.body);
    if (!validationResult.success) {
      logger.warn('Incoming event failed schema validation checks', {
        errors: validationResult.error.errors
      });
      return res.status(400).json({
        error: 'ValidationError',
        message: 'The event payload failed standard schema validation.',
        details: validationResult.error.errors
      });
    }

    const clientEvent = validationResult.data;

    // 2. Extract correlation ID from headers or generate a trace ID
    const rawCorrelationId = req.headers['x-correlation-id'] || `req-${crypto.randomUUID()}`;
    const correlationId = rawCorrelationId.startsWith('req-') ? rawCorrelationId : `req-${rawCorrelationId}`;

    // 3. Enrich the transaction payload
    const eventId = `evt-${crypto.randomUUID()}`;
    const enrichedEvent = {
      schemaVersion: '1.0',
      eventId,
      clientEventId: clientEvent.clientEventId,
      tenantId: clientEvent.tenantId,
      userId: clientEvent.userId,
      eventType: clientEvent.eventType,
      timestamp: new Date().toISOString(),
      correlationId,
      retryCount: 0,
      payload: clientEvent.payload
    };

    // 4. Stream onto Kafka topic partitioned by userId to guarantee chronological delivery order
    logger.info('Streaming enriched transaction event onto Kafka topic...', {
      eventId,
      eventType: enrichedEvent.eventType,
      userId: enrichedEvent.userId,
      correlationId
    });

    await kafkaProducer.send({
      topic: TOPICS.EVENTS,
      messages: [
        {
          key: enrichedEvent.userId, // Guarantees message ordering per user
          value: JSON.stringify(enrichedEvent),
          headers: {
            correlationId: enrichedEvent.correlationId,
            tenantId: enrichedEvent.tenantId
          }
        }
      ]
    });

    logger.info('Transaction event successfully streamed to Kafka broker', {
      eventId,
      clientEventId: enrichedEvent.clientEventId,
      correlationId
    });

    // 5. Instantly release the client with HTTP 202 Accepted
    return res.status(202).json({
      status: 'ACCEPTED',
      message: 'Event has been successfully ingested and queued for delivery.',
      eventId,
      correlationId
    });

  } catch (error) {
    logger.error('Critical failure processing ingestion event', {
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({
      error: 'InternalServerError',
      message: 'An unexpected failure occurred during event ingestion.'
    });
  }
});

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

