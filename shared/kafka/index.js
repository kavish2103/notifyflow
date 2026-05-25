const { Kafka, logLevel } = require('kafkajs');
const { logger } = require('@notifyflow/logger');

// Centralized topic names. Changes here apply to all consumers and producers.
const TOPICS = {
  EVENTS: 'notifyflow.events.v1',
  RETRY: 'notifyflow.retry.v1',
  DLQ: 'notifyflow.dlq.v1'
};

// Centralized consumer group IDs. Essential for manual offset tracking.
const CONSUMER_GROUPS = {
  EMAIL: 'notifyflow-email-cg',
  SMS: 'notifyflow-sms-cg',
  PUSH: 'notifyflow-push-cg',
  ANALYTICS: 'notifyflow-analytics-cg',
  EMAIL_RETRY: 'notifyflow-email-retry-cg',
  SMS_RETRY: 'notifyflow-sms-retry-cg',
  PUSH_RETRY: 'notifyflow-push-retry-cg',
  DLQ_MONITOR: 'notifyflow-dlq-monitor-cg'
};

let kafkaClientInstance = null;
let kafkaProducerInstance = null;

/**
 * Translates KafkaJS log levels into Winston-compatible log levels.
 */
const toWinstonLogLevel = (level) => {
  switch (level) {
    case logLevel.ERROR:
    case logLevel.NOTHING:
      return 'error';
    case logLevel.WARN:
      return 'warn';
    case logLevel.INFO:
      return 'info';
    case logLevel.DEBUG:
      return 'debug';
    default:
      return 'info';
  }
};

/**
 * Connects the KafkaJS internal logger with our Winston structured JSON logger.
 */
const winstonLogCreator = () => {
  return ({ namespace, level, label, log }) => {
    const { message, ...extra } = log;
    logger.log({
      level: toWinstonLogLevel(level),
      message: `[KafkaJS:${namespace}] ${message}`,
      extra
    });
  };
};

/**
 * Client factory returning the configured Kafka client singleton.
 * Configures SSL and SASL credentials for Upstash when provided,
 * allowing fallback to local credentials without code changes.
 */
function getKafkaClient() {
  if (kafkaClientInstance) {
    return kafkaClientInstance;
  }

  const brokersStr = process.env.KAFKA_BROKERS;
  const username = process.env.KAFKA_USERNAME;
  const password = process.env.KAFKA_PASSWORD;
  const clientId = process.env.KAFKA_CLIENT_ID || 'notifyflow';

  if (!brokersStr) {
    throw new Error('KAFKA_BROKERS environment variable is not defined.');
  }

  const brokers = brokersStr.split(',').map(b => b.trim());

  const config = {
    clientId,
    brokers,
    logCreator: winstonLogCreator
  };

  // Upstash managed Kafka setup requires SASL/SSL credentials
  if (username && password) {
    config.ssl = true;
    config.sasl = {
      mechanism: 'scram-sha-256',
      username,
      password
    };
  }

  kafkaClientInstance = new Kafka(config);
  logger.info('Kafka client successfully initialized', { brokers, clientId });
  return kafkaClientInstance;
}

/**
 * Returns the Kafka producer singleton.
 * Reuses a single producer instance per process, handling initial connection.
 */
async function getKafkaProducer() {
  if (kafkaProducerInstance) {
    return kafkaProducerInstance;
  }

  const kafka = getKafkaClient();
  const producer = kafka.producer();

  logger.info('Connecting Kafka producer...');
  await producer.connect();
  logger.info('Kafka producer connected successfully');

  kafkaProducerInstance = producer;
  return kafkaProducerInstance;
}

module.exports = {
  TOPICS,
  CONSUMER_GROUPS,
  getKafkaClient,
  getKafkaProducer
};
