/**
 * Simple structured logger — outputs timestamped JSON lines
 * so Render's log viewer (and any log aggregator) can parse them easily.
 */

function timestamp() {
  return new Date().toISOString();
}

function log(level, event, data = {}) {
  // Mask sensitive fields before printing
  const safe = { ...data };
  if (safe.password) safe.password = '***';
  if (safe.apiKey)   safe.apiKey   = safe.apiKey.slice(0, 8) + '...';

  console.log(JSON.stringify({ ts: timestamp(), level, event, ...safe }));
}

const logger = {
  info:  (event, data) => log('INFO',  event, data),
  warn:  (event, data) => log('WARN',  event, data),
  error: (event, data) => log('ERROR', event, data),
};

module.exports = { logger };
