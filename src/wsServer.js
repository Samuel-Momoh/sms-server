'use strict';

const { Server } = require('socket.io');
const { gpsEventEmitter } = require('./gpsEvents');
const { logger } = require('./logger');

let ioInstance = null;

/**
 * Initialize Socket.IO on the HTTP server.
 *
 * Rooms:
 *   - Room by IMEI: `socket.join(imei)` receives events ONLY for that specific IMEI.
 *   - Room 'all': `socket.join('all')` or `socket.join('admin')` receives all events across all devices.
 *
 * @param {import('http').Server} httpServer
 * @returns {import('socket.io').Server}
 */
function initWebSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  ioInstance = io;

  io.on('connection', (socket) => {
    logger.info('WS_CLIENT_CONNECTED', {
      socketId: socket.id,
      remote:   socket.handshake.address,
    });

    // Client requests to subscribe to a specific device by IMEI
    socket.on('join', (data) => {
      const imei = typeof data === 'string' ? data.trim() : data?.imei?.trim();
      if (imei) {
        socket.join(imei);
        logger.info('WS_ROOM_JOINED', { socketId: socket.id, room: imei });
        socket.emit('joined', { room: imei, success: true, message: `Subscribed to device ${imei}` });
      }
    });

    // Client requests to subscribe to all devices (admin dashboard)
    socket.on('join_all', () => {
      socket.join('all');
      logger.info('WS_ROOM_JOINED', { socketId: socket.id, room: 'all' });
      socket.emit('joined', { room: 'all', success: true, message: 'Subscribed to all devices' });
    });

    // Client unsubscribes from a device room
    socket.on('leave', (data) => {
      const imei = typeof data === 'string' ? data.trim() : data?.imei?.trim();
      if (imei) {
        socket.leave(imei);
        logger.info('WS_ROOM_LEFT', { socketId: socket.id, room: imei });
        socket.emit('left', { room: imei, success: true });
      }
    });

    socket.on('disconnect', (reason) => {
      logger.info('WS_CLIENT_DISCONNECTED', { socketId: socket.id, reason });
    });
  });

  // ── Forward events from GPS Event Emitter to Socket.io Rooms ────────────────
  const forwardEvent = (eventName) => {
    gpsEventEmitter.on(eventName, (payload) => {
      const imei = payload.imei;
      // Broadcast to device-specific room
      if (imei) {
        io.to(imei).emit(eventName, payload);
      }
      // Broadcast to admin room for all devices
      io.to('all').emit(eventName, payload);
    });
  };

  const EVENTS_TO_FORWARD = [
    'gps:update',
    'gps:heartbeat',
    'gps:login',
    'gps:lbs',
    'gps:confirm',
    'gps:connected',
    'gps:disconnected',
    'gps:reconnected',
    'gps:ack_sent',
    'gps:command_sent',
    'gps:raw',
  ];

  EVENTS_TO_FORWARD.forEach(forwardEvent);

  // ── Forward server console & TCP structured logs to Admin WebSocket clients ─
  const { logEmitter } = require('./logger');
  logEmitter.on('log', (logEntry) => {
    io.to('all').emit('server:log', logEntry);
    io.to('logs').emit('server:log', logEntry);
  });

  logger.info('WS_SERVER_INITIALIZED', {
    message: 'Socket.IO real-time server ready for admin web app clients',
  });

  return io;
}

function getSocketIo() {
  return ioInstance;
}

module.exports = {
  initWebSocketServer,
  getSocketIo,
};
