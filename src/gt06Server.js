'use strict';

/**
 * GT06 GPS Tracker TCP Server
 *
 * Handles the binary GT06 protocol used by Secumore and compatible GPS
 * trackers. Runs on a separate TCP port from the HTTP/SMS gateway.
 *
 * Supported packet types:
 *   0x01 – Login        (responds with ACK)
 *   0x12 – GPS Location (decoded and logged)
 *   0x22 – GPS Location (alternate protocol variant, decoded and logged)
 *   0x13 – Heartbeat   (responds with ACK)
 */

const net        = require('net');
const { logger } = require('./logger');

// ── CRC-ITU / XModem ─────────────────────────────────────────────────────────

/**
 * CRC-16/CCITT-FALSE (XModem) — required by the GT06 protocol.
 * @param {Buffer} buffer
 * @returns {number} 16-bit CRC value
 */
function crc16(buffer) {
  let crc = 0x0000;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= (buffer[i] << 8);
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc;
}

// ── ACK Builder ───────────────────────────────────────────────────────────────

/**
 * Build a standard GT06 ACK response packet.
 *
 * Structure:
 *   0x78 0x78 | length(1) | protocol(1) | serialNo(2) | CRC(2) | 0x0D 0x0A
 *
 * @param {number} protocolNumber  – Protocol byte from the incoming packet
 * @param {Buffer} serialNoBuffer  – 2-byte serial number extracted from the packet
 * @returns {Buffer} Fully encoded GT06 ACK frame
 */
function buildAck(protocolNumber, serialNoBuffer) {
  // Length byte covers: protocol(1) + serialNo(2) = 3 bytes → 0x05 total
  const header  = Buffer.from([0x78, 0x78, 0x05, protocolNumber]);
  const payload = Buffer.concat([header.subarray(2), serialNoBuffer]);

  const crcVal = crc16(payload);
  const crcBuf = Buffer.alloc(2);
  crcBuf.writeUInt16BE(crcVal, 0);

  const stop = Buffer.from([0x0D, 0x0A]);
  return Buffer.concat([Buffer.from([0x78, 0x78]), payload, crcBuf, stop]);
}

// ── Packet Handlers ───────────────────────────────────────────────────────────

/**
 * Handle a Login packet (protocol 0x01).
 * Extracts the IMEI / Terminal ID and sends back an ACK.
 */
function handleLogin(socket, data) {
  const imeiRaw  = data.subarray(4, 12).toString('hex');
  const serialNo = data.subarray(data.length - 6, data.length - 4);

  logger.info('GT06_LOGIN', {
    remote:  `${socket.remoteAddress}:${socket.remotePort}`,
    imeiHex: imeiRaw,
  });

  const ack = buildAck(0x01, serialNo);
  socket.write(ack);

  logger.info('GT06_ACK_SENT', {
    protocol: '0x01 (login)',
    remote:   `${socket.remoteAddress}:${socket.remotePort}`,
  });
}

/**
 * Handle a GPS Location packet (protocol 0x12 or 0x22).
 * Decodes timestamp, coordinates, speed and heading flags; logs the fix.
 */
function handleLocation(socket, data, protocolNumber) {
  // Timestamp (bytes 4-9: YY MM DD HH MM SS)
  const year   = data[4];
  const month  = data[5];
  const day    = data[6];
  const hour   = data[7];
  const minute = data[8];
  const second = data[9];

  // Lat / Lon (bytes 11-18, UInt32BE divided by 1,800,000)
  const rawLat = data.readUInt32BE(11);
  const rawLon = data.readUInt32BE(15);
  let lat = rawLat / 1800000.0;
  let lon = rawLon / 1800000.0;

  // Speed & Course/Status word
  const speed        = data[19];
  const courseStatus = data.readUInt16BE(20);

  const isGpsRealtime = (courseStatus & 0x1000) !== 0;
  const isWestLon     = (courseStatus & 0x0800) !== 0;
  const isSouthLat    = (courseStatus & 0x0400) === 0;

  if (isSouthLat) lat = -lat;
  if (isWestLon)  lon = -lon;

  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `20${pad(year)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)} UTC`;

  logger.info('GT06_GPS_UPDATE', {
    remote:    `${socket.remoteAddress}:${socket.remotePort}`,
    protocol:  `0x${protocolNumber.toString(16).toUpperCase()}`,
    lat:       lat.toFixed(6),
    lon:       lon.toFixed(6),
    speed_kmh: speed,
    gpsFixed:  isGpsRealtime,
    timestamp,
  });
}

/**
 * Handle a Heartbeat / Status packet (protocol 0x13).
 * Sends back an ACK to keep the tracker session alive.
 */
function handleHeartbeat(socket, data) {
  const serialNo = data.subarray(data.length - 6, data.length - 4);
  const ack      = buildAck(0x13, serialNo);
  socket.write(ack);

  logger.info('GT06_ACK_SENT', {
    protocol: '0x13 (heartbeat)',
    remote:   `${socket.remoteAddress}:${socket.remotePort}`,
  });
}

// ── Packet Dispatcher ─────────────────────────────────────────────────────────

/**
 * Route a raw incoming buffer to the appropriate handler.
 * Validates the GT06 start-bytes (0x78 0x78) before dispatching.
 */
function handlePacket(socket, data) {
  logger.info('GT06_RAW', {
    remote: `${socket.remoteAddress}:${socket.remotePort}`,
    hex:    data.toString('hex'),
  });

  // GT06 frames always start with 0x78 0x78
  if (data[0] !== 0x78 || data[1] !== 0x78) {
    logger.warn('GT06_INVALID_START_BYTES', {
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
      hex:    data.subarray(0, 4).toString('hex'),
    });
    return;
  }

  const protocolNumber = data[3];

  switch (protocolNumber) {
    case 0x01:              // Login
      handleLogin(socket, data);
      break;

    case 0x12:              // GPS location (standard)
    case 0x22:              // GPS location (extended variant)
      handleLocation(socket, data, protocolNumber);
      break;

    case 0x13:              // Heartbeat / Status
      handleHeartbeat(socket, data);
      break;

    default:
      logger.warn('GT06_UNKNOWN_PROTOCOL', {
        remote:   `${socket.remoteAddress}:${socket.remotePort}`,
        protocol: `0x${protocolNumber.toString(16).toUpperCase()}`,
        hex:      data.toString('hex'),
      });
  }
}

// ── Server Factory ────────────────────────────────────────────────────────────

/**
 * Create and start the GT06 TCP server.
 *
 * @param {number} [port]  – TCP port (default: GT06_PORT env var or 5022)
 * @returns {net.Server}
 */
function createGt06Server(port) {
  const GT06_PORT = port || parseInt(process.env.GT06_PORT, 10) || 5022;

  const server = net.createServer((socket) => {
    logger.info('GT06_DEVICE_CONNECTED', {
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
    });

    // Accumulation buffer — guards against TCP fragmentation / multi-frame bursts
    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Process all complete GT06 frames present in the buffer
      while (buffer.length >= 4) {
        if (buffer[0] !== 0x78 || buffer[1] !== 0x78) {
          // Lost frame sync — discard and wait for next connection
          logger.warn('GT06_RESYNC', {
            remote: `${socket.remoteAddress}:${socket.remotePort}`,
          });
          buffer = Buffer.alloc(0);
          break;
        }

        // Total frame size: start(2) + length(1) + <length-byte value> bytes + stop(2)
        // The length byte itself describes bytes from protocol through serial number.
        // A complete frame is: 0x78 0x78 | length | ...length bytes... | CRC(2) | 0x0D 0x0A
        const frameLength = buffer[2] + 5;

        if (buffer.length < frameLength) {
          break; // Incomplete frame — wait for more data
        }

        const frame = buffer.subarray(0, frameLength);
        buffer      = buffer.subarray(frameLength);

        handlePacket(socket, frame);
      }
    });

    socket.on('close', () => {
      logger.info('GT06_DEVICE_DISCONNECTED', {
        remote: `${socket.remoteAddress}:${socket.remotePort}`,
      });
    });

    socket.on('error', (err) => {
      logger.error('GT06_SOCKET_ERROR', {
        remote:  `${socket.remoteAddress}:${socket.remotePort}`,
        message: err.message,
      });
    });
  });

  server.listen(GT06_PORT, '0.0.0.0', () => {
    logger.info('GT06_SERVER_STARTED', {
      port:    GT06_PORT,
      message: `GT06 GPS tracker server listening on TCP port ${GT06_PORT}`,
    });
  });

  server.on('error', (err) => {
    logger.error('GT06_SERVER_ERROR', { message: err.message });
  });

  return server;
}

module.exports = { createGt06Server };
