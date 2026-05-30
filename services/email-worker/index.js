const path = require('path');
// Load environment variables from central monorepo config
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Enforce service identity BEFORE loading the logger to label all logs correctly
process.env.SERVICE_NAME = 'email-worker-service';

const { logger } = require('@notifyflow/logger');
const { getKafkaClient, TOPICS, CONSUMER_GROUPS } = require('@notifyflow/kafka');

const Handlebars = require('handlebars');

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
          
          // 1. Verify User Preferences for Email
          const prefServiceUrl = process.env.PREFERENCE_SERVICE_URL || 'http://localhost:3003';
          logger.info('Checking user preferences for email channel...', { 
            userId: payload.userId, 
            url: `${prefServiceUrl}/v1/preferences/${payload.userId}` 
          });

          const prefRes = await fetch(`${prefServiceUrl}/v1/preferences/${payload.userId}`, {
            headers: {
              'x-tenant-id': payload.tenantId,
              'x-correlation-id': payload.correlationId
            }
          });

          if (!prefRes.ok) {
            throw new Error(`Failed to fetch user preferences: status ${prefRes.status}`);
          }

          const prefData = await prefRes.json();
          const emailPref = prefData.preferences.find(p => p.channel === 'email');
          const isOptedIn = emailPref ? emailPref.optedIn : true;

          if (!isOptedIn) {
            logger.info('Skipping email delivery: User is opted out', {
              userId: payload.userId,
              correlationId: payload.correlationId
            });
            return;
          }

          // 2. Fetch specific Email template from port 3003
          logger.info('Fetching email template configured for event...', {
            eventType: payload.eventType,
            url: `${prefServiceUrl}/v1/templates/${payload.eventType}/email`
          });

          const tmplRes = await fetch(`${prefServiceUrl}/v1/templates/${payload.eventType}/email`, {
            headers: {
              'x-tenant-id': payload.tenantId,
              'x-correlation-id': payload.correlationId
            }
          });

          if (tmplRes.status === 404) {
            logger.warn('Skipping email delivery: No email template found for event type', {
              eventType: payload.eventType,
              tenantId: payload.tenantId
            });
            return;
          }

          if (!tmplRes.ok) {
            throw new Error(`Failed to fetch email template: status ${tmplRes.status}`);
          }

          const tmplData = await tmplRes.json();
          const { subjectTemplate, bodyTemplate } = tmplData;

          // 3. Compile and Render Dynamic Handlebars Templates
          const compileSubject = Handlebars.compile(subjectTemplate || '');
          const compileBody = Handlebars.compile(bodyTemplate);

          const renderedSubject = compileSubject(payload.payload || {});
          const renderedBody = compileBody(payload.payload || {});

          logger.info('Email templates successfully rendered dynamically', {
            userId: payload.userId,
            eventType: payload.eventType,
            renderedSubject,
            renderedBodyLength: renderedBody.length,
            renderedBodyPreview: renderedBody.substring(0, 100) + '...'
          });

          // Step placeholder: In Part 27, we will configure Nodemailer and send the email!

        } catch (err) {
          logger.error('Failed to process event or compile templates', {
            error: err.message,
            stack: err.stack,
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
