'use strict';

const express = require('express');
const {
  getConnectedDevices,
  getDeviceState,
  sendDeviceCommand,
  sendRawDeviceCommand,
  isDeviceConnected,
  buildCantrackCommand,
  buildSecumoreCommand,
  sanitizeCommandString,
  updateDeviceState,
  deviceRegistry,
  deviceStates,
} = require('./gt06Server');
const {
  enqueueCommand,
  getQueuedCommands,
  cancelQueuedCommand,
  clearQueue,
  flushQueuedCommands,
} = require('./services/commandQueue');
const {
  createUser,
  findUserByEmailOrUsername,
  findUserByUsername,
  findUserById,
  deleteUser,
  saveDeletionOtp,
  getDeletionOtp,
  removeDeletionOtp,
  registerNewDevice,
  getAllDevices,
  getDeviceByImei,
  getDevicesByUser,
  updateDeviceInfo,
  deleteDevice,
  getLocationHistory,
  getCommandLogs,
  upsertDevice,
  saveLocationHistory,
} = require('./db/mysql');
const { sendAccountDeletionOtp } = require('./services/emailService');
const { gpsEventEmitter } = require('./gpsEvents');
const {
  adminAuth,
  generateToken,
  verifyPassword,
  requireAdmin,
} = require('./adminAuth');
const { logger, getRecentLogs, clearRecentLogs } = require('./logger');

const router = express.Router();

/**
 * Check if the authenticated user has permission to view or control the specified IMEI.
 * - Admin: Can control and view all IMEIs.
 * - User: Can only control and view devices registered to their userId.
 */
async function checkDeviceAccess(imei, user) {
  if (!imei || !user) return false;
  if (user.role === 'admin') return true;

  const targetImei = String(imei).trim();

  // 1. Check in-memory state
  const memState = getDeviceState(targetImei);
  if (memState && memState.userId && String(memState.userId) === String(user.id)) {
    return true;
  }

  // 2. Check MySQL database record
  const dbDevice = await getDeviceByImei(targetImei);
  if (dbDevice && dbDevice.user_id && String(dbDevice.user_id) === String(user.id)) {
    return true;
  }

  return false;
}

/**
 * Middleware ensuring the requester has permission to access or command the device specified in req.params.imei.
 */
async function requireDeviceAccess(req, res, next) {
  const { imei } = req.params;
  const hasAccess = await checkDeviceAccess(imei, req.user);

  if (!hasAccess) {
    logger.warn('DEVICE_ACCESS_DENIED', {
      imei,
      userId: req.user?.id,
      username: req.user?.username,
      role: req.user?.role,
      path: req.path,
    });
    return res.status(403).json({
      success: false,
      error: `Forbidden: You do not have permission to control or view device ${imei}. Contact an administrator or register the device to your account.`,
    });
  }

  next();
}

// Helper to send command immediately or queue if device is sleeping/offline
async function dispatchOrQueue(imei, cmdCode, params = [], req, res, sendFn = sendDeviceCommand) {
  const result = await enqueueCommand(imei, cmdCode, params, {}, sendFn, isDeviceConnected);
  if (!result.success && !result.queued) {
    return res.status(500).json(result);
  }
  return res.json({
    success: true,
    queued: result.queued || false,
    message: result.message || `Command ${cmdCode} processed successfully for device ${imei}`,
    result,
  });
}

// ── 1. POST /api/gps/auth/register (User Registration with Email & Password) ─
router.post('/auth/register', async (req, res) => {
  const { email, password, name = '', phone = '', username = '', role = 'user' } = req.body || {};
  const userEmail = (email || username || '').trim().toLowerCase();

  if (!userEmail || !password) {
    return res.status(400).json({
      success: false,
      error: 'email and password are required',
    });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(userEmail)) {
    return res.status(400).json({
      success: false,
      error: 'Please provide a valid email address',
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      error: 'Password must be at least 6 characters long',
    });
  }

  try {
    // Only admins can create another admin account
    const requestedRole = (role === 'admin' && req.user?.role === 'admin') ? 'admin' : 'user';
    const newUser = await createUser({
      email: userEmail,
      username: username ? username.trim().toLowerCase() : userEmail,
      password,
      name: name ? name.trim() : '',
      phone: phone ? phone.trim() : '',
      role: requestedRole,
    });

    const jwtToken = generateToken({
      id: newUser.id,
      email: newUser.email,
      username: newUser.username,
      name: newUser.name,
      role: newUser.role,
    });

    logger.info('USER_REGISTERED_SUCCESS', {
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
      ip: req.socket.remoteAddress,
    });

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      token: jwtToken,
      auth: {
        type: 'Bearer',
        token: jwtToken,
        header: `Bearer ${jwtToken}`,
        expiresIn: '24h',
      },
      user: {
        id: newUser.id,
        email: newUser.email,
        username: newUser.username,
        name: newUser.name,
        phone: newUser.phone,
        role: newUser.role,
      },
    });
  } catch (err) {
    logger.warn('USER_REGISTRATION_FAILED', { email: userEmail, error: err.message });
    return res.status(400).json({
      success: false,
      error: err.message || 'Failed to register user',
    });
  }
});

// ── 2. POST /api/gps/auth/login (User & Admin Login) ──────────────────────────
router.post('/auth/login', async (req, res) => {
  const adminUser = (process.env.ADMIN_USER || process.env.GATEWAY_USERNAME || 'momohofficial@gmail.com').toLowerCase();
  const adminPwd  = process.env.ADMIN_PWD  || process.env.GATEWAY_PASSWORD || '@Samuel196';

  let user = req.body?.email || req.body?.username || req.body?.adminUser || req.body?.admin_user;
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
    return res.status(400).json({ success: false, error: 'email/username and password are required' });
  }

  const cleanIdentifier = String(user).trim().toLowerCase();

  // 1. Check MySQL / In-memory user store first
  const dbUser = await findUserByEmailOrUsername(cleanIdentifier);
  if (dbUser && verifyPassword(pwd, dbUser.password_hash)) {
    const jwtToken = generateToken({
      id: dbUser.id,
      email: dbUser.email,
      username: dbUser.username,
      name: dbUser.name,
      role: dbUser.role || 'user',
    });
    logger.info('USER_LOGIN_SUCCESS', { user: dbUser.email || dbUser.username, role: dbUser.role, ip: req.socket.remoteAddress });

    return res.json({
      success: true,
      message: 'Authenticated successfully',
      token: jwtToken,
      auth: {
        type: 'Bearer',
        token: jwtToken,
        header: `Bearer ${jwtToken}`,
        expiresIn: '24h',
      },
      user: {
        id: dbUser.id,
        email: dbUser.email,
        username: dbUser.username,
        name: dbUser.name,
        phone: dbUser.phone,
        role: dbUser.role,
      },
    });
  }

  // 2. Fallback: Check environment admin credentials
  if (cleanIdentifier === adminUser && pwd === adminPwd) {
    const jwtToken = generateToken({ username: cleanIdentifier, email: cleanIdentifier, role: 'admin' });
    const basicToken = Buffer.from(`${cleanIdentifier}:${pwd}`).toString('base64');
    logger.info('ADMIN_LOGIN_SUCCESS', { user: cleanIdentifier, ip: req.socket.remoteAddress });

    return res.json({
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
        username: cleanIdentifier,
        email: cleanIdentifier,
        role: 'admin',
      },
    });
  }

  logger.warn('LOGIN_FAILED', { user, ip: req.socket.remoteAddress });
  return res.status(401).json({ success: false, error: 'Invalid username or password' });
});

// ── 3. POST /api/gps/auth/delete-account (2-Step Account Deletion Flow) ───────
/**
 * Two-Step Account Deletion Flow:
 *
 * Step 1: Request Deletion Code
 *   Body: { "email": "user@example.com", "reason": "No longer needed", "verify": false }
 *   Action: Validates user existence, generates 6-digit OTP code, stores code for 15 mins,
 *           and dispatches verification code email via SendGrid (SEND_API_KEY).
 *
 * Step 2: Confirm Deletion with Code
 *   Body: { "email": "user@example.com", "code": "123456", "verify": true, "reason": "..." }
 *   Action: Validates OTP code against email, permanently purges user account and all
 *           registered GPS trackers and location history.
 */
async function handleAccountDeletion(req, res) {
  const {
    email,
    username,
    reason = '',
    code = '',
    verify = false,
  } = req.body || {};

  const targetEmail = (email || username || req.user?.email || '').trim().toLowerCase();

  if (!targetEmail) {
    return res.status(400).json({
      success: false,
      error: 'email is required for account deletion',
    });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(targetEmail)) {
    return res.status(400).json({
      success: false,
      error: 'Please provide a valid email address',
    });
  }

  const isVerifyStep = verify === true || verify === 'true' || Boolean(code && String(code).trim());

  // ── STEP 2: Verify OTP & Permanently Delete Account ──────────────────────────
  if (isVerifyStep) {
    const cleanCode = String(code).trim();
    if (!cleanCode) {
      return res.status(400).json({
        success: false,
        error: 'Verification code (code) is required when verify is true',
      });
    }

    const stored = getDeletionOtp(targetEmail);
    if (!stored) {
      return res.status(400).json({
        success: false,
        error: 'Verification code has expired or was not requested. Please request a new code.',
      });
    }

    if (String(stored.code).trim() !== cleanCode) {
      logger.warn('ACCOUNT_DELETION_INVALID_CODE', {
        email: targetEmail,
        attemptedCode: cleanCode,
        ip: req.socket.remoteAddress,
      });
      return res.status(400).json({
        success: false,
        error: 'Invalid verification code. Please check your email and try again.',
      });
    }

    // Verify user exists in database
    const user = await findUserByEmailOrUsername(targetEmail);
    if (!user) {
      removeDeletionOtp(targetEmail);
      return res.status(404).json({
        success: false,
        error: 'No registered account found with this email address.',
      });
    }

    try {
      // Permanently purge user account and all owned devices
      await deleteUser(user.id || targetEmail);
      removeDeletionOtp(targetEmail);

      logger.info('ACCOUNT_DELETION_CONFIRMED', {
        email: targetEmail,
        userId: user.id,
        reason: reason || stored.reason || 'None provided',
        ip: req.socket.remoteAddress,
      });

      return res.json({
        success: true,
        verify: true,
        message: 'Your account and all associated GPS devices and data have been permanently deleted.',
        email: targetEmail,
        deletedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.error('ACCOUNT_DELETION_FAILED', { email: targetEmail, error: err.message });
      return res.status(500).json({
        success: false,
        error: 'Failed to complete account deletion: ' + err.message,
      });
    }
  }

  // ── STEP 1: Generate & Dispatch 6-Digit OTP via SendGrid ─────────────────────
  const user = await findUserByEmailOrUsername(targetEmail);
  if (!user) {
    return res.status(404).json({
      success: false,
      error: `No registered account found with email '${targetEmail}'.`,
    });
  }

  // Generate secure 6-digit random code
  const generatedCode = Math.floor(100000 + Math.random() * 900000).toString();

  // Store in memory OTP map with 15-minute expiration
  saveDeletionOtp(targetEmail, {
    code: generatedCode,
    reason: reason ? String(reason).trim() : '',
    expiresAt: Date.now() + 15 * 60 * 1000,
  });

  logger.info('ACCOUNT_DELETION_OTP_GENERATED', {
    email: targetEmail,
    ip: req.socket.remoteAddress,
  });

  // Dispatch email via SendGrid
  const emailSent = await sendAccountDeletionOtp(targetEmail, generatedCode, reason);

  return res.json({
    success: true,
    verify: false,
    email: targetEmail,
    message: 'A 6-digit verification code has been sent to your email. Please submit the code with verify: true to confirm permanent deletion.',
    expiresInMinutes: 15,
    emailDispatched: emailSent,
  });
}

router.post('/auth/delete-account', handleAccountDeletion);
router.post('/auth/account/delete', handleAccountDeletion);

// ── Apply Authentication to All Protected Endpoints ──────────────────────────
router.use(adminAuth);

// ── GET /api/gps/auth/me (Current User Profile) ───────────────────────────────
router.get('/auth/me', (req, res) => {
  res.json({
    success: true,
    user: req.user,
  });
});

// ── GET /api/gps/devices ──────────────────────────────────────────────────────
router.get('/devices', async (req, res) => {
  try {
    // 1. Fetch persistent devices from MySQL database
    const dbDevices = req.user?.role === 'admin'
      ? await getAllDevices()
      : await getDevicesByUser(req.user?.id);

    // 2. Map of in-memory active TCP sockets & states
    const memoryStates = new Map();
    for (const [imei, state] of deviceStates.entries()) {
      memoryStates.set(String(imei), {
        ...state,
        connected: deviceRegistry.has(imei),
      });
    }

    // 3. Merge database records with in-memory state
    const mergedMap = new Map();

    // Add all DB devices first
    for (const d of dbDevices) {
      const imei = String(d.imei);
      const memState = memoryStates.get(imei);
      mergedMap.set(imei, {
        imei,
        name: d.name || `Vehicle ${imei.slice(-4)}`,
        plateNumber: d.plate_number || d.plateNumber || '',
        simNumber: d.sim_number || d.simNumber || '',
        model: d.model || 'Cantrack G02',
        protocol: d.protocol || 'HQ',
        userId: d.user_id || d.userId || null,
        icon: d.icon || null,
        connected: memState ? memState.connected : Boolean(d.connected),
        lastSeenAt: memState?.lastActivityAt || d.last_seen_at || d.updated_at || null,
        lastLocation: memState?.lastLocation || {
          latitude: d.last_latitude ? parseFloat(d.last_latitude) : null,
          longitude: d.last_longitude ? parseFloat(d.last_longitude) : null,
          speed_kmh: d.speed_kmh ? parseFloat(d.speed_kmh) : 0,
          direction: d.direction ? parseInt(d.direction, 10) : 0,
          gpsStatus: d.gps_status || 'A',
          timestamp: d.last_seen_at || null,
        },
        vehicleStatus: memState?.vehicleStatus || {
          accOn: Boolean(d.acc_on),
          isOilCut: Boolean(d.is_oil_cut),
          isBackupBattery: Boolean(d.is_backup_battery),
          gpsFixed: d.gps_status === 'A',
          doorOpen: false,
          alarms: [],
        },
      });
    }

    // Also include any in-memory devices not yet in DB (e.g. freshly connected)
    for (const [imei, memState] of memoryStates.entries()) {
      if (!mergedMap.has(imei)) {
        if (req.user?.role === 'admin' || (memState.userId && String(memState.userId) === String(req.user?.id))) {
          mergedMap.set(imei, memState);
        }
      }
    }

    const deviceList = Array.from(mergedMap.values());

    res.json({
      success: true,
      count: deviceList.length,
      devices: deviceList,
    });
  } catch (err) {
    logger.error('GET_DEVICES_ROUTE_ERROR', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/gps/devices (Register New Device) ────────────────────────────────
router.post('/devices', async (req, res) => {
  const {
    imei,
    name = '',
    plateNumber,
    plate_number,
    simNumber,
    sim_number,
    model = 'Cantrack G02',
    userId,
    user_id,
    protocol = 'HQ',
    icon = null,
  } = req.body || {};

  if (!imei || typeof imei !== 'string') {
    return res.status(400).json({ success: false, error: '15-digit imei is required' });
  }

  const cleanImei = imei.trim();
  if (!/^\d{11,16}$/.test(cleanImei)) {
    return res.status(400).json({ success: false, error: 'Invalid IMEI format. Must be numeric 11-16 digits.' });
  }

  const finalPlate = (plateNumber || plate_number || '').trim();
  const finalSim = (simNumber || sim_number || '').trim();
  const finalModel = (model || 'Cantrack G02').trim();
  const reqUserId = userId !== undefined ? userId : user_id;
  const finalIcon = icon !== undefined && icon !== null ? (typeof icon === 'string' ? icon.trim() : JSON.stringify(icon)) : null;

  // Non-admins can only register devices to themselves
  const assignedUserId = req.user?.role === 'admin' ? (reqUserId || req.user?.id || null) : req.user?.id;

  try {
    const registered = await registerNewDevice({
      imei: cleanImei,
      name: name ? name.trim() : `Vehicle ${cleanImei.slice(-4)}`,
      plateNumber: finalPlate,
      simNumber: finalSim,
      model: finalModel,
      userId: assignedUserId,
      protocol: protocol || 'HQ',
      icon: finalIcon,
    });

    // Update in-memory state cache
    updateDeviceState(cleanImei, {
      imei: cleanImei,
      name: registered.name,
      plateNumber: registered.plateNumber,
      simNumber: registered.simNumber,
      model: registered.model,
      userId: registered.userId,
      protocol: registered.protocol,
      icon: registered.icon,
    });

    logger.info('DEVICE_REGISTERED', {
      imei: cleanImei,
      name: registered.name,
      plateNumber: registered.plateNumber,
      userId: assignedUserId,
      registeredBy: req.user?.username,
    });

    res.status(201).json({
      success: true,
      message: `Device ${cleanImei} registered successfully`,
      device: {
        ...registered,
        connected: isDeviceConnected(cleanImei),
      },
    });
  } catch (err) {
    logger.error('DEVICE_REGISTRATION_FAILED', { imei: cleanImei, error: err.message });
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to register device',
    });
  }
});

// ── GET /api/gps/devices/:imei ────────────────────────────────────────────────
router.get('/devices/:imei', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  let device = getDeviceState(imei);
  
  if (!device) {
    const dbDevice = await getDeviceByImei(imei);
    if (dbDevice) {
      device = {
        imei: String(dbDevice.imei),
        name: dbDevice.name || `Vehicle ${String(dbDevice.imei).slice(-4)}`,
        plateNumber: dbDevice.plate_number || dbDevice.plateNumber || '',
        simNumber: dbDevice.sim_number || dbDevice.simNumber || '',
        model: dbDevice.model || 'Cantrack G02',
        protocol: dbDevice.protocol || 'HQ',
        userId: dbDevice.user_id || dbDevice.userId || null,
        icon: dbDevice.icon || null,
        connected: false,
        lastSeenAt: dbDevice.last_seen_at || dbDevice.updated_at || null,
        lastLocation: {
          latitude: dbDevice.last_latitude ? parseFloat(dbDevice.last_latitude) : null,
          longitude: dbDevice.last_longitude ? parseFloat(dbDevice.last_longitude) : null,
          speed_kmh: dbDevice.speed_kmh ? parseFloat(dbDevice.speed_kmh) : 0,
          direction: dbDevice.direction ? parseInt(dbDevice.direction, 10) : 0,
          gpsStatus: dbDevice.gps_status || 'A',
          timestamp: dbDevice.last_seen_at || null,
        },
        vehicleStatus: {
          accOn: Boolean(dbDevice.acc_on),
          isOilCut: Boolean(dbDevice.is_oil_cut),
          isBackupBattery: Boolean(dbDevice.is_backup_battery),
          gpsFixed: dbDevice.gps_status === 'A',
          doorOpen: false,
          alarms: [],
        },
      };
    }
  }

  if (!device) {
    return res.status(404).json({
      success: false,
      error: `Device ${imei} not found in registry or database`,
      connected: false,
    });
  }
  res.json({ success: true, device });
});

// ── PUT /api/gps/devices/:imei (Update Device Metadata) ───────────────────────
router.put('/devices/:imei', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const {
    name,
    plateNumber,
    plate_number,
    simNumber,
    sim_number,
    model,
    userId,
    user_id,
    icon,
  } = req.body || {};

  const finalPlate = plateNumber !== undefined ? plateNumber : plate_number;
  const finalSim = simNumber !== undefined ? simNumber : sim_number;
  const reqUserId = userId !== undefined ? userId : user_id;
  const finalIcon = icon !== undefined ? (icon !== null && typeof icon === 'string' ? icon.trim() : icon) : undefined;

  // Non-admins cannot transfer device ownership
  const targetUserId = req.user?.role === 'admin' ? reqUserId : undefined;

  try {
    await updateDeviceInfo(imei, {
      name,
      plateNumber: finalPlate,
      simNumber: finalSim,
      model,
      userId: targetUserId,
      icon: finalIcon,
    });

    updateDeviceState(imei, {
      ...(name !== undefined ? { name } : {}),
      ...(finalPlate !== undefined ? { plateNumber: finalPlate } : {}),
      ...(finalSim !== undefined ? { simNumber: finalSim } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(targetUserId !== undefined ? { userId: targetUserId } : {}),
      ...(finalIcon !== undefined ? { icon: finalIcon } : {}),
    });

    logger.info('DEVICE_UPDATED', { imei, updates: req.body });
    res.json({
      success: true,
      message: `Device ${imei} updated successfully`,
      device: getDeviceState(imei),
    });
  } catch (err) {
    logger.error('DEVICE_UPDATE_FAILED', { imei, error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/gps/devices/:imei (Delete Device & Purge All Records) ───────
router.delete('/devices/:imei', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const targetImei = String(imei).trim();

  try {
    // 1. Clear queued commands in Redis
    await clearQueue(targetImei).catch(() => {});

    // 2. Permanently purge from MySQL (devices, location_history, command_logs)
    await deleteDevice(targetImei);

    // 3. Destroy active TCP socket if connected
    const socket = deviceRegistry.get(targetImei);
    if (socket && !socket.destroyed) {
      socket.destroy();
    }
    deviceRegistry.delete(targetImei);
    deviceStates.delete(targetImei);

    // 4. Emit event so real-time dashboards immediately remove device
    gpsEventEmitter.emit('gps:device_deleted', { imei: targetImei });

    logger.info('DEVICE_AND_RECORDS_DELETED', {
      imei: targetImei,
      deletedBy: req.user?.email || req.user?.username,
      role: req.user?.role,
    });

    res.json({
      success: true,
      message: `Device ${targetImei} and all its records (location history, command logs, queue) were deleted successfully.`,
      imei: targetImei,
    });
  } catch (err) {
    logger.error('DEVICE_DELETE_FAILED', { imei: targetImei, error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Unified Command Router: POST /api/gps/command/:imei/:cmd ──────────────────
router.post('/command/:imei/:cmd', requireDeviceAccess, async (req, res) => {
  const { imei, cmd } = req.params;
  const body = req.body || {};

  let cmdCode = cmd;
  let params = [];

  switch (cmd) {
    case 'cut_fuel':
    case 'cut-fuel':
    case 'stopoil':
    case 'cut_elec':
    case 'cut-elec':
    case 'stopelec': {
      cmdCode = 'S20';
      const isDynamic = body.dynamic !== undefined ? Boolean(body.dynamic) : (body.mode === 'dynamic' || body.long === true);
      params = Array.isArray(body.params) && body.params.length > 0
        ? body.params
        : (isDynamic ? [1, 3, 10, 3, 5, 5, 3, 5, 3, 5, 3, 5] : [1, 1]);
      break;
    }
    case 'resume_fuel':
    case 'resume-fuel':
    case 'restore-fuel':
    case 'restore_fuel':
    case 'supplyoil':
    case 'resume_elec':
    case 'resume-elec':
    case 'restore_elec':
    case 'restore-elec':
    case 'supplyelec':
      cmdCode = 'S20';
      params = [1, 0]; // C=1 (Static), time1=0 (Enable fuel)
      break;
    case 'restart':
    case 'reset':
    case 'begin':
      cmdCode = 'R1';
      params = [];
      break;
    case 'set_upload_interval':
    case 'set-upload-interval':
    case 'interval':
    case 'at':
      cmdCode = 'D1';
      params = [body.interval || body.intervalSeconds || 30];
      break;
    case 'set_tracker_mode':
    case 'set-tracker-mode':
    case 'tracker':
    case 'working_mode':
    case 'working-mode':
      cmdCode = 'WKMD';
      params = [body.mode !== undefined ? body.mode : 0];
      break;
    case 'set_apn':
    case 'set-apn':
      cmdCode = 'S24';
      params = [body.apn || '', body.username || body.apnUser || '', body.password || body.apnPassword || ''];
      break;
    case 'set_ip':
    case 'set-ip':
      cmdCode = 'S23';
      const rawIp = body.ip || '140.238.88.183';
      const ipParts = rawIp.includes(',') ? rawIp.split(',')[0].replace(/\./g, ',') : rawIp.replace(/\./g, ',');
      const port = body.port || (rawIp.includes(',') ? rawIp.split(',')[1] : '5022');
      params = [ipParts, port];
      break;
    case 'set_center_number':
    case 'set-center-number':
    case 'center':
      cmdCode = 'S2';
      params = [body.phoneNumber || body.number || ''];
      break;
    case 'set_sos_numbers':
    case 'set-sos-numbers':
    case 'admin':
    case 'set_admin':
      cmdCode = 'S3';
      params = Array.isArray(body.phoneNumbers || body.numbers)
        ? (body.phoneNumbers || body.numbers).slice(0, 5)
        : [(body.phoneNumber || body.number || '')];
      break;
    case 'set_speed_alarm':
    case 'set-speed-alarm':
    case 'speed':
    case 'overspeed':
      cmdCode = 'S33';
      params = [body.speedLimit || body.speed || 80];
      break;
    case 'clear_speed_alarm':
    case 'clear-speed-alarm':
    case 'nospeed':
      cmdCode = 'S33';
      params = [0];
      break;
    case 'set_geofence':
    case 'set-geofence':
    case 'geofence':
      cmdCode = 'S21';
      params = [body.radius || 1000, body.mode || 1];
      break;
    case 'clear_geofence':
    case 'clear-geofence':
      cmdCode = 'S21';
      params = [0, 1];
      break;
    case 'check_location':
    case 'check-location':
    case 'fast_locate':
    case 'fast-locate':
      cmdCode = 'D2';
      params = [body.seconds || body.openGpsSeconds || 180];
      break;
    case 'check_status':
    case 'check-status':
    case 'read_state':
    case 'read-state':
      cmdCode = 'S26';
      params = [0];
      break;
    case 'check_params':
    case 'check-params':
      cmdCode = 'S26';
      params = [1];
      break;
    case 'check_lbs':
    case 'check-lbs':
    case 'lbs_check':
    case 'lbs-check':
      cmdCode = 'S80';
      params = [body.baseNumber || body.baseCount || 3];
      break;
    case 'set_alarm_mode':
    case 'set-alarm-mode':
    case 'alarm_mode':
    case 'alarm-mode':
      cmdCode = 'S18';
      params = [body.mode !== undefined ? body.mode : 1];
      break;
    case 'set_alarm_type':
    case 'set-alarm-type':
    case 'alarm_type':
    case 'alarm-type':
      cmdCode = 'S19';
      params = [body.alarmType || 1, body.enable !== undefined ? (body.enable ? 1 : 0) : 1];
      break;
    case 'set_power_alarm':
    case 'set-power-alarm':
      cmdCode = 'S19';
      params = [0, 1];
      break;
    case 'clear_power_alarm':
    case 'clear-power-alarm':
      cmdCode = 'S19';
      params = [0, 0];
      break;
    case 'factory_reset':
    case 'factory-reset':
      cmdCode = 'S25';
      params = [];
      break;
    case 'change_password':
    case 'change-password':
    case 'password':
      cmdCode = 'S1';
      params = [body.oldPassword || '123456', body.newPassword || '000000'];
      break;
    case 'raw':
      cmdCode = sanitizeCommandString(body.rawCommand || body.command || body.raw || '');
      params = Array.isArray(body.params) ? body.params : [];
      return dispatchOrQueue(imei, cmdCode, params, req, res, sendRawDeviceCommand);
    default:
      cmdCode = cmd;
      params = Array.isArray(body.params) ? body.params : (body.param !== undefined ? [body.param] : []);
      break;
  }

  return dispatchOrQueue(imei, cmdCode, params, req, res);
});

// ── Specific Command Endpoints ────────────────────────────────────────────────
router.post('/devices/:imei/password', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const { oldPassword = '123456', newPassword } = req.body || {};
  if (!newPassword) {
    return res.status(400).json({ success: false, error: 'newPassword is required' });
  }
  return dispatchOrQueue(imei, 'S1', [oldPassword, newPassword], req, res);
});

router.post('/devices/:imei/center-number', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const { number } = req.body || {};
  if (!number) {
    return res.status(400).json({ success: false, error: 'number is required' });
  }
  return dispatchOrQueue(imei, 'S2', [number], req, res);
});

router.post('/devices/:imei/admin-numbers', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const { numbers = [] } = req.body || {};
  const numList = Array.isArray(numbers) ? numbers : [numbers];
  if (numList.length === 0 || !numList[0]) {
    return res.status(400).json({ success: false, error: 'numbers array (up to 5 phone numbers) is required' });
  }
  return dispatchOrQueue(imei, 'S3', numList.slice(0, 5), req, res);
});

router.post('/devices/:imei/alarm-mode', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const { mode = 0 } = req.body || {};
  return dispatchOrQueue(imei, 'S18', [mode], req, res);
});

router.post(['/devices/:imei/alarm-type', '/devices/:imei/alarm-types'], requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const { alarmType = 0 } = req.body || {};
  const isEnabled = req.body?.enable !== undefined
    ? Boolean(req.body.enable)
    : (req.body?.enabled !== undefined ? Boolean(req.body.enabled) : true);
  return dispatchOrQueue(imei, 'S19', [alarmType, isEnabled ? 1 : 0], req, res);
});

router.post('/devices/:imei/cut-fuel', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const isDynamic = req.body?.dynamic !== undefined ? Boolean(req.body.dynamic) : (req.body?.mode === 'dynamic' || req.body?.long === true);
  const params = Array.isArray(req.body?.params) && req.body.params.length > 0
    ? req.body.params
    : (isDynamic ? [1, 3, 10, 3, 5, 5, 3, 5, 3, 5, 3, 5] : [1, 1]);
  return dispatchOrQueue(imei, 'S20', params, req, res);
});

router.post(['/devices/:imei/resume-fuel', '/devices/:imei/restore-fuel'], requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  return dispatchOrQueue(imei, 'S20', [1, 0], req, res);
});

router.post('/devices/:imei/geofence', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const { radiusMeters = 1000, mode = 1 } = req.body || {};
  return dispatchOrQueue(imei, 'S21', [radiusMeters, mode], req, res);
});

router.post(['/devices/:imei/ip-port', '/devices/:imei/server-address'], requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const { ip, port = 5022 } = req.body || {};
  if (!ip) {
    return res.status(400).json({ success: false, error: 'ip is required' });
  }
  const ipParts = ip.replace(/\./g, ',');
  return dispatchOrQueue(imei, 'S23', [ipParts, port], req, res);
});

router.post('/devices/:imei/apn', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const { apn } = req.body || {};
  const username = req.body?.apnUser || req.body?.username || '';
  const password = req.body?.apnPassword || req.body?.password || '';
  if (!apn) {
    return res.status(400).json({ success: false, error: 'apn is required' });
  }
  return dispatchOrQueue(imei, 'S24', [apn, username, password], req, res);
});

router.post('/devices/:imei/factory-reset', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  return dispatchOrQueue(imei, 'S25', [], req, res);
});

router.post('/devices/:imei/read-state', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const { queryType = 0 } = req.body || {};
  return dispatchOrQueue(imei, 'S26', [queryType], req, res);
});

router.post('/devices/:imei/overspeed', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const { speedKmh = 0 } = req.body || {};
  return dispatchOrQueue(imei, 'S33', [speedKmh], req, res);
});

router.post('/devices/:imei/check-lbs', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const baseCount = req.body?.baseCount !== undefined ? req.body.baseCount : (req.body?.baseNumber || 3);
  return dispatchOrQueue(imei, 'S80', [baseCount], req, res);
});

router.post('/devices/:imei/interval', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const { intervalSeconds = 30, interval = 30 } = req.body || {};
  const secs = parseInt(intervalSeconds || interval, 10) || 30;
  return dispatchOrQueue(imei, 'D1', [secs], req, res);
});

router.post('/devices/:imei/fast-locate', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const { openGpsSeconds = 180 } = req.body || {};
  const seconds = parseInt(openGpsSeconds, 10) || 180;
  return dispatchOrQueue(imei, 'D2', [seconds], req, res);
});

router.post('/devices/:imei/restart', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  return dispatchOrQueue(imei, 'R1', [], req, res);
});

router.post('/devices/:imei/working-mode', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const { mode = 0 } = req.body || {};
  return dispatchOrQueue(imei, 'WKMD', [mode], req, res);
});

router.post('/devices/:imei/raw', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const { command, rawCommand, raw, params = [] } = req.body || {};
  const cmdToSend = rawCommand || command || raw;
  if (!cmdToSend) {
    return res.status(400).json({ success: false, error: 'command or rawCommand is required (e.g. "*HQ,867232054850970,S20,130305,1,1#")' });
  }
  const cleanCmd = sanitizeCommandString(cmdToSend);
  return dispatchOrQueue(imei, cleanCmd, params, req, res, sendRawDeviceCommand);
});

// ── Queue Management Endpoints ───────────────────────────────────────────────
router.get('/devices/:imei/queue', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const queued = await getQueuedCommands(imei);
  res.json({
    success: true,
    imei,
    count: queued.length,
    queued,
  });
});

router.delete('/devices/:imei/queue/:commandId', requireDeviceAccess, async (req, res) => {
  const { imei, commandId } = req.params;
  const cancelled = await cancelQueuedCommand(imei, commandId);
  res.json({
    success: true,
    cancelled,
    message: cancelled ? `Cancelled queued command ${commandId}` : `Command ${commandId} not found in queue`,
  });
});

router.delete('/devices/:imei/queue', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  await clearQueue(imei);
  res.json({
    success: true,
    message: `Cleared all queued commands for device ${imei}`,
  });
});

// ── Historical Trajectory & Command Logs (MySQL) ────────────────────────────
router.get('/devices/:imei/history', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const limit = parseInt(req.query.limit || '100', 10);
  const since = req.query.since || null;
  const history = await getLocationHistory(imei, limit, since);
  res.json({
    success: true,
    imei,
    count: history.length,
    history,
  });
});

router.get('/devices/:imei/command-logs', requireDeviceAccess, async (req, res) => {
  const { imei } = req.params;
  const limit = parseInt(req.query.limit || '50', 10);
  const logs = await getCommandLogs(imei, limit);
  res.json({
    success: true,
    imei,
    count: logs.length,
    logs,
  });
});

// ── GET /api/gps/logs (Server & TCP Logs - Admin Only) ─────────────────────────
router.get('/logs', requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit || '200', 10);
  const level = req.query.level || null;
  const logs = getRecentLogs(limit, level);

  res.json({
    success: true,
    count: logs.length,
    logs,
  });
});

// ── DELETE /api/gps/logs (Clear Log Buffer - Admin Only) ───────────────────────
router.delete('/logs', requireAdmin, (_req, res) => {
  clearRecentLogs();
  res.json({
    success: true,
    message: 'Server log buffer cleared successfully',
  });
});

// ── Simulation Engine: POST /api/gps/simulate or /api/gps/devices/:imei/simulate
async function handleSimulateTelemetry(req, res) {
  const targetImei = (req.params.imei || req.body?.imei || req.query?.imei || '867232054850970').trim();

  // Validate user access
  const hasAccess = await checkDeviceAccess(targetImei, req.user);
  if (!hasAccess) {
    return res.status(403).json({
      success: false,
      error: `Forbidden: You do not have permission to simulate telemetry for device ${targetImei}`,
    });
  }

  const {
    accOn = true,
    speed = 42.5,
    speed_kmh = speed,
    latitude = 4.888188,
    longitude = 6.913182,
    direction = 170,
    batteryLevel = 100,
    steps = 1,
    delayMs = 1000,
  } = req.body || {};

  const numSteps = Math.min(Math.max(parseInt(steps, 10) || 1, 1), 50);
  const baseLat = parseFloat(latitude) || 4.888188;
  const baseLng = parseFloat(longitude) || 6.913182;
  const currentSpeed = parseFloat(speed_kmh !== undefined ? speed_kmh : speed) || 42.5;
  const currentDir = parseFloat(direction) || 170;
  const isAccOn = accOn !== undefined ? Boolean(accOn) : true;

  const generatedPoints = [];

  for (let i = 0; i < numSteps; i++) {
    const ts = new Date(Date.now() + i * 10000);
    const dateStr = ts.toISOString().replace('T', ' ').replace('Z', ' UTC');
    const timeFormatted = ts.toISOString().slice(11, 19).replace(/:/g, ''); // HHMMSS
    const dateFormatted = ts.toISOString().slice(8, 10) + ts.toISOString().slice(5, 7) + ts.toISOString().slice(2, 4); // DDMMYY

    // Calculate small trajectory drift along heading for multi-step simulation
    const rad = (currentDir * Math.PI) / 180;
    const latOffset = (i * 0.00015 * Math.cos(rad));
    const lngOffset = (i * 0.00015 * Math.sin(rad));

    const ptLat = Number((baseLat + latOffset).toFixed(6));
    const ptLng = Number((baseLng + lngOffset).toFixed(6));

    // Convert decimal lat/lng to NMEA format (DDMM.MMMM) for raw string simulation
    const latDeg = Math.floor(Math.abs(ptLat));
    const latMin = ((Math.abs(ptLat) - latDeg) * 60).toFixed(4).padStart(7, '0');
    const nmeaLat = `${String(latDeg).padStart(2, '0')}${latMin}`;

    const lngDeg = Math.floor(Math.abs(ptLng));
    const lngMin = ((Math.abs(ptLng) - lngDeg) * 60).toFixed(4).padStart(7, '0');
    const nmeaLng = `${String(lngDeg).padStart(3, '0')}${lngMin}`;

    const knots = (currentSpeed / 1.852).toFixed(2);
    const equStatusHex = isAccOn ? 'FFFFFBFF' : 'FFFFF7FF';

    // Raw Cantrack HQ packet: *HQ,IMEI,V1,HHMMSS,A,lat,N,lng,E,speed,dir,DDMMYY,status#
    const rawAscii = `*HQ,${targetImei},V1,${timeFormatted},A,${nmeaLat},N,${nmeaLng},E,${knots},${Math.round(currentDir)},${dateFormatted},${equStatusHex}#`;

    const point = {
      protocol: 'HQ',
      cmd: 'V1',
      imei: targetImei,
      remote: 'simulation:virtual',
      latitude: ptLat,
      longitude: ptLng,
      speed: currentSpeed,
      speed_knots: parseFloat(knots),
      speed_kmh: currentSpeed,
      direction: currentDir,
      gpsStatus: 'A',
      accOn: isAccOn,
      isBackupBattery: false,
      isOilCut: false,
      equStatusHex,
      batteryLevel: parseInt(batteryLevel, 10) || 100,
      timestamp: dateStr,
      connected: true,
      lastSeen: ts.toISOString(),
      raw_hex: Buffer.from(rawAscii, 'ascii').toString('hex'),
      raw_ascii: rawAscii,
    };

    // 1. Update in-memory runtime cache for real-time live map & socket state
    updateDeviceState(targetImei, point);

    // 2. Log events (marked as simulated) for server stream
    logger.info('HQ_RAW', {
      remote: 'simulation:virtual',
      ascii: rawAscii,
      hex: Buffer.from(rawAscii, 'ascii').toString('hex'),
      simulated: true,
    });

    logger.info('HQ_GPS_UPDATE', {
      ...point,
      simulated: true,
    });

    // 3. Emit real-time event to WebSockets & connected clients (in-memory test broadcast only)
    gpsEventEmitter.emit('gps:update', point);

    generatedPoints.push(point);
  }

  res.json({
    success: true,
    message: `Simulated car ${isAccOn ? 'IGNITION ON (Driving)' : 'IGNITION OFF (Parked)'} telemetry successfully for device ${targetImei} (in-memory test only; database & Redis untouched)`,
    simulated: true,
    imei: targetImei,
    accOn: isAccOn,
    pointsCount: generatedPoints.length,
    latestTelemetry: generatedPoints[generatedPoints.length - 1],
    points: generatedPoints,
  });
}

router.post('/simulate', handleSimulateTelemetry);
router.post('/devices/:imei/simulate', handleSimulateTelemetry);

module.exports = router;
