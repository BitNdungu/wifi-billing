const { createClient } = require('redis');
const logger = require('../utils/logger');

let client;

const getClient = async () => {
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });

    client.on('error', (err) => {
      logger.error('Redis client error', { error: err.message });
    });

    client.on('connect', () => {
      logger.info('Redis connected');
    });

    client.on('reconnecting', () => {
      logger.warn('Redis reconnecting...');
    });

    await client.connect();
  }
  return client;
};

const set = async (key, value, ttlSeconds = null) => {
  const c = await getClient();
  const serialized = JSON.stringify(value);
  if (ttlSeconds) {
    await c.setEx(key, ttlSeconds, serialized);
  } else {
    await c.set(key, serialized);
  }
};

const get = async (key) => {
  const c = await getClient();
  const val = await c.get(key);
  return val ? JSON.parse(val) : null;
};

const del = async (key) => {
  const c = await getClient();
  await c.del(key);
};

const exists = async (key) => {
  const c = await getClient();
  return (await c.exists(key)) === 1;
};

const increment = async (key, ttlSeconds = null) => {
  const c = await getClient();
  const count = await c.incr(key);
  if (ttlSeconds && count === 1) {
    await c.expire(key, ttlSeconds);
  }
  return count;
};

module.exports = { getClient, set, get, del, exists, increment };