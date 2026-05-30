require('dotenv').config();
const { getKafkaClient, TOPICS } = require('@notifyflow/kafka');
const { logger } = require('@notifyflow/logger');

async function runConsumer() {
  logger.info('Starting test verification consumer...');
  
  // Initialize our shared Kafka client singleton
  const kafka = getKafkaClient();
  
  // Create a randomized temporary consumer group to read fresh offsets
  const consumer = kafka.consumer({ 
    groupId: 'test-verification-group-' + Date.now() 
  });
  
  logger.info('Connecting to Kafka brokers...');
  await consumer.connect();
  logger.info('Kafka consumer connected successfully.');
  
  logger.info(`Subscribing to topic: ${TOPICS.EVENTS}...`);
  await consumer.subscribe({ 
    topic: TOPICS.EVENTS, 
    fromBeginning: true 
  });
  
  logger.info('Listening for events...');
  
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      // Decode binary payload
      const payload = JSON.parse(message.value.toString());
      
      console.log('\n\x1b[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('=== KAFKA CONSUMED EVENT RETRIEVED SUCCESSFULLY ===');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
      console.log(`Topic:      ${topic}`);
      console.log(`Partition:  ${partition}`);
      console.log(`User Key:   ${message.key ? message.key.toString() : 'null'}`);
      console.log('Enriched Envelope:', JSON.stringify(payload, null, 2));
      console.log('\x1b[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\x1b[0m');
      
      // Shut down immediately after retrieving the test message
      logger.info('E2E verification completed. Terminating test consumer...');
      setTimeout(async () => {
        await consumer.disconnect();
        process.exit(0);
      }, 500);
    }
  });
}

runConsumer().catch((err) => {
  console.error('Test consumer encountered a failure:', err.message);
  process.exit(1);
});
