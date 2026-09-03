'use strict';

const { Server } = require('socket.io');
const { gpsEventEmitter } = require('./gpsEvents');
const { verifyToken } = require('./adminAuth');
const { getDeviceState } = require('./gt06Server');
const { getDeviceByImei, getDevicesByUser } = require('./db/mysql');
const { logger } = require('./logger');

let ioInstance = null;

/**
 * Check if the user has access to a specific device IMEI.
 */
async function checkDeviceAccess(imei, user) {
  if (!imei || !user) return false;
  if (user.role === 'admin') return true;

  const targetImei = String(imei).trim();

  // 1. Check in-memory device state
  const memState = getDeviceState(targetImei);
  if (memState && memState.userId && String(memState.userId) === String(user.id)) {
    return true;
  }

  // 2. Check MySQL database record
  try {
    const dbDevice = await getDeviceByImei(targetImei);
    if (dbDevice && dbDevice.user_id && String(dbDevice.user_id) === String(user.id)) {
      return true;
    }
  } catch (_) {}

  return false;
}

/**
 * Initialize Socket.IO on the HTTP server with role-based room access control.
 *
 * Security & Access Rules:
 *   - Admin: Can join 'all' room (all fleet updates), 'logs' room (server logs), or any device room.
 *   - User: Can ONLY join rooms for devices registered to their user ID. Attempting to join 'all' or other IMEIs is rejected.
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

  // ── Authentication Middleware for WebSocket Connections ─────────────────────
  io.use((socket, next) => {
    const rawAuth = socket.handshake.auth?.token ||
                    socket.handshake.headers?.authorization ||
                    socket.handshake.query?.token;

    const adminUser = process.env.ADMIN_USER || process.env.GATEWAY_USERNAME || 'momohofficial@gmail.com';
    const adminPwd  = process.env.ADMIN_PWD  || process.env.GATEWAY_PASSWORD || '@Samuel196';

    if (rawAuth) {
      const token = rawAuth.startsWith('Bearer ') ? rawAuth.substring(7).trim() : rawAuth.trim();
      const decoded = verifyToken(token);
      if (decoded) {
        socket.user = decoded;
        return next();
      }

      if (token === adminPwd || token === `${adminUser}:${adminPwd}`) {
        socket.user = { username: adminUser, role: 'admin' };
        return next();
      }
    }

    // Allow unauthenticated connection with null user (will only be able to join public rooms if any)
    socket.user = null;
    next();
  });

  io.on('connection', async (socket) => {
    logger.info('WS_CLIENT_CONNECTED', {
      socketId: socket.id,
      remote: socket.handshake.address,
      user: socket.user?.username || 'anonymous',
      role: socket.user?.role || 'none',
    });

    // If a regular user connects with authenticated token, auto-join their owned devices
    if (socket.user && socket.user.role === 'user' && socket.user.id) {
      try {
        const userDevices = await getDevicesByUser(socket.user.id);
        for (const dev of userDevices) {
          if (dev.imei) {
            socket.join(String(dev.imei));
          }
        }
      } catch (_) {}
    }

    // ── Client requests to subscribe to a specific device by IMEI ───────────
    socket.on('join', async (data) => {
      const imei = typeof data === 'string' ? data.trim() : data?.imei?.trim();
      if (!imei) {
        return socket.emit('error', { message: 'IMEI is required to join room' });
      }

      // Check permissions: Admin can join any, user can only join their own
      const hasAccess = socket.user?.role === 'admin' || (await checkDeviceAccess(imei, socket.user));

      if (!hasAccess) {
        logger.warn('WS_JOIN_DENIED', {
          socketId: socket.id,
          imei,
          user: socket.user?.username,
          role: socket.user?.role,
        });
        return socket.emit('error', {
          success: false,
          error: `Forbidden: You do not have permission to subscribe to device ${imei}`,
        });
      }

      socket.join(imei);
      logger.info('WS_ROOM_JOINED', { socketId: socket.id, room: imei });
      socket.emit('joined', { room: imei, success: true, message: `Subscribed to device ${imei}` });
    });

    // ── Client requests to subscribe to all devices (Admin Only) ────────────
    socket.on('join_all', () => {
      if (!socket.user || socket.user.role !== 'admin') {
        logger.warn('WS_JOIN_ALL_DENIED', {
          socketId: socket.id,
          user: socket.user?.username,
          role: socket.user?.role,
        });
        return socket.emit('error', {
          success: false,
          error: 'Forbidden: Admin privilege required to subscribe to all device updates',
        });
      }

      socket.join('all');
      logger.info('WS_ROOM_JOINED', { socketId: socket.id, room: 'all' });
      socket.emit('joined', { room: 'all', success: true, message: 'Subscribed to all devices' });
    });

    // ── Client requests to subscribe to server logs (Admin Only) ────────────
    socket.on('join_logs', () => {
      if (!socket.user || socket.user.role !== 'admin') {
        return socket.emit('error', {
          success: false,
          error: 'Forbidden: Admin privilege required to stream server logs',
        });
      }

      socket.join('logs');
      logger.info('WS_ROOM_JOINED', { socketId: socket.id, room: 'logs' });
      socket.emit('joined', { room: 'logs', success: true, message: 'Subscribed to server logs' });
    });

    // ── Client unsubscribes from a device room ──────────────────────────────
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
      // 1. Broadcast to device-specific room (received by device owner & subscribed admins)
      if (imei) {
        io.to(imei).emit(eventName, payload);
      }
      // 2. Broadcast to admin room for global fleet monitoring
      io.to('all').emit(eventName, payload);
    });
  };

  const EVENTS_TO_FORWARD = [
    'gps:update',
    'gps:alarm',
    'gps:heartbeat',
    'gps:login',
    'gps:lbs',
    'gps:confirm',
    'gps:connected',
    'gps:disconnected',
    'gps:reconnected',
    'gps:ack_sent',
    'gps:command_sent',
    'gps:command_queued',
    'gps:command_dispatched',
    'gps:command_cancelled',
    'gps:queue_cleared',
    'gps:device_deleted',
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
    message: 'Socket.IO real-time server ready with role-based subscription security',
  });

  return io;
}

function getSocketIo() {
  return ioInstance;
}

module.exports = {
  initWebSocketServer,
  getSocketIo,
  checkDeviceAccess,
};
