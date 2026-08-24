'use strict';

const express = require('express');
const {
  getConnectedDevices,
  getDeviceState,
  sendDeviceCommand,
  buildCantrackCommand,
  deviceRegistry,
} = require('./gt06Server');
const { adminAuth, generateToken } = require('./adminAuth');
const { logger }   = require('./logger');

const router = express.Router();

// ── Public Endpoint: Admin Login ──────────────────────────────────────────────
router.post('/auth/login', (req, res) => {
  const adminUser = process.env.ADMIN_USER || process.env.GATEWAY_USERNAME || 'admin';
  const adminPwd  = process.env.ADMIN_PWD  || process.env.GATEWAY_PASSWORD || 'secret';

  // Support reading credentials from body, basic auth header, or custom headers
  let user = req.body?.username || req.body?.adminUser || req.body?.admin_user;
  let pwd  = req.body?.password || req.body?.adminPwd  || req.body?.admin_pwd;

  const authHeader = req.headers['authorization'];
  if ((!user || !pwd) && authHeader && authHeader.startsWith('Basic ')) {
    try {
      const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf8');
      const colonIdx = credentials.indexOf(':');
      if (colonIdx !== -1) {
        user = credentials.substring(0, colonIdx);
        pwd  = credentials.substring(colonIdx + 1);
      }
    } catch (_) {}
  }

  if (!user || !pwd) {
    user = req.headers['x-admin-user'] || user;
    pwd  = req.headers['x-admin-pwd'] || pwd;
  }

  if (!user || !pwd) {
    return res.status(400).json({ success: false, error: 'username and password are required' });
  }

  if (user !== adminUser || pwd !== adminPwd) {
    logger.warn('ADMIN_LOGIN_FAILED', { user, ip: req.socket.remoteAddress });
    return res.status(401).json({ success: false, error: 'Invalid admin username or password' });
  }

  const jwtToken = generateToken({ username: user, role: 'admin' });
  const basicToken = Buffer.from(`${user}:${pwd}`).toString('base64');
  logger.info('ADMIN_LOGIN_SUCCESS', { user, ip: req.socket.remoteAddress });

  res.json({
    success: true,
    message: 'Admin authenticated successfully',
    token: jwtToken,
    auth: {
      type: 'Bearer',
      token: jwtToken,
      header: `Bearer ${jwtToken}`,
      expiresIn: '24h',
      basicToken,
    },
    user: {
      username: user,
      role: 'admin',
    },
  });
});

// ── Apply Admin Authentication to All Device & Command Endpoints ───────────────
router.use(adminAuth);

// ── GET /api/gps/devices ──────────────────────────────────────────────────────
router.get('/devices', (_req, res) => {
  const devices = getConnectedDevices();
  res.json({
    success: true,
    count:   devices.length,
    devices,
  });
});

// ── GET /api/gps/devices/:imei ────────────────────────────────────────────────
router.get('/devices/:imei', (req, res) => {
  const { imei } = req.params;
  const device = getDeviceState(imei);
  if (!device) {
    return res.status(404).json({
      success: false,
      error: `Device ${imei} not found in registry`,
      connected: false,
    });
  }
  res.json({ success: true, device });
});

// ── 1. POST /api/gps/devices/:imei/password (S1) ──────────────────────────────
router.post('/devices/:imei/password', async (req, res) => {
  const { imei } = req.params;
  const { oldPassword = '123456', newPassword } = req.body || {};

  if (!newPassword) {
    return res.status(400).json({ success: false, error: 'newPassword is required' });
  }

  const result = await sendDeviceCommand(imei, 'S1', [oldPassword, newPassword]);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent S1 Change Password command to device ${imei}`,
    result,
  });
});

// ── 2. POST /api/gps/devices/:imei/center-number (S2) ────────────────────────────
router.post('/devices/:imei/center-number', async (req, res) => {
  const { imei } = req.params;
  const { number } = req.body || {};

  if (!number) {
    return res.status(400).json({ success: false, error: 'number is required' });
  }

  const result = await sendDeviceCommand(imei, 'S2', [number]);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent S2 Center Number command (${number}) to device ${imei}`,
    result,
  });
});

// ── 3. POST /api/gps/devices/:imei/admin-numbers (S3) ────────────────────────────
router.post('/devices/:imei/admin-numbers', async (req, res) => {
  const { imei } = req.params;
  const { numbers = [] } = req.body || {};

  const numList = Array.isArray(numbers) ? numbers : [numbers];
  if (numList.length === 0 || !numList[0]) {
    return res.status(400).json({ success: false, error: 'numbers array (up to 5 phone numbers) is required' });
  }

  const result = await sendDeviceCommand(imei, 'S3', numList.slice(0, 5));
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent S3 Admin Numbers command (${numList.join(', ')}) to device ${imei}`,
    result,
  });
});

// ── 4. POST /api/gps/devices/:imei/alarm-mode (S18) ──────────────────────────────
router.post('/devices/:imei/alarm-mode', async (req, res) => {
  const { imei } = req.params;
  const { mode = 1 } = req.body || {};

  // 0: close SMS & Calling, 1: SMS alarm, 2: Calling center number
  const result = await sendDeviceCommand(imei, 'S18', [mode]);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent S18 Alarm Mode command (${mode}) to device ${imei}`,
    result,
  });
});

// ── 5. POST /api/gps/devices/:imei/alarm-types (S19) ──────────────────────────
router.post('/devices/:imei/alarm-types', async (req, res) => {
  const { imei } = req.params;
  const { alarmType = 1, enable = true } = req.body || {};

  // alarmType: 0=Power cut, 1=ACC, 2=Low battery, 3=Vibrate, 4=Removal
  // enable: 1=Open alarm, 0=Close alarm
  const enableBit = (enable === true || enable === 1 || enable === '1') ? 1 : 0;
  const result = await sendDeviceCommand(imei, 'S19', [alarmType, enableBit]);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent S19 Alarm Type command (type=${alarmType}, enable=${enableBit}) to device ${imei}`,
    result,
  });
});

// ── 6. POST /api/gps/devices/:imei/cut-fuel (S20 Disable) ────────────────────────
router.post('/devices/:imei/cut-fuel', async (req, res) => {
  const { imei } = req.params;
  const { dynamic = false } = req.body || {};

  // C=0: Dynamic (checks engine instantaneous status for 5s)
  // C=1: Static (relay continuously cuts fuel)
  const params = dynamic
    ? [0, 5]
    : [1, 3, 10, 3, 5, 5, 7];

  const result = await sendDeviceCommand(imei, 'S20', params);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent S20 Disable Fuel command to device ${imei}`,
    result,
  });
});

// ── 6b. POST /api/gps/devices/:imei/restore-fuel (S20 Enable) ─────────────────────
router.post('/devices/:imei/restore-fuel', async (req, res) => {
  const { imei } = req.params;

  // time1=0 is enable fuel/electricity
  const result = await sendDeviceCommand(imei, 'S20', [1, 0]);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent S20 Restore Fuel command to device ${imei}`,
    result,
  });
});

// ── 7. POST /api/gps/devices/:imei/geofence (S21) ────────────────────────────────
router.post('/devices/:imei/geofence', async (req, res) => {
  const { imei } = req.params;
  const { radiusMeters = 1000, mode = 1 } = req.body || {};

  // mode: 1=Out fence, 2=In fence, 3=In and Out fence. 0 radius=close fence
  const result = await sendDeviceCommand(imei, 'S21', [radiusMeters, mode]);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent S21 Geofence command (radius=${radiusMeters}m, mode=${mode}) to device ${imei}`,
    result,
  });
});

// ── 8. POST /api/gps/devices/:imei/server-address (S23) ───────────────────────
router.post('/devices/:imei/server-address', async (req, res) => {
  const { imei } = req.params;
  const { ip, port = 5022 } = req.body || {};

  if (!ip) {
    return res.status(400).json({ success: false, error: 'ip is required (e.g. "140.238.88.183")' });
  }

  // Format: *HQ,IMEI,S23,HHMMSS,116,205,4,25,8800#
  const ipFormatted = ip.replace(/\./g, ',');
  const result = await sendDeviceCommand(imei, 'S23', [ipFormatted, port]);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent S23 Set Server Address command (${ip}:${port}) to device ${imei}`,
    result,
  });
});

// ── 9. POST /api/gps/devices/:imei/apn (S24) ──────────────────────────────────
router.post('/devices/:imei/apn', async (req, res) => {
  const { imei } = req.params;
  const { apn, apnUser = '', apnPassword = '' } = req.body || {};

  if (!apn) {
    return res.status(400).json({ success: false, error: 'apn is required (e.g. "CMNET")' });
  }

  const result = await sendDeviceCommand(imei, 'S24', [apn, apnUser, apnPassword]);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent S24 Set APN command (${apn}) to device ${imei}`,
    result,
  });
});

// ── 10. POST /api/gps/devices/:imei/factory-reset (S25) ────────────────────────
router.post('/devices/:imei/factory-reset', async (req, res) => {
  const { imei } = req.params;

  const result = await sendDeviceCommand(imei, 'S25', []);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent S25 Factory Default Reset command to device ${imei}`,
    result,
  });
});

// ── 11. POST /api/gps/devices/:imei/read-state (S26) ───────────────────────────
router.post('/devices/:imei/read-state', async (req, res) => {
  const { imei } = req.params;
  const { type = 0 } = req.body || {};

  // W=0: basic data, W=1: software version, W=2: other data
  const result = await sendDeviceCommand(imei, 'S26', [type]);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent S26 Read State command (type=${type}) to device ${imei}`,
    result,
  });
});

// ── 12. POST /api/gps/devices/:imei/overspeed (S33) ────────────────────────────
router.post('/devices/:imei/overspeed', async (req, res) => {
  const { imei } = req.params;
  const { speedKmh = 80 } = req.body || {};

  const speed = parseInt(speedKmh, 10);
  if (isNaN(speed) || speed < 0) {
    return res.status(400).json({ success: false, error: 'speedKmh must be 0 (disabled) or a positive integer' });
  }

  const result = await sendDeviceCommand(imei, 'S33', [speed]);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent S33 Overspeed Limit command (${speed} km/h) to device ${imei}`,
    result,
  });
});

// ── 13. POST /api/gps/devices/:imei/check-lbs (S80) ───────────────────────────
router.post('/devices/:imei/check-lbs', async (req, res) => {
  const { imei } = req.params;
  const { baseCount = 3 } = req.body || {};

  const count = Math.min(Math.max(parseInt(baseCount, 10) || 3, 1), 7);
  const result = await sendDeviceCommand(imei, 'S80', [count]);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent S80 Check LBS command (baseCount=${count}) to device ${imei}`,
    result,
  });
});

// ── 14. POST /api/gps/devices/:imei/interval (D1) ──────────────────────────────
router.post('/devices/:imei/interval', async (req, res) => {
  const { imei } = req.params;
  const { intervalSeconds = 30 } = req.body || {};

  const interval = parseInt(intervalSeconds, 10);
  if (isNaN(interval) || interval < 5 || interval > 86400) {
    return res.status(400).json({
      success: false,
      error: 'intervalSeconds must be an integer between 5 and 86400 seconds',
    });
  }

  const result = await sendDeviceCommand(imei, 'D1', [interval]);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent D1 interval=${interval}s command to device ${imei}`,
    result,
  });
});

// ── 15. POST /api/gps/devices/:imei/fast-locate (D2) ──────────────────────────
router.post('/devices/:imei/fast-locate', async (req, res) => {
  const { imei } = req.params;
  const { openGpsSeconds = 180 } = req.body || {};

  const seconds = parseInt(openGpsSeconds, 10) || 180;
  const result = await sendDeviceCommand(imei, 'D2', [seconds]);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent D2 Fast Locate command (${seconds}s) to device ${imei}`,
    result,
  });
});

// ── 16. POST /api/gps/devices/:imei/restart (R1) ───────────────────────────────
router.post('/devices/:imei/restart', async (req, res) => {
  const { imei } = req.params;

  const result = await sendDeviceCommand(imei, 'R1', []);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent R1 Restart command to device ${imei}`,
    result,
  });
});

// ── 17. POST /api/gps/devices/:imei/working-mode (WKMD) ────────────────────────
router.post('/devices/:imei/working-mode', async (req, res) => {
  const { imei } = req.params;
  const { mode = 0 } = req.body || {};

  const modeNum = parseInt(mode, 10);
  if (![0, 1, 2, 3].includes(modeNum)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid mode. For G01/G02: 0 (Real-time 10s), 1 (LBS Power-saving 600s), 2 (Intelligent 5min)',
    });
  }

  const result = await sendDeviceCommand(imei, 'WKMD', [modeNum]);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent WKMD mode=${modeNum} command to device ${imei}`,
    result,
  });
});

// ── POST /api/gps/devices/:imei/raw (Generic Raw Command) ──────────────────────
router.post('/devices/:imei/raw', async (req, res) => {
  const { imei } = req.params;
  const { command, params = [] } = req.body || {};

  if (!command) {
    return res.status(400).json({ success: false, error: 'command is required (e.g. "WKMD", "D1", "S20")' });
  }

  const result = await sendDeviceCommand(imei, command, params);
  if (!result.success) {
    return res.status(result.connected === false ? 404 : 500).json(result);
  }
  res.json({
    success: true,
    message: `Sent command to device ${imei}`,
    result,
  });
});

// ── GET /api/gps/logs (Server & TCP Logs) ──────────────────────────────────────
const { getRecentLogs, clearRecentLogs } = require('./logger');

router.get('/logs', (req, res) => {
  const limit = parseInt(req.query.limit || '200', 10);
  const level = req.query.level || null;
  const logs = getRecentLogs(limit, level);

  res.json({
    success: true,
    count: logs.length,
    logs,
  });
});

// ── DELETE /api/gps/logs (Clear Log Buffer) ────────────────────────────────────
router.delete('/logs', (_req, res) => {
  clearRecentLogs();
  res.json({
    success: true,
    message: 'Server log buffer cleared successfully',
  });
});

module.exports = router;
