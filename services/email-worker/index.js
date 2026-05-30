const path = require('path');
// Load environment variables from central monorepo config
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Enforce service identity BEFORE loading the logger to label all logs correctly
process.env.SERVICE_NAME = 'email-worker-service';

const { logger } = require('@notifyflow/logger');
const { getKafkaClient, TOPICS, CONSUMER_GROUPS } = require('@notifyflow/kafka');

let kafkaConsumer = null;

/**
 * Asynchronous boot sequence for the Email Worker service.
 * Establishes a consumer connection and starts processing the main Kafka event stream.
 */
async function bootstrap() {
  try {
    logger.info('Starting Email Worker Service boot sequence...');

    // 1. Initialize our shared Kafka client
    const kafka = getKafkaClient();

    // 2. Create the Kafka consumer referencing the centralized Email Worker consumer group
    kafkaConsumer = kafka.consumer({
      groupId: CONSUMER_GROUPS.EMAIL
    });

    logger.info('Connecting Email Worker Kafka consumer...');
    await kafkaConsumer.connect();
    logger.info('Kafka consumer connected successfully.');

    // 3. Subscribe to the main event ingestion topic
    logger.info(`Subscribing to main events topic: ${TOPICS.EVENTS}...`);
    await kafkaConsumer.subscribe({
      topic: TOPICS.EVENTS,
      fromBeginning: false // Start reading fresh messages on startup
    });

    // 4. Start processing stream
    logger.info('Email Worker consumer is listening and active.');
    await kafkaConsumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const offset = message.offset;
        const key = message.key ? message.key.toString() : 'null';
        const rawBody = message.value.toString();

        logger.info('Received Kafka event on main stream', {
          topic,
          partition,
          offset,
          key
        });

        try {
          const payload = JSON.parse(rawBody);
          logger.debug('Successfully parsed event payload', {
            eventId: payload.eventId,
            clientEventId: payload.clientEventId,
            eventType: payload.eventType,
            tenantId: payload.tenantId,
            userId: payload.userId
          });
          
          // Step placeholder: In subsequent parts, we will call preferences, fetch templates, and send email!
        } catch (err) {
          logger.error('Failed to parse event JSON structure', {
            error: err.message,
            rawBody
          });
        }
      }
    });

  } catch (error) {
    logger.error('Critical boot sequence failure for Email Worker. Terminating.', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

/**
 * Graceful termination handler to close consumer connections cleanly.
 */
const shutdown = async (signal) => {
  logger.info(`Received ${signal}. Launching Email Worker graceful shutdown...`);

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

  logger.info('Graceful shutdown completed. Process exiting.');
  process.exit(0);
};

// Bind OS signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

bootstrap();
