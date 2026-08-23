'use strict';

/**
 * GPS Tracker TCP Server
 *
 * Supports two protocols on the same TCP port (default 5022):
 *
 *   GT06  – Binary protocol, frames start with 0x78 0x78
 *   HQ    – ASCII protocol (H02/A3/Secumore), messages start with *HQ,
 *
 * Protocol is auto-detected per TCP connection from the first bytes received.
 * A single connection always uses one protocol for its lifetime.
 *
 * Environment variables:
 *   GT06_PORT       TCP port to listen on            (default: 5022)
 *   GPS_RAW_DEBUG   Log raw bytes / ASCII messages   (default: false)
 */

const net        = require('net');
const { logger } = require('./logger');

// Dynamic flag checker for raw debugging
const isRawDebug = () => process.env.GPS_RAW_DEBUG === 'true';

// ── Device registry: IMEI → socket ───────────────────────────────────────────
// Lets us push commands or track active connections by IMEI
const deviceRegistry = new Map();

// Helper to convert V1 packet's HHMMSS into YYYYMMDDHHMMSS using today's UTC date
function formatV1Timestamp(timeRaw, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  const mm   = pad(date.getUTCMonth() + 1);
  const dd   = pad(date.getUTCDate());
  const datePart = `${yyyy}${mm}${dd}`;

  if (timeRaw && /^\d{6}$/.test(timeRaw.substring(0, 6))) {
    return `${datePart}${timeRaw.substring(0, 6)}`;
  }

  const hh  = pad(date.getUTCHours());
  const min = pad(date.getUTCMinutes());
  const ss  = pad(date.getUTCSeconds());
  return `${datePart}${hh}${min}${ss}`;
}

// =============================================================================
// GT06 — CRC-16 / CCITT-FALSE (XModem)
// =============================================================================

/**
 * CRC-16/CCITT-FALSE (XModem) calculation required by GT06 protocol.
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

// =============================================================================
// GT06 — ACK Builder
// =============================================================================

/**
 * Build standard GT06 ACK response packet.
 *
 * Wire format:
 *   0x78 0x78 | length(1) | protocol(1) | serialNo(2) | CRC(2) | 0x0D 0x0A
 *
 * @param {number} protocolNumber
 * @param {Buffer} serialNoBuffer  2-byte serial number from incoming packet
 * @returns {Buffer}
 */
function buildAck(protocolNumber, serialNoBuffer) {
  const header  = Buffer.from([0x78, 0x78, 0x05, protocolNumber]);
  const payload = Buffer.concat([header.subarray(2), serialNoBuffer]);
  const crcVal  = crc16(payload);
  const crcBuf  = Buffer.alloc(2);
  crcBuf.writeUInt16BE(crcVal, 0);
  return Buffer.concat([
    Buffer.from([0x78, 0x78]),
    payload,
    crcBuf,
    Buffer.from([0x0D, 0x0A]),
  ]);
}

// =============================================================================
// GT06 — Packet Handlers
// =============================================================================

function handleGt06Login(socket, data) {
  const imeiHex  = data.subarray(4, 12).toString('hex');
  const serialNo = data.subarray(data.length - 6, data.length - 4);

  deviceRegistry.set(imeiHex, socket);

  logger.info('GT06_LOGIN', {
    remote:  `${socket.remoteAddress}:${socket.remotePort}`,
    imeiHex,
  });

  const ack = buildAck(0x01, serialNo);
  socket.write(ack, (err) => {
    if (err) {
      logger.error('GT06_WRITE_ERROR', {
        remote:  `${socket.remoteAddress}:${socket.remotePort}`,
        message: err.message,
      });
    }
  });

  logger.info('GT06_ACK_SENT', {
    protocol: '0x01 (login)',
    remote:   `${socket.remoteAddress}:${socket.remotePort}`,
  });
}

function handleGt06Location(socket, data, protocolNumber) {
  const year   = data[4];
  const month  = data[5];
  const day    = data[6];
  const hour   = data[7];
  const minute = data[8];
  const second = data[9];

  const rawLat = data.readUInt32BE(11);
  const rawLon = data.readUInt32BE(15);
  let lat = rawLat / 1800000.0;
  let lon = rawLon / 1800000.0;

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
    lat:       parseFloat(lat.toFixed(6)),
    lon:       parseFloat(lon.toFixed(6)),
    speed_kmh: speed,
    gpsFixed:  isGpsRealtime,
    timestamp,
  });
}

function handleGt06Heartbeat(socket, data) {
  const serialNo = data.subarray(data.length - 6, data.length - 4);
  const ack      = buildAck(0x13, serialNo);
  socket.write(ack, (err) => {
    if (err) {
      logger.error('GT06_WRITE_ERROR', {
        remote:  `${socket.remoteAddress}:${socket.remotePort}`,
        message: err.message,
      });
    }
  });

  logger.info('GT06_ACK_SENT', {
    protocol: '0x13 (heartbeat)',
    remote:   `${socket.remoteAddress}:${socket.remotePort}`,
  });
}

function handleGt06Packet(socket, frame) {
  if (isRawDebug()) {
    logger.info('GT06_RAW', {
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
      hex:    frame.toString('hex'),
    });
  }

  if (frame[0] !== 0x78 || frame[1] !== 0x78) {
    logger.warn('GT06_INVALID_START_BYTES', {
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
      hex:    frame.subarray(0, 4).toString('hex'),
    });
    return;
  }

  const protocolNumber = frame[3];

  switch (protocolNumber) {
    case 0x01: handleGt06Login(socket, frame);                    break;
    case 0x12:
    case 0x22: handleGt06Location(socket, frame, protocolNumber); break;
    case 0x13: handleGt06Heartbeat(socket, frame);                break;
    default:
      logger.warn('GT06_UNKNOWN_PROTOCOL', {
        remote:   `${socket.remoteAddress}:${socket.remotePort}`,
        protocol: `0x${protocolNumber.toString(16).toUpperCase()}`,
        hex:      frame.toString('hex'),
      });
  }
}

// =============================================================================
// HQ — Coordinate Conversion (DDMM.MMMM / DDDMM.MMMM -> Decimal Degrees)
// =============================================================================

/**
 * Convert NMEA coordinate string to decimal degrees.
 *
 * The decimal point is always preceded by exactly 2 minute digits:
 *   "0453.2956", "N"  -> 04 deg + 53.2956/60 = 4.888260
 *   "00654.7924", "E" -> 006 deg + 54.7924/60 = 6.913207
 *
 * @param {string} nmea       Raw NMEA coordinate string
 * @param {string} hemisphere 'N' | 'S' | 'E' | 'W'
 * @returns {number} Decimal degrees (negative for S / W)
 */
function nmeaToDecimal(nmea, hemisphere) {
  if (!nmea || typeof nmea !== 'string') return NaN;
  const dotIdx = nmea.indexOf('.');
  if (dotIdx < 2) return NaN;

  const degreesStr = nmea.substring(0, dotIdx - 2);
  const minutesStr = nmea.substring(dotIdx - 2);

  const degrees = parseFloat(degreesStr);
  const minutes = parseFloat(minutesStr);

  if (isNaN(degrees) || isNaN(minutes)) return NaN;

  let decimal = degrees + (minutes / 60.0);
  const hemi = (hemisphere || '').toUpperCase();
  if (hemi === 'S' || hemi === 'W') {
    decimal = -decimal;
  }

  return decimal;
}

// =============================================================================
// HQ / H02 / A3 — ACK Builder
// =============================================================================

/**
 * Build HQ / H02 / A3 protocol ACK response packet.
 *
 * Formats:
 *   - V1 GPS confirmation (V4): *HQ,<IMEI>,V4,V1,<YYYYMMDDHHMMSS>#\r\n
 *   - V0 Login confirmation:    *HQ,<IMEI>,V0#\r\n
 *   - Heartbeat confirmation:   *HQ,<IMEI>,HTBT#\r\n
 *
 * @param {string} imei         Device IMEI / ID
 * @param {string} cmd          Command being acknowledged ('V1', 'V0', 'HTBT')
 * @param {string} [timestamp]  YYYYMMDDHHMMSS timestamp (derived from packet HHMMSS + UTC date)
 * @returns {string}
 */
function buildHqAck(imei, cmd, timestamp) {
  if (cmd === 'V1') {
    const ts = timestamp || formatV1Timestamp();
    return `*HQ,${imei},V4,V1,${ts}#\r\n`;
  }
  if (cmd === 'V0') {
    return `*HQ,${imei},V0#\r\n`;
  }
  if (cmd === 'HTBT') {
    return `*HQ,${imei},HTBT#\r\n`;
  }
  return `*HQ,${imei},${cmd}#\r\n`;
}

// =============================================================================
// HQ — Socket Safe Write Helper
// =============================================================================

/**
 * Sends response to the tracker over TCP, checks write callback/error,
 * and logs the exact ASCII and hex bytes sent.
 *
 * @param {net.Socket} socket
 * @param {string}     imei
 * @param {string}     ackResponse
 */
function sendHqResponse(socket, imei, ackResponse) {
  const hex = Buffer.from(ackResponse).toString('hex');

  socket.write(ackResponse, (err) => {
    if (err) {
      logger.error('HQ_WRITE_ERROR', {
        imei,
        remote:        `${socket.remoteAddress}:${socket.remotePort}`,
        error:         err.message,
        responseAscii: ackResponse,
        responseHex:   hex,
      });
      return;
    }
  });

  logger.info('HQ_ACK_SENT', {
    imei,
    remote:        `${socket.remoteAddress}:${socket.remotePort}`,
    responseAscii: ackResponse,
    responseHex:   hex,
  });
}

// =============================================================================
// HQ — Message Parser (pure function)
// =============================================================================

/**
 * Parse an HQ message string.
 *
 * Handles optional leading '*', trailing '#', '\r', '\n', and trailing commas.
 *
 * @param {string} message
 * @returns {{ imei: string, cmd: string, fields: string[] } | null}
 */
function parseHqMessage(message) {
  if (!message || typeof message !== 'string') return null;

  const clean = message
    .replace(/^\*/, '')
    .replace(/[#\r\n]+$/, '')
    .replace(/,$/, '')
    .trim();

  const parts = clean.split(',');

  if (parts[0] !== 'HQ' || parts.length < 3) return null;

  return {
    imei:   parts[1].trim(),
    cmd:    parts[2].trim(),
    fields: parts.slice(3),
  };
}

// =============================================================================
// HQ — Packet Handlers
// =============================================================================

function handleHqLogin(socket, imei, fields) {
  logger.info('HQ_LOGIN', {
    event:    'HQ_LOGIN',
    protocol: 'HQ',
    imei,
    remote:   `${socket.remoteAddress}:${socket.remotePort}`,
  });

  const ack = buildHqAck(imei, 'V0');
  sendHqResponse(socket, imei, ack);
}

function handleHqGps(socket, imei, fields) {
  // Expected fields after cmd=V1:
  // [0] HHMMSS [1] A/V [2] LAT [3] N/S [4] LON [5] E/W [6] SPEED ...
  const [timeRaw, gpsStatus, latRaw, latHemi, lonRaw, lonHemi, speedRaw] = fields;

  let timestamp = '';
  if (timeRaw && timeRaw.length >= 6) {
    const hh = timeRaw.substring(0, 2);
    const mm = timeRaw.substring(2, 4);
    const ss = timeRaw.substring(4, 6);
    timestamp = `${hh}:${mm}:${ss}`;
  }

  const rawLatDecimal = nmeaToDecimal(latRaw || '', latHemi || '');
  const rawLonDecimal = nmeaToDecimal(lonRaw || '', lonHemi || '');

  const latitude  = isNaN(rawLatDecimal) ? null : parseFloat(rawLatDecimal.toFixed(6));
  const longitude = isNaN(rawLonDecimal) ? null : parseFloat(rawLonDecimal.toFixed(6));
  const speed     = speedRaw ? parseFloat(speedRaw) : 0;

  logger.info('HQ_GPS_UPDATE', {
    event:     'HQ_GPS_UPDATE',
    protocol:  'HQ',
    imei,
    remote:    `${socket.remoteAddress}:${socket.remotePort}`,
    latitude,
    longitude,
    speed:     isNaN(speed) ? 0 : speed,
    gpsStatus: gpsStatus || '',
    timestamp,
  });

  // Respond immediately with H02/A3 V4 confirmation response: *HQ,<IMEI>,V4,V1,<YYYYMMDDHHMMSS>#\r\n
  // Timestamp is derived from V1 packet's HHMMSS + today's UTC date YYYYMMDD
  const v4Timestamp = formatV1Timestamp(timeRaw);
  const ack = buildHqAck(imei, 'V1', v4Timestamp);
  sendHqResponse(socket, imei, ack);
}

function handleHqHeartbeat(socket, imei, fields) {
  logger.info('HQ_HEARTBEAT', {
    event:    'HQ_HEARTBEAT',
    protocol: 'HQ',
    imei,
    remote:   `${socket.remoteAddress}:${socket.remotePort}`,
  });

  // Respond with HQ Heartbeat ACK: *HQ,<IMEI>,HTBT#\r\n
  const ack = buildHqAck(imei, 'HTBT');
  sendHqResponse(socket, imei, ack);
}

function handleHqPacket(socket, message) {
  if (isRawDebug()) {
    logger.info('HQ_RAW', {
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
      ascii:  message,
      hex:    Buffer.from(message).toString('hex'),
    });
  }

  const parsed = parseHqMessage(message);
  if (!parsed) {
    logger.warn('HQ_INVALID_PACKET', {
      remote:  `${socket.remoteAddress}:${socket.remotePort}`,
      snippet: message.substring(0, 120),
    });
    return;
  }

  const { imei, cmd, fields } = parsed;

  deviceRegistry.set(imei, socket);

  switch (cmd) {
    case 'V0':
      handleHqLogin(socket, imei, fields);
      break;
    case 'V1':
      handleHqGps(socket, imei, fields);
      break;
    case 'HTBT':
      handleHqHeartbeat(socket, imei, fields);
      break;
    default:
      logger.warn('HQ_UNKNOWN_CMD', {
        remote: `${socket.remoteAddress}:${socket.remotePort}`,
        imei,
        cmd,
      });
  }
}

// =============================================================================
// Stream Processors (Fragmentation & Framing)
// =============================================================================

function processGt06Buffer(socket, state) {
  while (state.buffer.length >= 4) {
    if (state.buffer[0] !== 0x78 || state.buffer[1] !== 0x78) {
      // Find next 0x78 0x78 in buffer
      let nextSync = -1;
      for (let i = 1; i < state.buffer.length - 1; i++) {
        if (state.buffer[i] === 0x78 && state.buffer[i + 1] === 0x78) {
          nextSync = i;
          break;
        }
      }

      if (nextSync !== -1) {
        logger.warn('GT06_RESYNC', {
          remote: `${socket.remoteAddress}:${socket.remotePort}`,
          skippedBytes: nextSync,
        });
        state.buffer = state.buffer.subarray(nextSync);
      } else {
        logger.warn('GT06_RESYNC', {
          remote: `${socket.remoteAddress}:${socket.remotePort}`,
          hex:    state.buffer.subarray(0, Math.min(state.buffer.length, 64)).toString('hex'),
          length: state.buffer.length,
        });
        state.buffer = Buffer.alloc(0);
        break;
      }
    }

    if (state.buffer.length < 4) break;

    const frameLength = state.buffer[2] + 5;
    if (state.buffer.length < frameLength) break;

    const frame  = state.buffer.subarray(0, frameLength);
    state.buffer = state.buffer.subarray(frameLength);

    handleGt06Packet(socket, frame);
  }
}

function processHqBuffer(socket, state) {
  while (state.buffer.length > 0) {
    // If buffer does not start with '*', search for next '*'
    if (state.buffer[0] !== 0x2a /* '*' */) {
      const nextStar = state.buffer.indexOf(0x2a);
      if (nextStar === -1) {
        // No '*' found in entire buffer
        state.buffer = Buffer.alloc(0);
        break;
      }
      state.buffer = state.buffer.subarray(nextStar);
    }

    // Look for packet terminator: '#', '\n', or next '*HQ,' starting after index 0
    let endIdx  = -1;
    let endType = null;

    for (let i = 0; i < state.buffer.length; i++) {
      const b = state.buffer[i];
      if (b === 0x23 /* '#' */) {
        endIdx  = i;
        endType = 'hash';
        break;
      }
      if (b === 0x0a /* '\n' */) {
        endIdx  = i;
        endType = 'newline';
        break;
      }
      // Check if another '*HQ,' starts at i > 0
      if (i > 0 && b === 0x2a && state.buffer.subarray(i, i + 4).toString() === '*HQ,') {
        endIdx  = i;
        endType = 'next_hq';
        break;
      }
    }

    if (endIdx === -1) {
      // Incomplete packet in stream, wait for further TCP chunks
      break;
    }

    let message = '';
    let nextStart = 0;

    if (endType === 'hash') {
      message   = state.buffer.subarray(0, endIdx + 1).toString('utf8');
      nextStart = endIdx + 1;
      while (
        nextStart < state.buffer.length &&
        (state.buffer[nextStart] === 0x0d || state.buffer[nextStart] === 0x0a)
      ) {
        nextStart++;
      }
    } else if (endType === 'newline') {
      message   = state.buffer.subarray(0, endIdx).toString('utf8').trimEnd();
      nextStart = endIdx + 1;
    } else if (endType === 'next_hq') {
      message   = state.buffer.subarray(0, endIdx).toString('utf8').trimEnd();
      nextStart = endIdx;
    }

    state.buffer = state.buffer.subarray(nextStart);

    if (!message || message.trim().length === 0) continue;

    handleHqPacket(socket, message);
  }
}

function processBuffer(socket, state) {
  // Protocol detection on initial chunk(s)
  if (!state.protocol) {
    if (state.buffer.length < 4) return;

    const b0 = state.buffer[0];
    const b1 = state.buffer[1];
    const b2 = state.buffer[2];
    const b3 = state.buffer[3];

    if (b0 === 0x78 && b1 === 0x78) {
      state.protocol = 'GT06';
      logger.info('GT06_DEVICE_CONNECTED', {
        remote: `${socket.remoteAddress}:${socket.remotePort}`,
      });
    } else if (b0 === 0x2a && b1 === 0x48 && b2 === 0x51 && b3 === 0x2c) {
      state.protocol = 'HQ';
      logger.info('HQ_DEVICE_CONNECTED', {
        remote: `${socket.remoteAddress}:${socket.remotePort}`,
      });
    } else {
      // Resynchronize by finding next valid header
      let nextGt06 = -1;
      let nextHq   = -1;

      for (let i = 1; i < state.buffer.length - 1; i++) {
        if (state.buffer[i] === 0x78 && state.buffer[i + 1] === 0x78) {
          nextGt06 = i;
          break;
        }
      }

      const hqHeader = Buffer.from('*HQ,');
      nextHq = state.buffer.indexOf(hqHeader, 1);

      let bestSync = -1;
      if (nextGt06 !== -1 && nextHq !== -1) {
        bestSync = Math.min(nextGt06, nextHq);
      } else if (nextGt06 !== -1) {
        bestSync = nextGt06;
      } else if (nextHq !== -1) {
        bestSync = nextHq;
      }

      if (bestSync !== -1) {
        state.buffer = state.buffer.subarray(bestSync);
        return processBuffer(socket, state);
      }

      logger.warn('UNKNOWN_PROTOCOL_DETECTED', {
        remote: `${socket.remoteAddress}:${socket.remotePort}`,
        hex:    state.buffer.subarray(0, Math.min(state.buffer.length, 64)).toString('hex'),
        length: state.buffer.length,
      });
      state.buffer = Buffer.alloc(0);
      return;
    }
  }

  if (state.protocol === 'GT06') {
    processGt06Buffer(socket, state);
  } else if (state.protocol === 'HQ') {
    processHqBuffer(socket, state);
  }
}

// =============================================================================
// Server Factory
// =============================================================================

function createGt06Server(port) {
  const GT06_PORT = port || parseInt(process.env.GT06_PORT, 10) || 5022;

  const server = net.createServer((socket) => {
    const state = {
      protocol: null,
      buffer:   Buffer.alloc(0),
    };

    socket.setKeepAlive(true, 30000);
    socket.setNoDelay(true);

    logger.info('TCP_CLIENT_CONNECTED', {
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
    });

    socket.on('data', (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      processBuffer(socket, state);
    });

    socket.on('close', () => {
      // Clean up device registry if mapped to this socket
      for (const [imei, sock] of deviceRegistry.entries()) {
        if (sock === socket) {
          deviceRegistry.delete(imei);
        }
      }

      logger.info('DEVICE_DISCONNECTED', {
        remote:   `${socket.remoteAddress}:${socket.remotePort}`,
        protocol: state.protocol || 'unknown',
      });
    });

    socket.on('error', (err) => {
      logger.error('SOCKET_ERROR', {
        remote:   `${socket.remoteAddress}:${socket.remotePort}`,
        protocol: state.protocol || 'unknown',
        message:  err.message,
      });
    });
  });

  server.listen(GT06_PORT, '0.0.0.0', () => {
    logger.info('GT06_SERVER_STARTED', {
      port:    GT06_PORT,
      message: `GPS tracker server (GT06 + HQ) listening on TCP port ${GT06_PORT}`,
    });
  });

  server.on('error', (err) => {
    logger.error('GT06_SERVER_ERROR', { message: err.message });
  });

  return server;
}

module.exports = {
  createGt06Server,
  nmeaToDecimal,
  parseHqMessage,
  formatV1Timestamp,
  buildHqAck,
  buildAck,
  crc16,
  sendHqResponse,
  handleHqPacket,
  handleGt06Packet,
  _processBuffer:     processBuffer,
  _processHqBuffer:   processHqBuffer,
  _processGt06Buffer: processGt06Buffer,
  deviceRegistry,
};
