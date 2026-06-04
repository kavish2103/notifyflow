const path = require('path');
// Load environment variables from central monorepo config
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Enforce service identity BEFORE loading the logger to label all logs correctly
process.env.SERVICE_NAME = 'push-worker-service';

const { logger } = require('@notifyflow/logger');
const { getKafkaClient, getKafkaProducer, TOPICS, CONSUMER_GROUPS } = require('@notifyflow/kafka');
const { getRedisClient, KEYS } = require('@notifyflow/redis');

const Handlebars = require('handlebars');
const webpush = require('web-push');

const { getDbPool } = require('./db');

let kafkaConsumer = null;
let retryConsumer = null;
let dbPool = null;
let webpushClient = null;

/**
 * Returns the configured web-push client or falls back to a simulated Mock Web Push dispatcher
 * if VAPID keys are not configured in the environment variables.
 */
function getPushDispatcher() {
  if (webpushClient) {
    return webpushClient;
  }

  const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
  const privateVapidKey = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@notifyflow.com';

  const isMock = !publicVapidKey || !privateVapidKey;

  if (isMock) {
    logger.info('Using MOCK Web Push delivery dispatcher (VAPID keys not configured)');
    webpushClient = {
      sendNotification: async (subscription, payloadString) => {
        logger.info('=== [MOCK WEB PUSH SENT SUCCESSFULLY] ===', {
          endpoint: subscription.endpoint,
          payloadLength: payloadString.length,
          preview: payloadString.substring(0, 100) + '...'
        });
        return { statusCode: 201, body: 'Mock success' };
      }
    };
  } else {
    logger.info('Initializing production Web Push client...', { vapidSubject });
    webpush.setVapidDetails(vapidSubject, publicVapidKey, privateVapidKey);
    webpushClient = webpush;
  }

  return webpushClient;
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
      'push',
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
 * Executes the complete Push delivery pipeline:
 * Step 1: Idempotency check via Redis.
 * Step 2: Verify user preferences.
 * Step 3: Fetch event channel template.
 * Step 4: Dynamically compile via Handlebars.
 * Step 5: Resolve push token and dispatch via Web Push.
 */
async function deliverPushEvent(payload) {
  const redis = getRedisClient();
  const idempotencyKey = KEYS.idempotency('push', payload.eventId);

  // === STEP 1: Idempotency Check (MUST be executed first before everything else) ===
  // Only execute idempotency checks on greenfield events (retryCount === 0) to allow retry attempts to bypass
  if (!payload.retryCount || payload.retryCount === 0) {
    const isUnique = await redis.set(idempotencyKey, '1', 'NX', 'EX', 86400);
    if (!isUnique) {
      logger.info('Skipping push delivery: Duplicate event processed by Redis idempotency check', {
        eventId: payload.eventId,
        idempotencyKey
      });
      return; // Already processed, skip immediately
    }
  }

  // === STEP 2: Preference Check ===
  const prefServiceUrl = process.env.PREFERENCE_SERVICE_URL || 'http://localhost:3003';
  logger.info('Checking user preferences for push channel...', { 
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
  const pushPref = prefData.preferences.find(p => p.channel === 'push');
  const isOptedIn = pushPref ? pushPref.optedIn : true;

  if (!isOptedIn) {
    logger.info('Skipping push delivery: User has opted out of push alerts', {
      userId: payload.userId,
      correlationId: payload.correlationId
    });

    await logDelivery({
      eventId: payload.eventId,
      tenantId: payload.tenantId,
      userId: payload.userId,
      eventType: payload.eventType,
      status: 'skipped',
      errorMessage: 'User has opted out of push channel preferences'
    });
    return;
  }

  // === STEP 3: Template Resolution ===
  logger.info('Fetching push template configured for event...', {
    eventType: payload.eventType,
    url: `${prefServiceUrl}/v1/templates/${payload.eventType}/push`
  });

  const tmplRes = await fetch(`${prefServiceUrl}/v1/templates/${payload.eventType}/push`, {
    headers: {
      'x-tenant-id': payload.tenantId,
      'x-correlation-id': payload.correlationId
    }
  });

  if (tmplRes.status === 404) {
    logger.warn('Skipping push delivery: No push template found for event type', {
      eventType: payload.eventType,
      tenantId: payload.tenantId
    });

    await logDelivery({
      eventId: payload.eventId,
      tenantId: payload.tenantId,
      userId: payload.userId,
      eventType: payload.eventType,
      status: 'skipped',
      errorMessage: `No push template registered for event type '${payload.eventType}'`
    });
    return;
  }

  if (!tmplRes.ok) {
    throw new Error(`Failed to fetch push template: status ${tmplRes.status}`);
  }

  const tmplData = await tmplRes.json();
  const { bodyTemplate } = tmplData;

  // === STEP 4: Compile Dynamic Templates ===
  const compileBody = Handlebars.compile(bodyTemplate);
  const renderedBody = compileBody(payload.payload || {});

  logger.info('Push templates successfully rendered dynamically', {
    userId: payload.userId,
    eventType: payload.eventType,
    renderedBodyLength: renderedBody.length
  });

  // === STEP 5: Resolve User Push Subscription Details ===
  logger.info('Querying user push subscription token from database...', { userId: payload.userId });
  const userResult = await dbPool.query(
    'SELECT push_token, external_user_id FROM users WHERE id = $1',
    [payload.userId]
  );

  let pushTokenRaw = null;
  if (userResult.rows.length > 0 && userResult.rows[0].push_token) {
    pushTokenRaw = userResult.rows[0].push_token;
  } else if (payload.payload && payload.payload.pushToken) {
    pushTokenRaw = payload.payload.pushToken;
  }

  if (!pushTokenRaw) {
    logger.warn('Skipping push delivery: Recipient push token not found in DB or event payload', {
      userId: payload.userId,
      eventType: payload.eventType
    });

    await logDelivery({
      eventId: payload.eventId,
      tenantId: payload.tenantId,
      userId: payload.userId,
      eventType: payload.eventType,
      status: 'skipped',
      errorMessage: 'Recipient push token not found in database or event payload context'
    });
    return;
  }

  // Parse push token to extract endpoint subscription keys
  let subscription = null;
  try {
    // Check if push token is already a parsed JSON or a JSON string
    subscription = typeof pushTokenRaw === 'string' ? JSON.parse(pushTokenRaw) : pushTokenRaw;
  } catch (e) {
    // If it's a raw string rather than standard Web Push Endpoint JSON envelope, wrap it in a mock structure
    subscription = {
      endpoint: pushTokenRaw,
      keys: { p256dh: '', auth: '' }
    };
  }

  if (!subscription || !subscription.endpoint) {
    throw new Error('Malformed push token subscription details.');
  }

  // === STEP 6: Dispatch Push Notification ===
  logger.info('Initiating push notification dispatch...', { endpoint: subscription.endpoint });
  const dispatcher = getPushDispatcher();

  const payloadString = JSON.stringify({
    title: payload.eventType,
    body: renderedBody,
    tag: payload.eventId,
    data: {
      eventId: payload.eventId,
      correlationId: payload.correlationId,
      tenantId: payload.tenantId
    }
  });

  const info = await dispatcher.sendNotification(subscription, payloadString);

  logger.info('Push notification delivered successfully!', {
    userId: payload.userId,
    eventId: payload.eventId,
    statusCode: info.statusCode,
    endpoint: subscription.endpoint
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
 * Asynchronous boot sequence for the Push Worker service.
 * Establishes consumer connections and starts processing the Kafka streams.
 */
async function bootstrap() {
  try {
    logger.info('Starting Push Worker Service boot sequence...');

    // 1. Establish database connection pool
    dbPool = getDbPool();
    const dbTimeResult = await dbPool.query('SELECT NOW()');
    logger.info('PostgreSQL connection verified successfully.', {
      dbServerTime: dbTimeResult.rows[0].now
    });

    // 2. Verify Redis client connection
    const redis = getRedisClient();
    await redis.ping();
    logger.info('Redis connection verified successfully.');

    // 3. Initialize our shared Kafka client
    const kafka = getKafkaClient();

    // 4. Create the Kafka consumer referencing the centralized Push Worker consumer group
    kafkaConsumer = kafka.consumer({
      groupId: CONSUMER_GROUPS.PUSH
    });

    logger.info('Connecting Push Worker Kafka consumer...');
    await kafkaConsumer.connect();
    logger.info('Kafka consumer connected successfully.');

    // 5. Subscribe to the main event ingestion topic
    logger.info(`Subscribing to main events topic: ${TOPICS.EVENTS}...`);
    await kafkaConsumer.subscribe({
      topic: TOPICS.EVENTS,
      fromBeginning: false
    });

    // 6. Initialize the secondary Retry Consumer group for exponential backoff handling
    retryConsumer = kafka.consumer({
      groupId: CONSUMER_GROUPS.PUSH_RETRY
    });

    logger.info('Connecting Push Worker Kafka retry consumer...');
    await retryConsumer.connect();
    logger.info('Kafka retry consumer connected successfully.');

    logger.info(`Subscribing to retry stream topic: ${TOPICS.RETRY}...`);
    await retryConsumer.subscribe({
      topic: TOPICS.RETRY,
      fromBeginning: false
    });

    // 7. Start processing main stream
    logger.info('Push Worker consumer is listening and active.');
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
          await deliverPushEvent(payload);

        } catch (err) {
          logger.error('Failed to process event or deliver Push notification', {
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
                channel: 'push', // Tag specifically for Push channel isolation
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

                logger.info('Enqueued event for retry Push delivery stream successfully', {
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
              logger.warn('Push worker retries fully exhausted for event. Moving to DLQ...', {
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
                  'push',
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

    // 8. Start processing retry stream asynchronously
    logger.info('Push Worker retry consumer is listening and active.');
    await retryConsumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const rawBody = message.value.toString();
        let payload = null;
        try {
          payload = JSON.parse(rawBody);

          // Discard retry envelopes targeting other channel workers (email, sms, etc.)
          if (payload.channel && payload.channel !== 'push') {
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
          await deliverPushEvent(payload);

        } catch (err) {
          logger.error('Failed to process retry event or deliver retry Push notification', {
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
                channel: 'push',
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
              logger.warn('Push worker retry loop fully exhausted. Relocating to DLQ...', {
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
                  'push',
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
    logger.error('Critical boot sequence failure for Push Worker. Terminating.', {
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
  logger.info(`Received ${signal}. Launching Push Worker graceful shutdown...`);

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
