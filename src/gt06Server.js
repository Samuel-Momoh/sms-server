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
 *   GT06_PORT              TCP port to listen on                           (default: 5022)
 *   TCP_KEEPALIVE_DELAY    Initial TCP keepalive delay in ms               (default: 300000)
 *   AUTO_ENFORCE_TRACKING  Auto send WKMD 0 and D1 30 on connect           (default: true)
 *   GPS_RAW_DEBUG          Log raw bytes / ASCII messages                  (default: false)
 */

const net                   = require('net');
const { logger }            = require('./logger');
const { gpsEventEmitter }   = require('./gpsEvents');
const { upsertDevice, saveLocationHistory } = require('./db/mysql');
const { flushQueuedCommands } = require('./services/commandQueue');

// Dynamic flag checker for raw debugging
const isRawDebug = () => process.env.GPS_RAW_DEBUG === 'true';

// Configurable TCP keepalive delay in ms (default: 300000ms = 5 minutes)
// Accommodates moving (30s) and stationary/sleep intervals (e.g. 180s–300s)
const getKeepAliveDelay = () => parseInt(process.env.TCP_KEEPALIVE_DELAY, 10) || 300000;

// Flag to auto-enforce continuous Mode 0 & 30s interval on connect/login
const isAutoEnforceTracking = () => process.env.AUTO_ENFORCE_TRACKING !== 'false';

// ── Device registry: IMEI → socket ───────────────────────────────────────────
const deviceRegistry = new Map();

// ── Device Store & Telemetry Cache: IMEI → telemetry state ───────────────────
const deviceStates = new Map();

/**
 * Update and cache the latest device state
 *
 * @param {string} imei
 * @param {object} updates
 * @returns {object}
 */
function updateDeviceState(imei, updates = {}) {
  if (!imei) return null;
  const current = deviceStates.get(imei) || {
    imei,
    connected: false,
    protocol: null,
    remoteAddress: null,
    remotePort: null,
    connectedAt: null,
    lastActivityAt: null,
    lastLocation: null,
    vehicleStatus: null,
    lastCommand: null,
  };
  const updated = { ...current, ...updates, updatedAt: new Date().toISOString() };
  deviceStates.set(imei, updated);
  return updated;
}

/**
 * List all known devices with their current connection status
 *
 * @returns {Array<object>}
 */
function getConnectedDevices() {
  const result = [];
  for (const [imei, state] of deviceStates.entries()) {
    result.push({
      ...state,
      connected: deviceRegistry.has(imei),
    });
  }
  return result;
}

/**
 * Get device state by IMEI
 *
 * @param {string} imei
 * @returns {object|null}
 */
function getDeviceState(imei) {
  if (!imei) return null;
  const state = deviceStates.get(imei);
  if (!state) return null;
  return {
    ...state,
    connected: deviceRegistry.has(imei),
  };
}

// =============================================================================
// Cantrack GPRS Command Builders & Senders
// =============================================================================

/**
 * Build a Cantrack ASCII command string according to Section A.1:
 * Format: *HQ,<IMEI>,<CMD>,<HHMMSS>,<PARAM1>,<PARAM2>,...#\r\n
 *
 * @param {string} imei
 * @param {string} cmd
 * @param {Array<string|number>} [params=[]]
 * @param {string} [timeStr]
 * @returns {string}
 */
function buildCantrackCommand(imei, cmd, params = [], timeStr) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hhmmss = timeStr || `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const paramStr = params && params.length > 0 ? `,${params.join(',')}` : '';
  return `*HQ,${imei},${cmd},${hhmmss}${paramStr}#\r\n`;
}

/**
 * Send a Cantrack command to a connected tracker over TCP
 *
 * @param {string} imei
 * @param {string} commandOrCmd  Command code (e.g. 'WKMD', 'D1', 'S20') OR full raw '*HQ,...#'
 * @param {Array<string|number>} [params=[]]
 * @returns {Promise<{ success: boolean, message?: string, error?: string, imei: string, command?: string }>}
 */
function sendDeviceCommand(imei, commandOrCmd, params = []) {
  if (!imei) {
    return Promise.resolve({ success: false, error: 'IMEI is required', imei });
  }

  const socket = deviceRegistry.get(imei);
  if (!socket || socket.destroyed) {
    return Promise.resolve({
      success: false,
      error: `Device ${imei} is not connected or TCP socket is closed`,
      imei,
      connected: false,
    });
  }

  let commandString = '';
  let cmdCode = '';

  if (typeof commandOrCmd === 'string' && commandOrCmd.startsWith('*')) {
    commandString = commandOrCmd.endsWith('\r\n') ? commandOrCmd : (commandOrCmd.endsWith('\n') ? commandOrCmd : `${commandOrCmd}\r\n`);
    const parts = commandOrCmd.replace(/^\*/, '').replace(/[#\r\n]+$/, '').split(',');
    cmdCode = parts[2] || 'RAW';
  } else {
    cmdCode = commandOrCmd;
    commandString = buildCantrackCommand(imei, commandOrCmd, params);
  }

  const hex = Buffer.from(commandString).toString('hex');

  return new Promise((resolve) => {
    socket.write(commandString, (err) => {
      if (err) {
        logger.error('HQ_COMMAND_WRITE_ERROR', {
          imei,
          command: commandString.trim(),
          error: err.message,
        });
        return resolve({
          success: false,
          error: err.message,
          imei,
          command: commandString.trim(),
        });
      }

      logger.info('HQ_COMMAND_SENT', {
        imei,
        cmd: cmdCode,
        commandAscii: commandString.trim(),
        commandHex: hex,
      });

      gpsEventEmitter.emit('gps:command_sent', {
        imei,
        cmd: cmdCode,
        command: commandString.trim(),
        hex,
        timestamp: new Date().toISOString(),
      });

      updateDeviceState(imei, {
        lastCommand: {
          cmd: cmdCode,
          command: commandString.trim(),
          sentAt: new Date().toISOString(),
        },
      });

      resolve({
        success: true,
        imei,
        cmd: cmdCode,
        command: commandString.trim(),
        hex,
        sentAt: new Date().toISOString(),
      });
    });
  });
}

/**
 * Enforce continuous tracking mode (Mode 0) and 30s interval on the tracker.
 * Prevents the tracker firmware from entering deep sleep when vehicle ACC is off.
 *
 * @param {net.Socket} socket
 * @param {string} imei
 */
function enforceContinuousTracking(socket, imei) {
  if (!isAutoEnforceTracking() || !imei || !socket || socket.destroyed) return;

  const now = Date.now();
  const trackerState = socket._trackerState || {};
  // Avoid re-enforcing more frequently than once every 5 minutes
  if (trackerState.lastEnforceAt && (now - trackerState.lastEnforceAt < 5 * 60 * 1000)) {
    return;
  }

  trackerState.lastEnforceAt = now;

  // Step 1: Set Working Mode to 0 (GPS Real-time Tracking, GPS kept open)
  const wkmdCmd = buildCantrackCommand(imei, 'WKMD', ['0']);
  socket.write(wkmdCmd, () => {
    logger.info('HQ_AUTO_ENFORCE_WKMD', {
      imei,
      mode: '0 (GPS Real-time Tracking)',
      command: wkmdCmd.trim(),
    });
  });

  // Step 2: Set GPRS reporting interval to 30 seconds
  setTimeout(() => {
    if (socket && !socket.destroyed) {
      const d1Cmd = buildCantrackCommand(imei, 'D1', ['30']);
      socket.write(d1Cmd, () => {
        logger.info('HQ_AUTO_ENFORCE_INTERVAL', {
          imei,
          intervalSeconds: 30,
          command: d1Cmd.trim(),
        });
      });
    }
  }, 1000);
}

// =============================================================================
// HQ Timestamp & NMEA Helpers
// =============================================================================

// Helper to convert V1/V2 packet's HHMMSS into YYYYMMDDHHMMSS
// Uses packet's DDMMYY dateRaw if provided, falling back to today's UTC date
function formatV1Timestamp(timeRaw, dateRawOrDate, fallbackDate = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  let datePart = '';

  if (typeof dateRawOrDate === 'string' && /^\d{6}$/.test(dateRawOrDate)) {
    // dateRaw in DDMMYY format (e.g. '100815' -> 20150810, '240826' -> 20260824)
    const dd = dateRawOrDate.substring(0, 2);
    const mm = dateRawOrDate.substring(2, 4);
    const yy = dateRawOrDate.substring(4, 6);
    datePart = `20${yy}${mm}${dd}`;
  } else {
    const d = (dateRawOrDate instanceof Date) ? dateRawOrDate : fallbackDate;
    const yyyy = d.getUTCFullYear();
    const mm   = pad(d.getUTCMonth() + 1);
    const dd   = pad(d.getUTCDate());
    datePart = `${yyyy}${mm}${dd}`;
  }

  if (timeRaw && /^\d{6}$/.test(timeRaw.substring(0, 6))) {
    return `${datePart}${timeRaw.substring(0, 6)}`;
  }

  const d = (dateRawOrDate instanceof Date) ? dateRawOrDate : fallbackDate;
  const hh  = pad(d.getUTCHours());
  const min = pad(d.getUTCMinutes());
  const ss  = pad(d.getUTCSeconds());
  return `${datePart}${hh}${min}${ss}`;
}

/**
 * Parse Cantrack 4-byte equ_status hexadecimal string (e.g. "FFFFFBFF").
 * Uses negative logic where bit=0 indicates active/alarm state.
 *
 * @param {string} equStatusHex 8-character hex string
 * @returns {{
 *   raw: string,
 *   accOn: boolean,
 *   gpsFixed: boolean,
 *   isBackupBattery: boolean,
 *   isOilCut: boolean,
 *   doorOpen: boolean,
 *   alarms: string[]
 * }}
 */
function parseEquStatus(equStatusHex) {
  if (!equStatusHex || typeof equStatusHex !== 'string' || equStatusHex.length < 8) {
    return {
      raw: equStatusHex || '',
      accOn: true,
      gpsFixed: true,
      isBackupBattery: false,
      isOilCut: false,
      doorOpen: false,
      alarms: [],
    };
  }

  const b1 = parseInt(equStatusHex.substring(0, 2), 16) || 0xFF;
  const b2 = parseInt(equStatusHex.substring(2, 4), 16) || 0xFF;
  const b3 = parseInt(equStatusHex.substring(4, 6), 16) || 0xFF;
  const b4 = parseInt(equStatusHex.substring(6, 8), 16) || 0xFF;

  const alarms = [];

  // Byte 1
  const isAntiTamperAlarm    = (b1 & 0x04) === 0;
  const isOilCut             = (b1 & 0x08) === 0;
  const isBatteryRemoveAlarm = (b1 & 0x10) === 0;

  if (isAntiTamperAlarm)    alarms.push('ANTI_TAMPER');
  if (isBatteryRemoveAlarm) alarms.push('BATTERY_REMOVED');

  // Byte 2
  const gpsFixed             = (b2 & 0x01) === 0; // bit 0: 0=located
  const isSosAlarm           = (b2 & 0x04) === 0;
  const isBackupBattery      = (b2 & 0x08) === 0; // bit 3: 0=powered by backup battery
  const isPowerCutAlarm      = (b2 & 0x10) === 0;

  if (isSosAlarm)      alarms.push('SOS');
  if (isPowerCutAlarm) alarms.push('POWER_CUT');

  // Byte 3
  const doorOpen             = (b3 & 0x01) === 0;
  const accOn                = (b3 & 0x04) !== 0; // bit 2: 0=ACC OFF, 1=ACC ON
  const isVibrationAlarm     = (b3 & 0x08) === 0;
  const isLowBatteryAlarm    = (b3 & 0x10) === 0;

  if (isVibrationAlarm)  alarms.push('VIBRATION');
  if (isLowBatteryAlarm) alarms.push('LOW_BATTERY');

  // Byte 4
  const isOverspeedAlarm     = (b4 & 0x04) === 0;
  const isFenceInAlarm       = (b4 & 0x10) === 0;
  const isFenceOutAlarm      = (b4 & 0x80) === 0;

  if (isOverspeedAlarm) alarms.push('OVERSPEED');
  if (isFenceInAlarm)   alarms.push('FENCE_IN');
  if (isFenceOutAlarm)  alarms.push('FENCE_OUT');

  return {
    raw: equStatusHex,
    accOn,
    gpsFixed,
    isBackupBattery,
    isOilCut,
    doorOpen,
    alarms,
  };
}

/**
 * Register an active socket for an IMEI in the device registry.
 * If a different socket was previously registered for this IMEI,
 * cleanly destroy the older socket so it doesn't linger or timeout.
 *
 * @param {string} imei
 * @param {net.Socket} socket
 * @param {string} protocol
 * @param {object} [state]
 */
function registerDevice(imei, socket, protocol, state) {
  if (!imei || !socket) return;

  const trackerState = state || socket._trackerState || {};
  trackerState.imei = imei;
  trackerState.lastActivityAt = new Date().toISOString();

  const existingSocket = deviceRegistry.get(imei);
  if (existingSocket && existingSocket !== socket) {
    const oldRemote = existingSocket.remoteAddress ? `${existingSocket.remoteAddress}:${existingSocket.remotePort}` : 'unknown';
    const newRemote = socket.remoteAddress ? `${socket.remoteAddress}:${socket.remotePort}` : 'unknown';

    logger.warn('DEVICE_RECONNECTED', {
      imei,
      protocol: protocol || trackerState.protocol || 'unknown',
      oldRemote,
      newRemote,
      action: 'replacing_previous_connection',
    });

    gpsEventEmitter.emit('gps:reconnected', {
      imei,
      protocol: protocol || trackerState.protocol || 'unknown',
      oldRemote,
      newRemote,
      timestamp: new Date().toISOString(),
    });

    try {
      if (existingSocket._trackerState) {
        existingSocket._trackerState.closeReason = 'replaced_by_new_connection';
        existingSocket._trackerState.isDestroyedLocally = true;
      }
      existingSocket.destroy();
    } catch (_) {
      // Ignore errors when destroying lingering socket
    }
  }

  deviceRegistry.set(imei, socket);

  updateDeviceState(imei, {
    connected: true,
    protocol: protocol || trackerState.protocol || 'unknown',
    remoteAddress: socket.remoteAddress,
    remotePort: socket.remotePort,
    connectedAt: trackerState.connectedAt || new Date().toISOString(),
    lastActivityAt: trackerState.lastActivityAt,
  });

  // Persist device state to MySQL
  upsertDevice({
    imei,
    protocol: protocol || trackerState.protocol || 'HQ',
    connected: true,
    lastSeen: trackerState.lastActivityAt || new Date().toISOString(),
  });

  // Auto-flush pending queued commands when device connects/wakes up
  flushQueuedCommands(imei, sendDeviceCommand);

  gpsEventEmitter.emit('gps:connected', {
    imei,
    protocol: protocol || trackerState.protocol || 'unknown',
    remote: `${socket.remoteAddress}:${socket.remotePort}`,
    timestamp: new Date().toISOString(),
  });
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

function handleGt06Login(socket, data, state) {
  const imeiHex  = data.subarray(4, 12).toString('hex');
  const serialNo = data.subarray(data.length - 6, data.length - 4);

  registerDevice(imeiHex, socket, 'GT06', state);

  logger.info('GT06_LOGIN', {
    remote:  `${socket.remoteAddress}:${socket.remotePort}`,
    imeiHex,
  });

  gpsEventEmitter.emit('gps:login', {
    imei: imeiHex,
    protocol: 'GT06',
    remote: `${socket.remoteAddress}:${socket.remotePort}`,
    timestamp: new Date().toISOString(),
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

  gpsEventEmitter.emit('gps:ack_sent', {
    imei: imeiHex,
    protocol: 'GT06',
    type: '0x01 (login)',
    timestamp: new Date().toISOString(),
  });
}

function handleGt06Location(socket, data, protocolNumber, state) {
  if (state) state.lastActivityAt = new Date().toISOString();
  else if (socket._trackerState) socket._trackerState.lastActivityAt = new Date().toISOString();

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
  const latitude = parseFloat(lat.toFixed(6));
  const longitude = parseFloat(lon.toFixed(6));
  const imei = (state && state.imei) || (socket._trackerState && socket._trackerState.imei) || null;

  logger.info('GT06_GPS_UPDATE', {
    remote:    `${socket.remoteAddress}:${socket.remotePort}`,
    protocol:  `0x${protocolNumber.toString(16).toUpperCase()}`,
    imei:      imei || undefined,
    lat:       latitude,
    lon:       longitude,
    speed_kmh: speed,
    gpsFixed:  isGpsRealtime,
    timestamp,
  });

  if (imei) {
    updateDeviceState(imei, {
      lastLocation: {
        latitude,
        longitude,
        speed_kmh: speed,
        gpsFixed: isGpsRealtime,
        timestamp,
      },
      lastActivityAt: new Date().toISOString(),
    });

    gpsEventEmitter.emit('gps:update', {
      imei,
      protocol: 'GT06',
      latitude,
      longitude,
      speed_kmh: speed,
      gpsFixed: isGpsRealtime,
      timestamp,
    });
  }
}

function handleGt06Heartbeat(socket, data, state) {
  if (state) state.lastActivityAt = new Date().toISOString();
  else if (socket._trackerState) socket._trackerState.lastActivityAt = new Date().toISOString();

  const serialNo = data.subarray(data.length - 6, data.length - 4);
  const imei = (state && state.imei) || (socket._trackerState && socket._trackerState.imei) || null;

  const ack = buildAck(0x13, serialNo);
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

  if (imei) {
    gpsEventEmitter.emit('gps:heartbeat', {
      imei,
      protocol: 'GT06',
      timestamp: new Date().toISOString(),
    });
  }
}

function handleGt06Packet(socket, frame, state) {
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
    case 0x01: handleGt06Login(socket, frame, state);                    break;
    case 0x12:
    case 0x22: handleGt06Location(socket, frame, protocolNumber, state); break;
    case 0x13: handleGt06Heartbeat(socket, frame, state);                break;
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

function buildHqAck(imei, cmd, timestamp) {
  if (cmd === 'V1' || cmd === 'V2') {
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

  gpsEventEmitter.emit('gps:ack_sent', {
    imei,
    protocol: 'HQ',
    responseAscii: ackResponse,
    responseHex: hex,
    timestamp: new Date().toISOString(),
  });
}

// =============================================================================
// HQ — Message Parser (pure function)
// =============================================================================

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

function handleHqLogin(socket, imei, fields, state) {
  if (state) state.lastActivityAt = new Date().toISOString();
  else if (socket._trackerState) socket._trackerState.lastActivityAt = new Date().toISOString();

  logger.info('HQ_LOGIN', {
    event:    'HQ_LOGIN',
    protocol: 'HQ',
    imei,
    remote:   `${socket.remoteAddress}:${socket.remotePort}`,
  });

  gpsEventEmitter.emit('gps:login', {
    imei,
    protocol: 'HQ',
    remote: `${socket.remoteAddress}:${socket.remotePort}`,
    timestamp: new Date().toISOString(),
  });

  const ack = buildHqAck(imei, 'V0');
  sendHqResponse(socket, imei, ack);

  // Auto-enforce continuous Mode 0 and 30s interval to prevent 30-min idle sleep
  enforceContinuousTracking(socket, imei);
}

function handleHqGps(socket, imei, fields, state, cmd = 'V1') {
  if (state) state.lastActivityAt = new Date().toISOString();
  else if (socket._trackerState) socket._trackerState.lastActivityAt = new Date().toISOString();

  // Cantrack V1/V2 fields:
  // [0] HHMMSS [1] S (A/V/B) [2] LAT [3] N/S [4] LON [5] E/W [6] SPEED (knots) [7] DIRECTION (0-359) [8] DDMMYY [9] equ_status (hex)
  const [timeRaw, gpsStatus, latRaw, latHemi, lonRaw, lonHemi, speedRaw, directionRaw, dateRaw, equStatusRaw] = fields;

  let timestamp = '';
  if (timeRaw && timeRaw.length >= 6) {
    const hh = timeRaw.substring(0, 2);
    const mm = timeRaw.substring(2, 4);
    const ss = timeRaw.substring(4, 6);
    if (dateRaw && dateRaw.length >= 6) {
      const dd = dateRaw.substring(0, 2);
      const mon = dateRaw.substring(2, 4);
      const yy = dateRaw.substring(4, 6);
      timestamp = `20${yy}-${mon}-${dd} ${hh}:${mm}:${ss} UTC`;
    } else {
      timestamp = `${hh}:${mm}:${ss}`;
    }
  }

  const rawLatDecimal = nmeaToDecimal(latRaw || '', latHemi || '');
  const rawLonDecimal = nmeaToDecimal(lonRaw || '', lonHemi || '');

  const latitude  = isNaN(rawLatDecimal) ? null : parseFloat(rawLatDecimal.toFixed(6));
  const longitude = isNaN(rawLonDecimal) ? null : parseFloat(rawLonDecimal.toFixed(6));

  // Speed is transmitted in Knots according to Cantrack manual (1 knot = 1.852 km/h)
  const speedKnots = speedRaw ? parseFloat(speedRaw) : 0;
  const validKnots = isNaN(speedKnots) ? 0 : speedKnots;
  const speedKmh   = parseFloat((validKnots * 1.852).toFixed(2));

  const direction     = directionRaw ? parseInt(directionRaw, 10) || 0 : 0;
  const vehicleStatus = parseEquStatus(equStatusRaw);

  const payload = {
    event:           'HQ_GPS_UPDATE',
    protocol:        'HQ',
    cmd,
    imei,
    remote:          `${socket.remoteAddress}:${socket.remotePort}`,
    latitude,
    longitude,
    speed:           speedKmh,
    speed_knots:     validKnots,
    speed_kmh:       speedKmh,
    direction,
    gpsStatus:       gpsStatus || '',
    accOn:           vehicleStatus.accOn,
    alarms:          vehicleStatus.alarms.length > 0 ? vehicleStatus.alarms : undefined,
    isBackupBattery: vehicleStatus.isBackupBattery,
    isOilCut:        vehicleStatus.isOilCut,
    equStatusHex:    equStatusRaw || undefined,
    timestamp,
  };

  logger.info('HQ_GPS_UPDATE', payload);

  updateDeviceState(imei, {
    lastLocation: {
      latitude,
      longitude,
      speed_kmh: speedKmh,
      speed_knots: validKnots,
      direction,
      gpsStatus,
      timestamp,
    },
    vehicleStatus,
    lastActivityAt: new Date().toISOString(),
  });

  gpsEventEmitter.emit('gps:update', payload);

  // Persist trajectory and device status to MySQL
  saveLocationHistory({
    imei,
    latitude,
    longitude,
    speed_kmh: speedKmh,
    direction,
    accOn: vehicleStatus.accOn,
    gpsStatus,
    timestamp,
    raw_hex: fields.join(','),
  });

  upsertDevice({
    imei,
    protocol: 'HQ',
    connected: true,
    latitude,
    longitude,
    speed_kmh: speedKmh,
    direction,
    accOn: vehicleStatus.accOn,
    isOilCut: vehicleStatus.isOilCut,
    isBackupBattery: vehicleStatus.isBackupBattery,
    gpsStatus,
    lastSeen: timestamp,
  });

  // Respond immediately with H02/A3 V4 confirmation response: *HQ,<IMEI>,V4,V1,<YYYYMMDDHHMMSS>#\r\n
  const v4Timestamp = formatV1Timestamp(timeRaw, dateRaw);
  const ack = buildHqAck(imei, cmd, v4Timestamp);
  sendHqResponse(socket, imei, ack);

  // Periodic keep-awake re-assertion if ACC is OFF (preventing 30-min idle sleep)
  if (!vehicleStatus.accOn) {
    const trackerState = socket._trackerState || {};
    const now = Date.now();
    if (!trackerState.lastEnforceAt || (now - trackerState.lastEnforceAt > 15 * 60 * 1000)) {
      enforceContinuousTracking(socket, imei);
    }
  }
}

function handleHqHeartbeat(socket, imei, fields, state) {
  if (state) state.lastActivityAt = new Date().toISOString();
  else if (socket._trackerState) socket._trackerState.lastActivityAt = new Date().toISOString();

  logger.info('HQ_HEARTBEAT', {
    event:    'HQ_HEARTBEAT',
    protocol: 'HQ',
    imei,
    remote:   `${socket.remoteAddress}:${socket.remotePort}`,
  });

  gpsEventEmitter.emit('gps:heartbeat', {
    imei,
    protocol: 'HQ',
    remote: `${socket.remoteAddress}:${socket.remotePort}`,
    timestamp: new Date().toISOString(),
  });

  // Respond with HQ Heartbeat ACK: *HQ,<IMEI>,HTBT#\r\n
  const ack = buildHqAck(imei, 'HTBT');
  sendHqResponse(socket, imei, ack);
}

function handleHqLbs(socket, imei, fields, state) {
  if (state) state.lastActivityAt = new Date().toISOString();
  else if (socket._trackerState) socket._trackerState.lastActivityAt = new Date().toISOString();

  const [timeRaw, ...rest] = fields;
  const payload = {
    event:    'HQ_LBS_UPDATE',
    protocol: 'HQ',
    imei,
    remote:   `${socket.remoteAddress}:${socket.remotePort}`,
    timeRaw,
    details:  rest,
    timestamp: new Date().toISOString(),
  };

  logger.info('HQ_LBS_UPDATE', payload);
  gpsEventEmitter.emit('gps:lbs', payload);
}

function handleHqConfirm(socket, imei, fields, state) {
  if (state) state.lastActivityAt = new Date().toISOString();
  else if (socket._trackerState) socket._trackerState.lastActivityAt = new Date().toISOString();

  const [cmdConfirmed, ...rest] = fields;
  const payload = {
    event:        'HQ_COMMAND_CONFIRM',
    protocol:     'HQ',
    imei,
    remote:       `${socket.remoteAddress}:${socket.remotePort}`,
    cmdConfirmed,
    details:      rest,
    timestamp:    new Date().toISOString(),
  };

  logger.info('HQ_COMMAND_CONFIRM', payload);
  gpsEventEmitter.emit('gps:confirm', payload);
}

function handleHqWifi(socket, imei, fields, state) {
  if (state) state.lastActivityAt = new Date().toISOString();
  else if (socket._trackerState) socket._trackerState.lastActivityAt = new Date().toISOString();

  const [timeRaw, wifiCount, ...rest] = fields;
  const payload = {
    event:     'HQ_WIFI_UPDATE',
    protocol:  'HQ',
    imei,
    remote:    `${socket.remoteAddress}:${socket.remotePort}`,
    timeRaw,
    wifiCount: parseInt(wifiCount, 10) || 0,
    details:   rest,
    timestamp: new Date().toISOString(),
  };

  logger.info('HQ_WIFI_UPDATE', payload);
  gpsEventEmitter.emit('gps:wifi', payload);
}

function handleHqPacket(socket, message, state) {
  if (isRawDebug()) {
    logger.info('HQ_RAW', {
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
      ascii:  message,
      hex:    Buffer.from(message).toString('hex'),
    });
    gpsEventEmitter.emit('gps:raw', {
      ascii: message,
      hex: Buffer.from(message).toString('hex'),
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
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

  registerDevice(imei, socket, 'HQ', state);

  switch (cmd) {
    case 'V0':
      handleHqLogin(socket, imei, fields, state);
      break;
    case 'V1':
    case 'V2':
      handleHqGps(socket, imei, fields, state, cmd);
      break;
    case 'V3':
      handleHqLbs(socket, imei, fields, state);
      break;
    case 'V4':
      handleHqConfirm(socket, imei, fields, state);
      break;
    case 'V5':
      handleHqWifi(socket, imei, fields, state);
      break;
    case 'HTBT':
      handleHqHeartbeat(socket, imei, fields, state);
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

    handleGt06Packet(socket, frame, state);
  }
}

function processHqBuffer(socket, state) {
  while (state.buffer.length > 0) {
    if (state.buffer[0] !== 0x2a /* '*' */) {
      const nextStar = state.buffer.indexOf(0x2a);
      if (nextStar === -1) {
        state.buffer = Buffer.alloc(0);
        break;
      }
      state.buffer = state.buffer.subarray(nextStar);
    }

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
      if (i > 0 && b === 0x2a && state.buffer.subarray(i, i + 4).toString() === '*HQ,') {
        endIdx  = i;
        endType = 'next_hq';
        break;
      }
    }

    if (endIdx === -1) {
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

    handleHqPacket(socket, message, state);
  }
}

function processBuffer(socket, state) {
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
// Server Factory & Lifecycle
// =============================================================================

function createGt06Server(port) {
  const GT06_PORT = port || parseInt(process.env.GT06_PORT, 10) || 5022;

  const server = net.createServer((socket) => {
    const state = {
      protocol: null,
      buffer:   Buffer.alloc(0),
      imei:     null,
      connectedAt:    new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      closeReason:    'remote_tracker_close',
      lastError:      null,
      errorCode:      null,
      errorSyscall:   null,
      isDestroyedLocally: false,
    };

    socket._trackerState = state;

    // Explicitly disable inactivity timeout so Node never abruptly terminates long-lived connections
    socket.setTimeout(0);

    // Keepalive initial delay: defaults to 5 minutes (or TCP_KEEPALIVE_DELAY)
    socket.setKeepAlive(true, getKeepAliveDelay());
    socket.setNoDelay(true);

    logger.info('TCP_CLIENT_CONNECTED', {
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
    });

    socket.on('data', (chunk) => {
      state.lastActivityAt = new Date().toISOString();
      state.buffer = Buffer.concat([state.buffer, chunk]);
      processBuffer(socket, state);
    });

    socket.on('timeout', () => {
      state.closeReason = 'local_timeout';
      logger.warn('SOCKET_TIMEOUT', {
        remote:   `${socket.remoteAddress}:${socket.remotePort}`,
        imei:     state.imei || undefined,
        protocol: state.protocol || 'unknown',
      });
    });

    socket.on('error', (err) => {
      state.lastError    = err.message;
      state.errorCode    = err.code;
      state.errorSyscall = err.syscall;

      if (!state.isDestroyedLocally) {
        state.closeReason = 'tcp_error';
      }

      logger.error('SOCKET_ERROR', {
        remote:   `${socket.remoteAddress}:${socket.remotePort}`,
        protocol: state.protocol || 'unknown',
        imei:     state.imei || undefined,
        message:  err.message,
        code:     err.code,
        syscall:  err.syscall,
      });
    });

    socket.on('close', (hadError) => {
      // Safe registry cleanup: only delete if this socket is currently the registered socket for this IMEI
      if (state.imei) {
        if (deviceRegistry.get(state.imei) === socket) {
          deviceRegistry.delete(state.imei);
        }
        updateDeviceState(state.imei, {
          connected: false,
          lastActivityAt: new Date().toISOString(),
        });
        upsertDevice({
          imei: state.imei,
          connected: false,
          lastSeen: new Date().toISOString(),
        });
      } else {
        for (const [imei, sock] of deviceRegistry.entries()) {
          if (sock === socket) {
            deviceRegistry.delete(imei);
            updateDeviceState(imei, { connected: false });
            upsertDevice({
              imei,
              connected: false,
              lastSeen: new Date().toISOString(),
            });
          }
        }
      }

      let disconnectType = 'remote_tracker_close';
      if (state.closeReason === 'server_shutdown') {
        disconnectType = 'server_shutdown';
      } else if (state.closeReason === 'replaced_by_new_connection' || state.isDestroyedLocally) {
        disconnectType = 'local_destroy';
      } else if (state.closeReason === 'local_timeout') {
        disconnectType = 'local_timeout';
      } else if (hadError || state.lastError) {
        if (state.errorCode === 'ETIMEDOUT' || (state.lastError && state.lastError.includes('ETIMEDOUT'))) {
          disconnectType = 'tcp_timeout_error';
        } else if (state.errorCode === 'ECONNRESET' || (state.lastError && state.lastError.includes('ECONNRESET'))) {
          disconnectType = 'tcp_reset_error';
        } else {
          disconnectType = 'tcp_error';
        }
      }

      const durationMs = Date.now() - new Date(state.connectedAt).getTime();

      const disconnectPayload = {
        remote:         `${socket.remoteAddress}:${socket.remotePort}`,
        protocol:       state.protocol || 'unknown',
        imei:           state.imei || undefined,
        reason:         state.closeReason,
        disconnectType,
        hadError:       Boolean(hadError),
        error:          state.lastError || undefined,
        errorCode:      state.errorCode || undefined,
        durationMs,
        connectedAt:    state.connectedAt,
        lastActivityAt: state.lastActivityAt,
      };

      logger.info('DEVICE_DISCONNECTED', disconnectPayload);

      if (state.imei) {
        gpsEventEmitter.emit('gps:disconnected', disconnectPayload);
      }
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

/**
 * Gracefully close the GT06 TCP server and all active tracker connections.
 *
 * @param {net.Server} server
 * @param {string}     [reason='server_shutdown']
 * @returns {Promise<void>}
 */
function closeGt06Server(server, reason = 'server_shutdown') {
  if (!server) return Promise.resolve();

  for (const [imei, sock] of deviceRegistry.entries()) {
    try {
      if (sock._trackerState) {
        sock._trackerState.closeReason = reason;
        sock._trackerState.isDestroyedLocally = true;
      }
      sock.destroy();
    } catch (_) {}
  }
  deviceRegistry.clear();

  return new Promise((resolve) => {
    server.close(() => {
      logger.info('GT06_SERVER_STOPPED', { reason });
      resolve();
    });
  });
}

module.exports = {
  createGt06Server,
  closeGt06Server,
  registerDevice,
  nmeaToDecimal,
  parseHqMessage,
  parseEquStatus,
  formatV1Timestamp,
  buildHqAck,
  buildAck,
  crc16,
  sendHqResponse,
  handleHqPacket,
  handleGt06Packet,
  buildCantrackCommand,
  sendDeviceCommand,
  enforceContinuousTracking,
  getConnectedDevices,
  getDeviceState,
  updateDeviceState,
  isDeviceConnected: (imei) => deviceRegistry.has(imei),
  _processBuffer:     processBuffer,
  _processHqBuffer:   processHqBuffer,
  _processGt06Buffer: processGt06Buffer,
  deviceRegistry,
  deviceStates,
};
