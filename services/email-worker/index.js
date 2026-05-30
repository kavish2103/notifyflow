const path = require('path');
// Load environment variables from central monorepo config
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Enforce service identity BEFORE loading the logger to label all logs correctly
process.env.SERVICE_NAME = 'email-worker-service';

const { logger } = require('@notifyflow/logger');
const { getKafkaClient, getKafkaProducer, TOPICS, CONSUMER_GROUPS } = require('@notifyflow/kafka');

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
 * Inserts a transactional record into the PostgreSQL delivery_logs table.
 */
async function logDelivery({ eventId, tenantId, userId, eventType, status, errorMessage = null, retryCount = 0 }) {
  try {
    const query = `
      INSERT INTO delivery_logs (event_id, tenant_id, user_id, channel, event_type, status, error_message, retry_count, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `;
    await dbPool.query(query, [
      eventId,
      tenantId,
      userId,
      'email',
      eventType,
      status,
      errorMessage,
      retryCount
    ]);
    logger.info('Delivery log persisted in database successfully', { eventId, status });
  } catch (err) {
    logger.error('Failed to write transactional delivery log to database', {
      error: err.message,
      eventId,
      status
    });
  }
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

        let payload = null;

        try {
          payload = JSON.parse(rawBody);
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

            await logDelivery({
              eventId: payload.eventId,
              tenantId: payload.tenantId,
              userId: payload.userId,
              eventType: payload.eventType,
              status: 'skipped',
              errorMessage: 'User has opted out of email channel preferences'
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

            await logDelivery({
              eventId: payload.eventId,
              tenantId: payload.tenantId,
              userId: payload.userId,
              eventType: payload.eventType,
              status: 'skipped',
              errorMessage: `No email template registered for event type '${payload.eventType}'`
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

            await logDelivery({
              eventId: payload.eventId,
              tenantId: payload.tenantId,
              userId: payload.userId,
              eventType: payload.eventType,
              status: 'skipped',
              errorMessage: 'Recipient email address not found in database or event payload context'
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

          await logDelivery({
            eventId: payload.eventId,
            tenantId: payload.tenantId,
            userId: payload.userId,
            eventType: payload.eventType,
            status: 'delivered'
          });

        } catch (err) {
          logger.error('Failed to process event or deliver email', {
            error: err.message,
            stack: err.stack,
            rawBody
          });

          if (payload && payload.eventId) {
            const currentRetryCount = payload.retryCount || 0;

            if (currentRetryCount < 3) {
              const nextRetryCount = currentRetryCount + 1;
              // Exponential backoff: 2s, 4s, 8s
              const backoffDelayMs = Math.pow(2, nextRetryCount) * 1000;
              const nextAttemptAt = new Date(Date.now() + backoffDelayMs).toISOString();

              const retryEvent = {
                ...payload,
                retryCount: nextRetryCount,
                nextAttemptAt
              };

              try {
                // Publish retry envelope onto Kafka retry topic
                const producer = await getKafkaProducer();
                await producer.send({
                  topic: TOPICS.RETRY,
                  messages: [
                    {
                      key: payload.userId,
                      value: JSON.stringify(retryEvent)
                    }
                  ]
                });

                logger.info('Enqueued event for retry delivery stream successfully', {
                  eventId: payload.eventId,
                  retryCount: nextRetryCount,
                  backoffDelayMs,
                  nextAttemptAt
                });

                // Write transactional failure log marked as retrying
                await logDelivery({
                  eventId: payload.eventId,
                  tenantId: payload.tenantId,
                  userId: payload.userId,
                  eventType: payload.eventType,
                  status: 'failed',
                  errorMessage: `Attempt ${nextRetryCount} failed: ${err.message}. Enqueued for retry backoff delay.`,
                  retryCount: nextRetryCount
                });

              } catch (prodErr) {
                logger.error('Failed to publish event to Kafka retry stream', {
                  error: prodErr.message,
                  eventId: payload.eventId
                });
              }

            } else {
              // Retries fully exhausted (DLQ logic)
              logger.warn('Email worker retries fully exhausted for event. Moving to DLQ...', {
                eventId: payload.eventId,
                retryCount: currentRetryCount
              });

              try {
                // 1. Publish raw envelope to the Kafka DLQ topic
                const producer = await getKafkaProducer();
                await producer.send({
                  topic: TOPICS.DLQ,
                  messages: [
                    {
                      key: payload.userId,
                      value: JSON.stringify(payload)
                    }
                  ]
                });
                logger.info('Successfully enqueued event onto Kafka DLQ stream', { eventId: payload.eventId });

                // 2. Persist in dead_letter_events PostgreSQL table
                const dlqQuery = `
                  INSERT INTO dead_letter_events (event_id, tenant_id, channel, event_type, payload, failure_reason, retry_count, last_attempted_at)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                  ON CONFLICT (event_id)
                  DO UPDATE SET 
                    failure_reason = EXCLUDED.failure_reason,
                    retry_count = EXCLUDED.retry_count,
                    last_attempted_at = NOW()
                `;
                await dbPool.query(dlqQuery, [
                  payload.eventId,
                  payload.tenantId,
                  'email',
                  payload.eventType,
                  JSON.stringify(payload),
                  err.message,
                  currentRetryCount
                ]);
                logger.info('Dead letter event successfully registered in PostgreSQL', { eventId: payload.eventId });

                // 3. Write final delivery log
                await logDelivery({
                  eventId: payload.eventId,
                  tenantId: payload.tenantId,
                  userId: payload.userId,
                  eventType: payload.eventType,
                  status: 'failed',
                  errorMessage: `Retries exhausted: ${err.message}. Relocated to DLQ.`,
                  retryCount: currentRetryCount
                });

              } catch (dlqErr) {
                logger.error('Failed to register dead letter event or publish onto DLQ stream', {
                  error: dlqErr.message,
                  eventId: payload.eventId
                });
              }
            }
          }
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
