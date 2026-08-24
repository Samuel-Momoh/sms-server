const EventEmitter = require('events');

/**
 * Simple structured logger — outputs timestamped JSON lines
 * and keeps a circular in-memory buffer for real-time admin streaming.
 */

const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(50);

const MAX_LOG_BUFFER = 1000;
const logBuffer = [];

function timestamp() {
  return new Date().toISOString();
}

function log(level, event, data = {}) {
  // Mask sensitive fields before printing or storing
  const safe = { ...data };
  if (safe.password) safe.password = '***';
  if (safe.apiKey)   safe.apiKey   = safe.apiKey.slice(0, 8) + '...';

  const entry = {
    id: `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    ts: timestamp(),
    level,
    event,
    ...safe,
  };

  // 1. Output to console
  console.log(JSON.stringify(entry));

  // 2. Add to in-memory circular buffer
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) {
    logBuffer.shift();
  }

  // 3. Emit event for WebSocket / real-time listeners
  try {
    logEmitter.emit('log', entry);
  } catch (_) {}

  return entry;
}

const logger = {
  info:  (event, data) => log('INFO',  event, data),
  warn:  (event, data) => log('WARN',  event, data),
  error: (event, data) => log('ERROR', event, data),
  debug: (event, data) => log('DEBUG', event, data),
};

function getRecentLogs(limit = 200, filterLevel = null) {
  let list = logBuffer;
  if (filterLevel && filterLevel !== 'ALL') {
    const lvl = filterLevel.toUpperCase();
    list = list.filter(l => l.level === lvl);
  }
  return list.slice(-limit);
}

function clearRecentLogs() {
  logBuffer.length = 0;
  return true;
}

module.exports = {
  logger,
  logEmitter,
  getRecentLogs,
  clearRecentLogs,
};

