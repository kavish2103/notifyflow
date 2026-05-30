const path = require('path');
// Load environment variables from central monorepo config
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Enforce service identity BEFORE loading the logger to label all logs correctly
process.env.SERVICE_NAME = 'email-worker-service';

const { logger } = require('@notifyflow/logger');
const { getKafkaClient, TOPICS, CONSUMER_GROUPS } = require('@notifyflow/kafka');

const Handlebars = require('handlebars');

const { getDbPool } = require('./db');
const nodemailer = require('nodemailer');

let kafkaConsumer = null;
let mailTransporter = null;
let dbPool = null;

/**
 * Returns the configured Nodemailer client transport (Singleton).
 * Cascades resiliently to a simulated Mock transporter if SMTP credentials are left at default values.
 */
function getMailTransporter() {
  if (mailTransporter) {
    return mailTransporter;
  }

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '2525');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  // Detect unconfigured or default values to fallback to a simulated local trace
  const isMock = !user || user.includes('your_mailtrap_smtp_username');

  if (isMock) {
    logger.info('Using MOCK email delivery transporter (SMTP credentials not configured)');
    mailTransporter = {
      sendMail: async (mailOptions) => {
        logger.info('=== [MOCK EMAIL SENT SUCCESSFULLY] ===', {
          to: mailOptions.to,
          from: mailOptions.from,
          subject: mailOptions.subject,
          bodyLength: mailOptions.text.length,
          preview: mailOptions.text.substring(0, 100) + '...'
        });
        return { messageId: `mock-msg-${Date.now()}` };
      }
    };
  } else {
    logger.info('Initializing production SMTP transport connection pool...', { host, port });
    mailTransporter = nodemailer.createTransport({
      host,
      port,
      secure: false,
      auth: {
        user,
        pass
      }
    });
  }

  return mailTransporter;
}

/**
 * Asynchronous boot sequence for the Email Worker service.
 * Establishes a consumer connection and starts processing the main Kafka event stream.
 */
async function bootstrap() {
  try {
    logger.info('Starting Email Worker Service boot sequence...');

    // 1. Establish database connection pool
    dbPool = getDbPool();
    const dbTimeResult = await dbPool.query('SELECT NOW()');
    logger.info('PostgreSQL connection verified successfully.', {
      dbServerTime: dbTimeResult.rows[0].now
    });

    // 2. Initialize our shared Kafka client
    const kafka = getKafkaClient();

    // 3. Create the Kafka consumer referencing the centralized Email Worker consumer group
    kafkaConsumer = kafka.consumer({
      groupId: CONSUMER_GROUPS.EMAIL
    });

    logger.info('Connecting Email Worker Kafka consumer...');
    await kafkaConsumer.connect();
    logger.info('Kafka consumer connected successfully.');

    // 4. Subscribe to the main event ingestion topic
    logger.info(`Subscribing to main events topic: ${TOPICS.EVENTS}...`);
    await kafkaConsumer.subscribe({
      topic: TOPICS.EVENTS,
      fromBeginning: false // Start reading fresh messages on startup
    });

    // 5. Start processing stream
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
            renderedBodyLength: renderedBody.length
          });

          // 4. Retrieve User email contact details from PostgreSQL
          logger.info('Querying user email from database...', { userId: payload.userId });
          const userResult = await dbPool.query(
            'SELECT email, external_user_id FROM users WHERE id = $1',
            [payload.userId]
          );

          let recipientEmail = null;
          if (userResult.rows.length > 0 && userResult.rows[0].email) {
            recipientEmail = userResult.rows[0].email;
          } else if (payload.payload && payload.payload.email) {
            recipientEmail = payload.payload.email;
          }

          if (!recipientEmail) {
            logger.warn('Skipping email delivery: Recipient email address not found in DB or event payload', {
              userId: payload.userId,
              eventType: payload.eventType
            });
            return;
          }

          // 5. Execute Nodemailer SMTP Transporter delivery
          logger.info('Initiating email dispatch...', { recipientEmail });
          const transporter = getMailTransporter();
          const mailOptions = {
            from: process.env.SMTP_FROM_EMAIL || '"NotifyFlow Alerts" <alerts@notifyflow.com>',
            to: recipientEmail,
            subject: renderedSubject || 'Notification Alert',
            text: renderedBody
          };

          const info = await transporter.sendMail(mailOptions);
          logger.info('Email delivered successfully!', {
            userId: payload.userId,
            eventId: payload.eventId,
            messageId: info.messageId,
            recipient: recipientEmail
          });

          // Step placeholder: In Part 28, we will build transactional logging!

        } catch (err) {
          logger.error('Failed to process event or deliver email', {
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
