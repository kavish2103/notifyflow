const { Pool } = require('pg');
const { logger } = require('@notifyflow/logger');

let pool = null;

/**
 * Returns the configured PostgreSQL client pool singleton.
 * Configures connection pooling limits specifically designed for high-performance throughput.
 */
function getDbPool() {
  if (pool) {
    return pool;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not defined in the environment variables.');
  }

  pool = new Pool({
    connectionString,
    max: 5, // Keep database pool size tiny for channel workers
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
  });

  pool.on('error', (err) => {
    logger.error('Email Worker Service PostgreSQL connection pool encountered an error', { 
      error: err.message, 
      stack: err.stack 
    });
  });

  return pool;
}

module.exports = {
  getDbPool
};
