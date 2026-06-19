const { Pool } = require('pg');
const logger = require('../utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  min: parseInt(process.env.DB_POOL_MIN) || 2,
  max: parseInt(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', () => {
  logger.debug('New database connection established');
});

pool.on('error', (err) => {
  logger.error('Unexpected database pool error', { error: err.message });
});

/**
 * Execute a query with optional parameters
 */
const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn('Slow query detected', { text: text.slice(0, 100), duration });
    }
    return result;
  } catch (error) {
    logger.error('Database query error', { error: error.message, query: text.slice(0, 100) });
    throw error;
  }
};

/**
 * Get a client from the pool for transactions
 */
const getClient = () => pool.connect();

/**
 * Run a function inside a transaction
 */
const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Health check
 */
const healthCheck = async () => {
  const result = await pool.query('SELECT NOW() as time, version() as version');
  return result.rows[0];
};

module.exports = { query, getClient, withTransaction, healthCheck, pool };