const Redis = require('ioredis');
const { logger } = require('../logger');

let redisClient = null;
let isConnected = false;

// In-memory fallback queue if Redis is not running
const memoryQueue = new Map();

/**
 * Initialize Redis connection with fallback to in-memory store.
 */
function initRedis() {
  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const password = process.env.REDIS_PASSWORD || undefined;
  const db = parseInt(process.env.REDIS_DB || '0', 10);

  try {
    redisClient = new Redis({
      host,
      port,
      password: password || undefined,
      db,
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => {
        const delay = Math.min(times * 1000, 10000);
        return delay;
      },
      enableOfflineQueue: true,
    });

    redisClient.on('connect', () => {
      isConnected = true;
      logger.info('REDIS_CONNECTED', {
        host,
        port,
        db,
        message: 'Redis connection established.',
      });
    });

    redisClient.on('ready', () => {
      isConnected = true;
      logger.info('REDIS_READY', { message: 'Redis client ready to handle operations.' });
    });

    redisClient.on('error', (err) => {
      isConnected = false;
      logger.warn('REDIS_ERROR', {
        error: err.message,
        message: 'Redis connection failed. Using in-memory fallback queue.',
      });
    });

    redisClient.on('close', () => {
      isConnected = false;
    });

    return redisClient;
  } catch (err) {
    isConnected = false;
    logger.warn('REDIS_INIT_FAILED', {
      error: err.message,
      message: 'Failed to initialize Redis. Operating with in-memory queue fallback.',
    });
    return null;
  }
}

/**
 * Push an item to a list/queue (FIFO: rpush).
 */
async function pushQueue(key, item) {
  const serialized = JSON.stringify(item);
  if (redisClient && isConnected) {
    try {
      await redisClient.rpush(key, serialized);
      return true;
    } catch (err) {
      logger.warn('REDIS_PUSH_FAILED', { key, error: err.message });
    }
  }

  // In-memory fallback
  if (!memoryQueue.has(key)) {
    memoryQueue.set(key, []);
  }
  memoryQueue.get(key).push(serialized);
  return true;
}

/**
 * Pop the next item from a queue (FIFO: lpop).
 */
async function popQueue(key) {
  if (redisClient && isConnected) {
    try {
      const data = await redisClient.lpop(key);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      logger.warn('REDIS_POP_FAILED', { key, error: err.message });
    }
  }

  // In-memory fallback
  const list = memoryQueue.get(key);
  if (list && list.length > 0) {
    const data = list.shift();
    return data ? JSON.parse(data) : null;
  }
  return null;
}

/**
 * Get all items from a queue without removing them.
 */
async function getQueueItems(key) {
  if (redisClient && isConnected) {
    try {
      const items = await redisClient.lrange(key, 0, -1);
      return items.map((raw) => {
        try {
          return JSON.parse(raw);
        } catch (_) {
          return raw;
        }
      });
    } catch (err) {
      logger.warn('REDIS_LRANGE_FAILED', { key, error: err.message });
    }
  }

  // In-memory fallback
  const list = memoryQueue.get(key) || [];
  return list.map((raw) => {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return raw;
    }
  });
}

/**
 * Remove a specific item from a queue by commandId.
 */
async function removeQueueItem(key, commandId) {
  if (!key || !commandId) return false;

  if (redisClient && isConnected) {
    try {
      const items = await redisClient.lrange(key, 0, -1);
      for (const raw of items) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.commandId === commandId) {
            await redisClient.lrem(key, 1, raw);
            return true;
          }
        } catch (_) {}
      }
    } catch (err) {
      logger.warn('REDIS_LREM_FAILED', { key, commandId, error: err.message });
    }
  }

  // In-memory fallback
  const list = memoryQueue.get(key);
  if (list) {
    const idx = list.findIndex((raw) => {
      try {
        const parsed = JSON.parse(raw);
        return parsed.commandId === commandId;
      } catch (_) {
        return false;
      }
    });
    if (idx !== -1) {
      list.splice(idx, 1);
      return true;
    }
  }
  return false;
}

/**
 * Delete all items in a queue.
 */
async function clearQueueKey(key) {
  if (redisClient && isConnected) {
    try {
      await redisClient.del(key);
    } catch (err) {
      logger.warn('REDIS_DEL_FAILED', { key, error: err.message });
    }
  }
  memoryQueue.delete(key);
  return true;
}

module.exports = {
  initRedis,
  pushQueue,
  popQueue,
  getQueueItems,
  removeQueueItem,
  clearQueueKey,
  isRedisConnected: () => isConnected,
  getRedisClient: () => redisClient,
};
