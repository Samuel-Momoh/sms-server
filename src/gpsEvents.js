'use strict';

const EventEmitter = require('events');

/**
 * Global Event Emitter for GPS Tracker events.
 * Bridges the TCP server with WebSockets, Webhooks, and HTTP API consumers.
 */
class GpsEventEmitter extends EventEmitter {}

const gpsEventEmitter = new GpsEventEmitter();

// Increase max listeners for multiple WebSocket client rooms and internal handlers
gpsEventEmitter.setMaxListeners(100);

module.exports = { gpsEventEmitter };
