const path = require('path');
// Load environment variables from central monorepo config
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Enforce service identity BEFORE loading the logger to label all logs correctly
process.env.SERVICE_NAME = 'sms-worker-service';

const { logger } = require('@notifyflow/logger');
const { getKafkaClient, getKafkaProducer, TOPICS, CONSUMER_GROUPS } = require('@notifyflow/kafka');

const Handlebars = require('handlebars');
const twilio = require('twilio');

const { getDbPool } = require('./db');

let kafkaConsumer = null;
let retryConsumer = null;
let dbPool = null;
let twilioClient = null;

/**
 * Returns the configured Twilio client or falls back to a simulated Mock SMS dispatcher
 * if the credentials are not configured or default in the environment.
 */
function getSmsDispatcher() {
  if (twilioClient) {
    return twilioClient;
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

  const isMock = !accountSid || !authToken || !fromNumber;

  if (isMock) {
    logger.info('Using MOCK SMS delivery dispatcher (Twilio credentials not configured)');
    twilioClient = {
      messages: {
        create: async (options) => {
          logger.info('=== [MOCK SMS SENT SUCCESSFULLY] ===', {
            to: options.to,
            from: options.from || 'MOCK_SENDER',
            bodyLength: options.body.length,
            preview: options.body.substring(0, 100) + '...'
          });
          return { sid: `mock-sms-${Date.now()}` };
        }
      }
    };
  } else {
    logger.info('Initializing production Twilio SMS client...', { accountSid, fromNumber });
    twilioClient = twilio(accountSid, authToken);
  }

  return twilioClient;
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
      'sms',
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
 * Executes the complete SMS delivery pipeline:
 * Checks preferences, fetches templates, compiles dynamic template via Handlebars,
 * queries PostgreSQL database for recipient contact number, and dispatches SMS.
 */
async function deliverSmsEvent(payload) {
  // 1. Verify User Preferences for SMS channel
  const prefServiceUrl = process.env.PREFERENCE_SERVICE_URL || 'http://localhost:3003';
  logger.info('Checking user preferences for SMS channel...', {
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
  const smsPref = prefData.preferences.find(p => p.channel === 'sms');
  const isOptedIn = smsPref ? smsPref.optedIn : true;

  if (!isOptedIn) {
    logger.info('Skipping SMS delivery: User is opted out', {
      userId: payload.userId,
      correlationId: payload.correlationId
    });

    await logDelivery({
      eventId: payload.eventId,
      tenantId: payload.tenantId,
      userId: payload.userId,
      eventType: payload.eventType,
      status: 'skipped',
      errorMessage: 'User has opted out of SMS channel preferences'
    });
    return;
  }

  // 2. Fetch SMS template from Preference-Template microservice on port 3003
  logger.info('Fetching SMS template configured for event...', {
    eventType: payload.eventType,
    url: `${prefServiceUrl}/v1/templates/${payload.eventType}/sms`
  });

  const tmplRes = await fetch(`${prefServiceUrl}/v1/templates/${payload.eventType}/sms`, {
    headers: {
      'x-tenant-id': payload.tenantId,
      'x-correlation-id': payload.correlationId
    }
  });

  if (tmplRes.status === 404) {
    logger.warn('Skipping SMS delivery: No SMS template found for event type', {
      eventType: payload.eventType,
      tenantId: payload.tenantId
    });

    await logDelivery({
      eventId: payload.eventId,
      tenantId: payload.tenantId,
      userId: payload.userId,
      eventType: payload.eventType,
      status: 'skipped',
      errorMessage: `No SMS template registered for event type '${payload.eventType}'`
    });
    return;
  }

  if (!tmplRes.ok) {
    throw new Error(`Failed to fetch SMS template: status ${tmplRes.status}`);
  }

  const tmplData = await tmplRes.json();
  const { bodyTemplate } = tmplData;

  // 3. Compile and Render Dynamic Handlebars Templates
  const compileBody = Handlebars.compile(bodyTemplate);
  const renderedBody = compileBody(payload.payload || {});

  logger.info('SMS templates successfully rendered dynamically', {
    userId: payload.userId,
    eventType: payload.eventType,
    renderedBodyLength: renderedBody.length
  });

  // 4. Retrieve User phone details from PostgreSQL
  logger.info('Querying user phone number from database...', { userId: payload.userId });
  const userResult = await dbPool.query(
    'SELECT phone, external_user_id FROM users WHERE id = $1',
    [payload.userId]
  );

  let recipientPhone = null;
  if (userResult.rows.length > 0 && userResult.rows[0].phone) {
    recipientPhone = userResult.rows[0].phone;
  } else if (payload.payload && payload.payload.phoneNumber) {
    recipientPhone = payload.payload.phoneNumber;
  }

  if (!recipientPhone) {
    logger.warn('Skipping SMS delivery: Recipient phone number not found in DB or event payload', {
      userId: payload.userId,
      eventType: payload.eventType
    });

    await logDelivery({
      eventId: payload.eventId,
      tenantId: payload.tenantId,
      userId: payload.userId,
      eventType: payload.eventType,
      status: 'skipped',
      errorMessage: 'Recipient phone number not found in database or event payload context'
    });
    return;
  }

  // 5. Dispatch SMS
  logger.info('Initiating SMS dispatch...', { recipientPhone });
  const dispatcher = getSmsDispatcher();
  const fromNumber = process.env.TWILIO_FROM_NUMBER || '+15555555555';

  const info = await dispatcher.messages.create({
    to: recipientPhone,
    from: fromNumber,
    body: renderedBody
  });

  logger.info('SMS delivered successfully!', {
    userId: payload.userId,
    eventId: payload.eventId,
    messageSid: info.sid,
    recipient: recipientPhone
  });

  await logDelivery({
    eventId: payload.eventId,
    tenantId: payload.tenantId,
    userId: payload.userId,
    eventType: payload.eventType,
    status: 'delivered'
  });
}

/**
 * Asynchronous boot sequence for the SMS Worker service.
 * Establishes consumer connections and starts processing the Kafka streams.
 */
async function bootstrap() {
  try {
    logger.info('Starting SMS Worker Service boot sequence...');

    // 1. Establish database connection pool
    dbPool = getDbPool();
    const dbTimeResult = await dbPool.query('SELECT NOW()');
    logger.info('PostgreSQL connection verified successfully.', {
      dbServerTime: dbTimeResult.rows[0].now
    });

    // 2. Initialize our shared Kafka client
    const kafka = getKafkaClient();

    // 3. Create the Kafka consumer referencing the centralized SMS Worker consumer group
    kafkaConsumer = kafka.consumer({
      groupId: CONSUMER_GROUPS.SMS
    });

    logger.info('Connecting SMS Worker Kafka consumer...');
    await kafkaConsumer.connect();
    logger.info('Kafka consumer connected successfully.');

    // 4. Subscribe to the main event ingestion topic
    logger.info(`Subscribing to main events topic: ${TOPICS.EVENTS}...`);
    await kafkaConsumer.subscribe({
      topic: TOPICS.EVENTS,
      fromBeginning: false
    });

    // 5. Initialize the secondary Retry Consumer group for exponential backoff handling
    retryConsumer = kafka.consumer({
      groupId: CONSUMER_GROUPS.SMS_RETRY
    });

    logger.info('Connecting SMS Worker Kafka retry consumer...');
    await retryConsumer.connect();
    logger.info('Kafka retry consumer connected successfully.');

    logger.info(`Subscribing to retry stream topic: ${TOPICS.RETRY}...`);
    await retryConsumer.subscribe({
      topic: TOPICS.RETRY,
      fromBeginning: false
    });

    // 6. Start processing main stream
    logger.info('SMS Worker consumer is listening and active.');
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

          // Process delivery pipeline helper
          await deliverSmsEvent(payload);

        } catch (err) {
          logger.error('Failed to process event or deliver SMS', {
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
                channel: 'sms', // Tag specifically for SMS channel isolation
                retryCount: nextRetryCount,
                nextAttemptAt
              };

              try {
                // Publish retry envelope strictly onto retry queue topic
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

                logger.info('Enqueued event for retry SMS delivery stream successfully', {
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
              logger.warn('SMS worker retries fully exhausted for event. Moving to DLQ...', {
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
                  'sms',
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

    // 7. Start processing retry stream asynchronously
    logger.info('SMS Worker retry consumer is listening and active.');
    await retryConsumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const rawBody = message.value.toString();
        let payload = null;
        try {
          payload = JSON.parse(rawBody);

          // Discard retry envelopes targeting other channel workers (email, push, etc.)
          if (payload.channel && payload.channel !== 'sms') {
            return;
          }

          const { nextAttemptAt } = payload;

          const now = Date.now();
          const targetTime = new Date(nextAttemptAt).getTime();
          const sleepTimeMs = targetTime - now;

          if (sleepTimeMs > 0) {
            logger.info('Exponential backoff delay active. Halting retry message processing...', {
              eventId: payload.eventId,
              retryCount: payload.retryCount,
              sleepTimeMs
            });
            // Resilient non-blocking sleep wait
            await new Promise(resolve => setTimeout(resolve, sleepTimeMs));
          }

          logger.info('Backoff delay met. Directly executing retry delivery attempt...', {
            eventId: payload.eventId,
            retryCount: payload.retryCount
          });

          // Attempt retry delivery directly
          await deliverSmsEvent(payload);

        } catch (err) {
          logger.error('Failed to process retry event or deliver retry SMS', {
            error: err.message,
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
                channel: 'sms',
                retryCount: nextRetryCount,
                nextAttemptAt
              };

              try {
                // Re-enqueue back onto retry topic for subsequent delay wait
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

                logger.info('Re-enqueued failed retry event back onto retry stream topic successfully', {
                  eventId: payload.eventId,
                  retryCount: nextRetryCount,
                  backoffDelayMs,
                  nextAttemptAt
                });

                // Record failure attempt log in PostgreSQL
                await logDelivery({
                  eventId: payload.eventId,
                  tenantId: payload.tenantId,
                  userId: payload.userId,
                  eventType: payload.eventType,
                  status: 'failed',
                  errorMessage: `Retry Attempt ${nextRetryCount} failed: ${err.message}. Re-enqueued to retry stream.`,
                  retryCount: nextRetryCount
                });

              } catch (prodErr) {
                logger.error('Failed to publish event to Kafka retry stream during retry failure', {
                  error: prodErr.message,
                  eventId: payload.eventId
                });
              }
            } else {
              // Retries exhausted inside retry consumer flow -> DLQ logic
              logger.warn('SMS worker retry loop fully exhausted. Relocating to DLQ...', {
                eventId: payload.eventId,
                retryCount: currentRetryCount
              });

              try {
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
                logger.info('Successfully enqueued event onto Kafka DLQ stream from retry loop', { eventId: payload.eventId });

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
                  'sms',
                  payload.eventType,
                  JSON.stringify(payload),
                  err.message,
                  currentRetryCount
                ]);
                logger.info('Dead letter event successfully registered in PostgreSQL from retry loop', { eventId: payload.eventId });

                await logDelivery({
                  eventId: payload.eventId,
                  tenantId: payload.tenantId,
                  userId: payload.userId,
                  eventType: payload.eventType,
                  status: 'failed',
                  errorMessage: `Retries exhausted inside retry loop: ${err.message}. Relocated to DLQ.`,
                  retryCount: currentRetryCount
                });

              } catch (dlqErr) {
                logger.error('Failed to register dead letter event or publish onto DLQ stream during retry exhaust', {
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
    logger.error('Critical boot sequence failure for SMS Worker. Terminating.', {
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
  logger.info(`Received ${signal}. Launching SMS Worker graceful shutdown...`);

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

  if (retryConsumer) {
    logger.info('Closing Kafka retry consumer stream...');
    try {
      await retryConsumer.disconnect();
      logger.info('Kafka retry consumer disconnected cleanly.');
    } catch (err) {
      logger.error('Error disconnecting Kafka retry consumer during shutdown', {
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
