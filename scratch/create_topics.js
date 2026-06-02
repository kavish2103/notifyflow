const { getKafkaClient } = require('../shared/kafka');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function createTopics() {
  const kafka = getKafkaClient();
  const admin = kafka.admin();

  try {
    console.log('Connecting Kafka Admin client...');
    await admin.connect();
    console.log('Successfully connected to Kafka Broker!');

    const topicsToCreate = [
      { topic: 'notifyflow.events.v1', numPartitions: 1, replicationFactor: 1 },
      { topic: 'notifyflow.retry.v1', numPartitions: 1, replicationFactor: 1 },
      { topic: 'notifyflow.dlq.v1', numPartitions: 1, replicationFactor: 1 }
    ];

    console.log('Creating standard NotifyFlow Kafka topics...', topicsToCreate.map(t => t.topic));
    const created = await admin.createTopics({
      topics: topicsToCreate,
      waitForLeaders: true
    });

    if (created) {
      console.log('NotifyFlow Kafka topics successfully created!');
    } else {
      console.log('Topics already exist or creation skipped.');
    }
  } catch (err) {
    console.error('Failed to create Kafka topics:', err.message);
  } finally {
    await admin.disconnect();
    console.log('Kafka Admin disconnected.');
  }
}

createTopics();
