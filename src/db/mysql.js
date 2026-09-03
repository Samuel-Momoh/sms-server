const mysql = require('mysql2/promise');
const { logger } = require('../logger');
const { hashPassword } = require('../adminAuth');

let pool = null;
let isConnected = false;

// In-memory user, device, and location history fallback store when MySQL is offline
const memoryUsers = new Map();
const memoryDevices = new Map();
const memoryLocationHistory = [];

/**
 * Initialize MySQL connection pool, ensure required tables exist, and seed default admin.
 */
async function initMysql() {
  const host = process.env.DATABASE_HOST;
  const port = parseInt(process.env.DATABASE_PORT || '3306', 10);
  const user = process.env.DATABASE_USER;
  const password = process.env.DATABASE_PWD;
  const database = process.env.DATABASE_NAME;

  if (!host || !user || !database) {
    logger.warn('MYSQL_CONFIG_MISSING', {
      message: 'DATABASE_HOST, DATABASE_USER, or DATABASE_NAME not set. MySQL persistence disabled.',
    });
    seedMemoryAdmin();
    return null;
  }

  try {
    pool = mysql.createPool({
      host,
      port,
      user,
      password,
      database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });

    // Test connection
    const connection = await pool.getConnection();
    isConnected = true;
    connection.release();

    logger.info('MYSQL_CONNECTED', {
      host,
      port,
      database,
      user,
      message: 'MySQL connection established successfully.',
    });

    await ensureTablesExist();
    await seedDefaultAdmin();
    return pool;
  } catch (err) {
    isConnected = false;
    logger.error('MYSQL_CONNECTION_ERROR', {
      host,
      port,
      database,
      error: err.message,
      message: 'Failed to connect to MySQL database. Server will continue with in-memory caching.',
    });
    seedMemoryAdmin();
    return null;
  }
}

/**
 * Seed default admin into in-memory store when MySQL is offline.
 */
function seedMemoryAdmin() {
  const adminUser = process.env.ADMIN_USER || process.env.GATEWAY_USERNAME || 'momohofficial@gmail.com';
  const adminPwd  = process.env.ADMIN_PWD  || process.env.GATEWAY_PASSWORD || '@Samuel196';
  memoryUsers.set(adminUser.toLowerCase(), {
    id: 1,
    username: adminUser.toLowerCase(),
    password_hash: hashPassword(adminPwd),
    name: 'System Admin',
    email: adminUser.toLowerCase(),
    phone: null,
    role: 'admin',
    is_verified: 1,
    verification_code: null,
    verification_expires_at: null,
    created_at: new Date().toISOString(),
  });

}

/**
 * Auto-create tables for users, devices, location history, and command logs.
 */
async function ensureTablesExist() {
  if (!pool) return;

  try {
    // 1. Users Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(128) UNIQUE NOT NULL,
        username VARCHAR(128) NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(128) NULL,
        phone VARCHAR(32) NULL,
        role ENUM('admin', 'user') DEFAULT 'user',
        is_verified TINYINT(1) DEFAULT 0,
        verification_code VARCHAR(16) NULL,
        verification_expires_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_email (email),
        INDEX idx_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Gracefully add verification columns if users table was created previously without them
    try { await pool.query('ALTER TABLE users ADD COLUMN is_verified TINYINT(1) DEFAULT 0'); } catch {}
    try { await pool.query('ALTER TABLE users ADD COLUMN verification_code VARCHAR(16) NULL'); } catch {}
    try { await pool.query('ALTER TABLE users ADD COLUMN verification_expires_at DATETIME NULL'); } catch {}

    // 2. Devices Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS devices (
        imei VARCHAR(32) PRIMARY KEY,
        name VARCHAR(128) NULL,
        plate_number VARCHAR(32) NULL,
        sim_number VARCHAR(32) NULL,
        model VARCHAR(64) DEFAULT 'Cantrack G02',
        user_id BIGINT NULL,
        protocol VARCHAR(32) DEFAULT 'HQ',
        icon TEXT NULL,
        connected TINYINT(1) DEFAULT 0,
        last_latitude DECIMAL(10, 7) NULL,
        last_longitude DECIMAL(10, 7) NULL,
        speed_kmh FLOAT DEFAULT 0,
        direction FLOAT DEFAULT 0,
        acc_on TINYINT(1) DEFAULT 0,
        is_oil_cut TINYINT(1) DEFAULT 0,
        is_backup_battery TINYINT(1) DEFAULT 0,
        gps_status VARCHAR(8) DEFAULT 'V',
        battery_level INT NULL,
        last_seen_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Gracefully add any missing columns in devices table if created in earlier schema version
    const deviceColumns = [
      'name VARCHAR(128) NULL',
      'plate_number VARCHAR(32) NULL',
      'sim_number VARCHAR(32) NULL',
      'model VARCHAR(64) DEFAULT "Cantrack G02"',
      'user_id BIGINT NULL',
      'protocol VARCHAR(32) DEFAULT "HQ"',
      'icon TEXT NULL',
      'connected TINYINT(1) DEFAULT 0',
      'last_latitude DECIMAL(10, 7) NULL',
      'last_longitude DECIMAL(10, 7) NULL',
      'speed_kmh FLOAT DEFAULT 0',
      'direction FLOAT DEFAULT 0',
      'acc_on TINYINT(1) DEFAULT 0',
      'is_oil_cut TINYINT(1) DEFAULT 0',
      'is_backup_battery TINYINT(1) DEFAULT 0',
      'gps_status VARCHAR(8) DEFAULT "V"',
      'battery_level INT NULL',
      'last_seen_at DATETIME NULL',
    ];

    for (const colDef of deviceColumns) {
      try {
        await pool.query(`ALTER TABLE devices ADD COLUMN ${colDef}`);
      } catch (_) {}
    }

    // 3. Location History Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS location_history (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        imei VARCHAR(32) NOT NULL,
        latitude DECIMAL(10, 7) NOT NULL,
        longitude DECIMAL(10, 7) NOT NULL,
        speed_kmh FLOAT DEFAULT 0,
        direction FLOAT DEFAULT 0,
        acc_on TINYINT(1) DEFAULT 0,
        gps_status VARCHAR(8) DEFAULT 'A',
        raw_data TEXT NULL,
        recorded_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_imei_recorded (imei, recorded_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 4. Command Logs / Queue Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS command_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        command_id VARCHAR(64) UNIQUE NOT NULL,
        imei VARCHAR(32) NOT NULL,
        cmd_code VARCHAR(32) NOT NULL,
        command_string TEXT NOT NULL,
        status ENUM('QUEUED', 'SENT', 'ACKED', 'FAILED', 'CANCELLED') DEFAULT 'QUEUED',
        params_json TEXT NULL,
        error_message TEXT NULL,
        queued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        dispatched_at DATETIME NULL,
        acked_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_imei_status (imei, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 5. FCM Push Notification Tokens Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fcm_tokens (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        token VARCHAR(255) NOT NULL,
        device_type VARCHAR(32) DEFAULT 'android',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_token (user_id, token),
        INDEX idx_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    logger.info('MYSQL_TABLES_INITIALIZED', {
      tables: ['users', 'devices', 'location_history', 'command_logs', 'fcm_tokens'],
      message: 'Database schema verified and ready.',
    });
  } catch (err) {
    logger.error('MYSQL_SCHEMA_ERROR', {
      error: err.message,
      message: 'Failed to create required MySQL tables.',
    });
  }
}

/**
 * Seed default admin account into MySQL from GATEWAY_USERNAME and GATEWAY_PASSWORD.
 */
async function seedDefaultAdmin() {
  if (!pool || !isConnected) return;

  const adminUser = (process.env.ADMIN_USER || process.env.GATEWAY_USERNAME || 'momohofficial@gmail.com').toLowerCase();
  const adminPwd  = process.env.ADMIN_PWD  || process.env.GATEWAY_PASSWORD || '@Samuel196';

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1', [adminUser, adminUser]);
    if (rows.length === 0) {
      const hashed = hashPassword(adminPwd);
      await pool.query(
        'INSERT INTO users (email, username, password_hash, name, role, is_verified) VALUES (?, ?, ?, ?, ?, ?)',
        [adminUser, adminUser, hashed, 'System Admin', 'admin', 1]
      );
      logger.info('ADMIN_SEEDED_SUCCESS', {
        email: adminUser,
        role: 'admin',
        message: 'Default admin account seeded successfully into MySQL users table.',
      });
    }
  } catch (err) {
    logger.warn('ADMIN_SEED_ERROR', { error: err.message });
  }
}

// ── User Management Methods ───────────────────────────────────────────────────

/**
 * Create a new user with email & password (immediately active).
 */
async function createUser({ email, password, name = '', phone = '', username = '', role = 'user' }) {
  if (!email || !password) {
    throw new Error('Email and password are required.');
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanUsername = (username || cleanEmail).trim().toLowerCase();
  const passwordHash = hashPassword(password);
  const userRole = role === 'admin' ? 'admin' : 'user';

  if (pool && isConnected) {
    try {
      const [res] = await pool.query(
        'INSERT INTO users (email, username, password_hash, name, phone, role, is_verified) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [cleanEmail, cleanUsername, passwordHash, name || null, phone || null, userRole, 1]
      );

      logger.info('USER_REGISTERED_SUCCESS', {
        userId: res.insertId,
        email: cleanEmail,
        role: userRole,
      });

      return {
        id: res.insertId,
        email: cleanEmail,
        username: cleanUsername,
        name,
        phone,
        role: userRole,
      };
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(`Email or username '${cleanEmail}' is already registered.`);
      }
      throw err;
    }
  }

  // Memory fallback
  if (memoryUsers.has(cleanEmail) || memoryUsers.has(cleanUsername)) {
    throw new Error(`Email '${cleanEmail}' is already registered.`);
  }
  const id = memoryUsers.size + 1;
  const userObj = {
    id,
    email: cleanEmail,
    username: cleanUsername,
    password_hash: passwordHash,
    name,
    phone,
    role: userRole,
    is_verified: 1,
    created_at: new Date().toISOString(),
  };

  memoryUsers.set(cleanEmail, userObj);
  memoryUsers.set(cleanUsername, userObj);

  logger.info('USER_REGISTERED_SUCCESS', {
    userId: id,
    email: cleanEmail,
    role: userRole,
  });

  return {
    id,
    email: cleanEmail,
    username: cleanUsername,
    name,
    phone,
    role: userRole,
  };
}

/**
 * Find user by email or username.
 */
async function findUserByEmailOrUsername(identifier) {
  if (!identifier) return null;
  const clean = identifier.trim().toLowerCase();

  if (pool && isConnected) {
    try {
      const [rows] = await pool.query(
        'SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1',
        [clean, clean]
      );
      return rows[0] || null;
    } catch (err) {
      logger.error('MYSQL_FIND_USER_ERROR', { identifier: clean, error: err.message });
    }
  }

  return memoryUsers.get(clean) || null;
}

/**
 * Find user by username.
 */
async function findUserByUsername(username) {
  return findUserByEmailOrUsername(username);
}

/**
 * Find user by ID.
 */
async function findUserById(id) {
  if (!id) return null;

  if (pool && isConnected) {
    try {
      const [rows] = await pool.query(
        'SELECT id, email, username, name, phone, role, is_verified, created_at FROM users WHERE id = ? LIMIT 1',
        [id]
      );
      return rows[0] || null;
    } catch (err) {
      logger.error('MYSQL_FIND_USER_ID_ERROR', { id, error: err.message });
    }
  }

  for (const user of memoryUsers.values()) {
    if (user.id === parseInt(id, 10)) {
      const { password_hash, ...safe } = user;
      return safe;
    }
  }
  return null;
}

/**
 * Permanently delete a user account and all owned devices and records.
 *
 * @param {number|string} userIdOrEmail
 * @returns {Promise<boolean>}
 */
async function deleteUser(userIdOrEmail) {
  if (!userIdOrEmail) return false;

  let user = null;
  if (typeof userIdOrEmail === 'number' || /^\d+$/.test(String(userIdOrEmail))) {
    user = await findUserById(userIdOrEmail);
  }
  if (!user) {
    user = await findUserByEmailOrUsername(String(userIdOrEmail));
  }

  if (!user) {
    logger.warn('DELETE_USER_NOT_FOUND', { identifier: userIdOrEmail });
    return false;
  }

  const userId = user.id;
  const userEmail = user.email ? user.email.toLowerCase() : '';
  const username = user.username ? user.username.toLowerCase() : '';

  // 1. Find and permanently purge all devices owned by this user
  try {
    const userDevices = await getDevicesByUser(userId);
    for (const dev of userDevices) {
      if (dev.imei) {
        await deleteDevice(dev.imei);
      }
    }
  } catch (err) {
    logger.error('DELETE_USER_DEVICES_ERROR', { userId, error: err.message });
  }

  // 2. Delete user from MySQL
  if (pool && isConnected) {
    try {
      await pool.query('DELETE FROM users WHERE id = ?', [userId]);
    } catch (err) {
      logger.error('MYSQL_DELETE_USER_ERROR', { userId, error: err.message });
      throw err;
    }
  }

  // 3. Delete from in-memory user map
  if (userEmail) memoryUsers.delete(userEmail);
  if (username) memoryUsers.delete(username);

  logger.info('USER_ACCOUNT_PURGED', {
    userId,
    email: userEmail,
    username,
  });

  return true;
}

// ── In-Memory Deletion OTP Store ──────────────────────────────────────────────
const deletionOtpStore = new Map();

function saveDeletionOtp(email, { code, reason, expiresAt }) {
  const cleanEmail = email.trim().toLowerCase();
  deletionOtpStore.set(cleanEmail, {
    code: String(code).trim(),
    reason: reason || '',
    expiresAt: expiresAt || Date.now() + 15 * 60 * 1000,
  });
}

function getDeletionOtp(email) {
  const cleanEmail = email.trim().toLowerCase();
  const entry = deletionOtpStore.get(cleanEmail);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    deletionOtpStore.delete(cleanEmail);
    return null;
  }
  return entry;
}

function removeDeletionOtp(email) {
  const cleanEmail = email.trim().toLowerCase();
  deletionOtpStore.delete(cleanEmail);
}

/**
 * Update a user's password.
 *
 * @param {number|string} userIdOrEmail
 * @param {string} newPassword
 * @returns {Promise<boolean>}
 */
async function updateUserPassword(userIdOrEmail, newPassword) {
  if (!userIdOrEmail || !newPassword) return false;

  let user = null;
  if (typeof userIdOrEmail === 'number' || /^\d+$/.test(String(userIdOrEmail))) {
    user = await findUserById(userIdOrEmail);
  }
  if (!user) {
    user = await findUserByEmailOrUsername(String(userIdOrEmail));
  }

  if (!user) {
    logger.warn('UPDATE_PASSWORD_USER_NOT_FOUND', { identifier: userIdOrEmail });
    return false;
  }

  const newHash = hashPassword(newPassword);

  if (pool && isConnected) {
    try {
      await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, user.id]);
    } catch (err) {
      logger.error('MYSQL_UPDATE_PASSWORD_ERROR', { userId: user.id, error: err.message });
      throw err;
    }
  }

  // Update in-memory user
  const emailKey = user.email ? user.email.toLowerCase() : '';
  const userKey = user.username ? user.username.toLowerCase() : '';
  if (emailKey && memoryUsers.has(emailKey)) {
    memoryUsers.get(emailKey).password_hash = newHash;
  }
  if (userKey && memoryUsers.has(userKey)) {
    memoryUsers.get(userKey).password_hash = newHash;
  }

  logger.info('USER_PASSWORD_UPDATED', {
    userId: user.id,
    email: user.email,
  });

  return true;
}

// ── In-Memory Password Reset OTP Store ────────────────────────────────────────
const passwordResetOtpStore = new Map();

function savePasswordResetOtp(email, { code, expiresAt }) {
  const cleanEmail = email.trim().toLowerCase();
  passwordResetOtpStore.set(cleanEmail, {
    code: String(code).trim(),
    expiresAt: expiresAt || Date.now() + 15 * 60 * 1000,
  });
}

function getPasswordResetOtp(email) {
  const cleanEmail = email.trim().toLowerCase();
  const entry = passwordResetOtpStore.get(cleanEmail);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    passwordResetOtpStore.delete(cleanEmail);
    return null;
  }
  return entry;
}

function removePasswordResetOtp(email) {
  const cleanEmail = email.trim().toLowerCase();
  passwordResetOtpStore.delete(cleanEmail);
}

// ── Device Management Methods ─────────────────────────────────────────────────

async function ensureDeviceColumns() {
  if (!pool) return;
  const deviceColumns = [
    'name VARCHAR(128) NULL',
    'plate_number VARCHAR(32) NULL',
    'sim_number VARCHAR(32) NULL',
    'model VARCHAR(64) DEFAULT "Cantrack G02"',
    'user_id BIGINT NULL',
    'protocol VARCHAR(32) DEFAULT "HQ"',
    'icon TEXT NULL',
    'connected TINYINT(1) DEFAULT 0',
    'last_latitude DECIMAL(10, 7) NULL',
    'last_longitude DECIMAL(10, 7) NULL',
    'speed_kmh FLOAT DEFAULT 0',
    'direction FLOAT DEFAULT 0',
    'acc_on TINYINT(1) DEFAULT 0',
    'is_oil_cut TINYINT(1) DEFAULT 0',
    'is_backup_battery TINYINT(1) DEFAULT 0',
    'gps_status VARCHAR(8) DEFAULT "V"',
    'battery_level INT NULL',
    'last_seen_at DATETIME NULL',
  ];

  for (const colDef of deviceColumns) {
    try {
      await pool.query(`ALTER TABLE devices ADD COLUMN ${colDef}`);
    } catch (_) {}
  }
}

/**
 * Register a new GPS tracker device in the system.
 */
async function registerNewDevice({ imei, name = '', plateNumber = '', simNumber = '', model = 'Cantrack G02', userId = null, protocol = 'HQ', icon = null }) {
  if (!imei) throw new Error('IMEI is required');

  if (pool && isConnected) {
    const sql = `
      INSERT INTO devices (
        imei, name, plate_number, sim_number, model, user_id, protocol, icon
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = COALESCE(VALUES(name), name),
        plate_number = COALESCE(VALUES(plate_number), plate_number),
        sim_number = COALESCE(VALUES(sim_number), sim_number),
        model = COALESCE(VALUES(model), model),
        user_id = COALESCE(VALUES(user_id), user_id),
        protocol = VALUES(protocol),
        icon = COALESCE(VALUES(icon), icon);
    `;
    const params = [
      imei,
      name || `Tracker ${imei}`,
      plateNumber || null,
      simNumber || null,
      model || 'Cantrack G02',
      userId || null,
      protocol || 'HQ',
      icon || null,
    ];

    try {
      await pool.query(sql, params);
      return {
        imei,
        name: name || `Tracker ${imei}`,
        plateNumber,
        simNumber,
        model,
        userId,
        protocol,
        icon,
      };
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR' || err.message?.includes('Unknown column')) {
        await ensureDeviceColumns();
        await pool.query(sql, params);
        return {
          imei,
          name: name || `Tracker ${imei}`,
          plateNumber,
          simNumber,
          model,
          userId,
          protocol,
          icon,
        };
      }
      logger.error('MYSQL_REGISTER_DEVICE_ERROR', { imei, error: err.message });
      throw err;
    }
  }

  const devObj = {
    imei,
    name: name || `Tracker ${imei}`,
    plate_number: plateNumber || null,
    sim_number: simNumber || null,
    model: model || 'Cantrack G02',
    user_id: userId || null,
    protocol: protocol || 'HQ',
    icon: icon || null,
  };
  memoryDevices.set(imei, devObj);

  return {
    imei,
    name: devObj.name,
    plateNumber,
    simNumber,
    model: devObj.model,
    userId,
    protocol: devObj.protocol,
    icon: devObj.icon,
  };
}

/**
 * Update device metadata.
 */
async function updateDeviceInfo(imei, { name, plateNumber, simNumber, model, userId, icon }) {
  if (memoryDevices.has(imei)) {
    const d = memoryDevices.get(imei);
    if (name !== undefined) d.name = name;
    if (plateNumber !== undefined) d.plate_number = plateNumber;
    if (simNumber !== undefined) d.sim_number = simNumber;
    if (model !== undefined) d.model = model;
    if (userId !== undefined) d.user_id = userId;
    if (icon !== undefined) d.icon = icon;
  }

  if (!pool || !isConnected || !imei) return true;

  const updates = [];
  const values = [];

  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (plateNumber !== undefined) { updates.push('plate_number = ?'); values.push(plateNumber); }
  if (simNumber !== undefined) { updates.push('sim_number = ?'); values.push(simNumber); }
  if (model !== undefined) { updates.push('model = ?'); values.push(model); }
  if (userId !== undefined) { updates.push('user_id = ?'); values.push(userId); }
  if (icon !== undefined) { updates.push('icon = ?'); values.push(icon); }

  if (updates.length === 0) return true;
  values.push(imei);

  const sql = `UPDATE devices SET ${updates.join(', ')} WHERE imei = ?`;

  try {
    const [res] = await pool.query(sql, values);
    return res.affectedRows > 0;
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR' || err.message?.includes('Unknown column')) {
      await ensureDeviceColumns();
      const [res] = await pool.query(sql, values);
      return res.affectedRows > 0;
    }
    logger.error('MYSQL_UPDATE_DEVICE_ERROR', { imei, error: err.message });
    return false;
  }
}

/**
 * Find device by IMEI.
 */
async function getDeviceByImei(imei) {
  if (!imei) return null;

  if (pool && isConnected) {
    try {
      const [rows] = await pool.query('SELECT * FROM devices WHERE imei = ? LIMIT 1', [imei]);
      if (rows[0]) return rows[0];
    } catch (err) {
      logger.error('MYSQL_GET_DEVICE_ERROR', { imei, error: err.message });
    }
  }
  return memoryDevices.get(imei) || null;
}

/**
 * Get all devices registered to a specific user.
 */
async function getDevicesByUser(userId) {
  if (!userId) return [];

  if (pool && isConnected) {
    try {
      const [rows] = await pool.query('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC', [userId]);
      if (rows && rows.length > 0) return rows;
    } catch (err) {
      logger.error('MYSQL_GET_USER_DEVICES_ERROR', { userId, error: err.message });
    }
  }

  const userDevs = [];
  for (const d of memoryDevices.values()) {
    if (d.user_id && String(d.user_id) === String(userId)) {
      userDevs.push(d);
    }
  }
  return userDevs;
}

/**
 * Get all registered devices from the database.
 */
async function getAllDevices() {
  if (pool && isConnected) {
    try {
      const [rows] = await pool.query('SELECT * FROM devices ORDER BY last_seen_at DESC, created_at DESC');
      if (rows && rows.length > 0) return rows;
    } catch (err) {
      logger.error('MYSQL_GET_ALL_DEVICES_ERROR', { error: err.message });
    }
  }
  return Array.from(memoryDevices.values());
}

/**
 * Permanently delete a device and purge all associated records (location history, command logs, metadata).
 */
async function deleteDevice(imei) {
  if (!imei) return false;
  const targetImei = String(imei).trim();
  memoryDevices.delete(targetImei);

  // Clean in-memory location history
  for (let i = memoryLocationHistory.length - 1; i >= 0; i--) {
    if (memoryLocationHistory[i].imei === targetImei) {
      memoryLocationHistory.splice(i, 1);
    }
  }

  if (!pool || !isConnected) return true;

  try {
    // 1. Purge all location history for this device
    await pool.query('DELETE FROM location_history WHERE imei = ?', [targetImei]);

    // 2. Purge all command logs for this device
    await pool.query('DELETE FROM command_logs WHERE imei = ?', [targetImei]);

    // 3. Purge device registration record
    const [res] = await pool.query('DELETE FROM devices WHERE imei = ?', [targetImei]);

    logger.info('DEVICE_AND_RECORDS_PURGED', {
      imei: targetImei,
      tablesPurged: ['location_history', 'command_logs', 'devices'],
    });

    return res.affectedRows > 0;
  } catch (err) {
    logger.error('MYSQL_DELETE_DEVICE_ERROR', { imei: targetImei, error: err.message });
    throw err;
  }
}

/**
 * Upsert latest device telemetry state.
 */
async function upsertDevice(dev) {
  if (!pool || !isConnected || !dev?.imei) return;

  try {
    const lastSeen = dev.lastSeen || dev.timestamp || new Date();
    const recordedAt = new Date(lastSeen);
    const validDate = isNaN(recordedAt.getTime()) ? new Date() : recordedAt;

    const sql = `
      INSERT INTO devices (
        imei, protocol, connected, last_latitude, last_longitude,
        speed_kmh, direction, acc_on, is_oil_cut, is_backup_battery,
        gps_status, battery_level, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        protocol = VALUES(protocol),
        connected = VALUES(connected),
        last_latitude = COALESCE(VALUES(last_latitude), last_latitude),
        last_longitude = COALESCE(VALUES(last_longitude), last_longitude),
        speed_kmh = COALESCE(VALUES(speed_kmh), speed_kmh),
        direction = COALESCE(VALUES(direction), direction),
        acc_on = COALESCE(VALUES(acc_on), acc_on),
        is_oil_cut = COALESCE(VALUES(is_oil_cut), is_oil_cut),
        is_backup_battery = COALESCE(VALUES(is_backup_battery), is_backup_battery),
        gps_status = COALESCE(VALUES(gps_status), gps_status),
        battery_level = COALESCE(VALUES(battery_level), battery_level),
        last_seen_at = VALUES(last_seen_at);
    `;

    await pool.query(sql, [
      dev.imei,
      dev.protocol || 'HQ',
      dev.connected ? 1 : 0,
      dev.latitude !== undefined && !isNaN(dev.latitude) ? dev.latitude : null,
      dev.longitude !== undefined && !isNaN(dev.longitude) ? dev.longitude : null,
      dev.speed_kmh !== undefined && !isNaN(dev.speed_kmh) ? dev.speed_kmh : null,
      dev.direction !== undefined && !isNaN(dev.direction) ? dev.direction : null,
      dev.accOn !== undefined ? (dev.accOn ? 1 : 0) : null,
      dev.isOilCut !== undefined ? (dev.isOilCut ? 1 : 0) : null,
      dev.isBackupBattery !== undefined ? (dev.isBackupBattery ? 1 : 0) : null,
      dev.gpsStatus || null,
      dev.batteryLevel !== undefined ? dev.batteryLevel : null,
      validDate,
    ]);
  } catch (err) {
    logger.error('MYSQL_UPSERT_DEVICE_ERROR', { imei: dev.imei, error: err.message });
  }
}

/**
 * Save a trajectory waypoint to location_history.
 */
async function saveLocationHistory(loc) {
  if (!loc?.imei || isNaN(loc.latitude) || isNaN(loc.longitude)) return;

  const rawDate = loc.timestamp || loc.ts || new Date();
  const recordedAt = new Date(rawDate);
  const validDate = isNaN(recordedAt.getTime()) ? new Date() : recordedAt;

  if (!pool || !isConnected) {
    memoryLocationHistory.push({
      id: memoryLocationHistory.length + 1,
      imei: String(loc.imei).trim(),
      latitude: parseFloat(Number(loc.latitude).toFixed(6)),
      longitude: parseFloat(Number(loc.longitude).toFixed(6)),
      speed_kmh: parseFloat(loc.speed_kmh || 0),
      direction: parseFloat(loc.direction || 0),
      acc_on: loc.accOn ? 1 : 0,
      accOn: Boolean(loc.accOn),
      gps_status: loc.gpsStatus || 'A',
      gpsStatus: loc.gpsStatus || 'A',
      raw_data: loc.raw_hex || loc.ascii || null,
      recorded_at: validDate.toISOString(),
      created_at: new Date().toISOString(),
    });
    return;
  }

  try {
    const sql = `
      INSERT INTO location_history (
        imei, latitude, longitude, speed_kmh, direction, acc_on, gps_status, raw_data, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `;

    await pool.query(sql, [
      loc.imei,
      loc.latitude,
      loc.longitude,
      loc.speed_kmh || 0,
      loc.direction || 0,
      loc.accOn ? 1 : 0,
      loc.gpsStatus || 'A',
      loc.raw_hex || loc.ascii || null,
      validDate,
    ]);
  } catch (err) {
    logger.error('MYSQL_SAVE_LOCATION_ERROR', { imei: loc.imei, error: err.message });
  }
}

/**
 * Log an enqueued or executed command.
 */
async function logCommand({ commandId, imei, cmdCode, commandString, status = 'QUEUED', params = null }) {
  if (!pool || !isConnected) return;

  try {
    const sql = `
      INSERT INTO command_logs (
        command_id, imei, cmd_code, command_string, status, params_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        params_json = VALUES(params_json);
    `;

    await pool.query(sql, [
      commandId,
      imei,
      cmdCode,
      commandString,
      status,
      params ? JSON.stringify(params) : null,
    ]);
  } catch (err) {
    logger.error('MYSQL_LOG_COMMAND_ERROR', { commandId, imei, error: err.message });
  }
}

/**
 * Update the status of a logged command.
 */
async function updateCommandStatus(commandId, status, extra = {}) {
  if (!pool || !isConnected || !commandId) return;

  try {
    const updates = ['status = ?'];
    const values = [status];

    if (status === 'SENT') {
      updates.push('dispatched_at = CURRENT_TIMESTAMP');
    } else if (status === 'ACKED') {
      updates.push('acked_at = CURRENT_TIMESTAMP');
    }

    if (extra.error) {
      updates.push('error_message = ?');
      values.push(extra.error);
    }

    values.push(commandId);

    const sql = `UPDATE command_logs SET ${updates.join(', ')} WHERE command_id = ?`;
    await pool.query(sql, values);
  } catch (err) {
    logger.error('MYSQL_UPDATE_COMMAND_STATUS_ERROR', { commandId, status, error: err.message });
  }
}

/**
 * Retrieve trajectory history for an IMEI.
 * Supports pagination, date range filtering (since/from/until/to), and sorting (ASC/DESC).
 */
async function getLocationHistory(imei, limitOrOptions = 100, maybeSince = null) {
  if (!imei) return [];

  const targetImei = String(imei).trim();

  let limit = 100;
  let offset = 0;
  let since = null;
  let until = null;
  let order = 'DESC';

  if (typeof limitOrOptions === 'object' && limitOrOptions !== null) {
    limit = Math.min(parseInt(limitOrOptions.limit, 10) || 100, 1000);
    if (limit < 1) limit = 100;

    if (limitOrOptions.offset !== undefined) {
      offset = Math.max(parseInt(limitOrOptions.offset, 10) || 0, 0);
    } else if (limitOrOptions.page) {
      const page = Math.max(parseInt(limitOrOptions.page, 10) || 1, 1);
      offset = (page - 1) * limit;
    }

    since = limitOrOptions.since || limitOrOptions.from || limitOrOptions.startDate || null;
    until = limitOrOptions.until || limitOrOptions.to || limitOrOptions.endDate || null;

    if (typeof limitOrOptions.order === 'string' && limitOrOptions.order.toUpperCase() === 'ASC') {
      order = 'ASC';
    }
  } else {
    limit = Math.min(parseInt(limitOrOptions, 10) || 100, 1000);
    if (limit < 1) limit = 100;
    since = maybeSince;
  }

  // Fallback to in-memory store if MySQL is not connected
  if (!pool || !isConnected) {
    let list = memoryLocationHistory.filter((r) => String(r.imei) === targetImei);

    if (since) {
      const sinceDate = new Date(since).getTime();
      if (!isNaN(sinceDate)) {
        list = list.filter((r) => new Date(r.recorded_at).getTime() >= sinceDate);
      }
    }

    if (until) {
      const untilDate = new Date(until).getTime();
      if (!isNaN(untilDate)) {
        list = list.filter((r) => new Date(r.recorded_at).getTime() <= untilDate);
      }
    }

    list.sort((a, b) => {
      const timeA = new Date(a.recorded_at).getTime();
      const timeB = new Date(b.recorded_at).getTime();
      return order === 'ASC' ? timeA - timeB : timeB - timeA;
    });

    return list.slice(offset, offset + limit);
  }

  try {
    let whereSql = 'WHERE imei = ?';
    const params = [targetImei];

    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        whereSql += ' AND recorded_at >= ?';
        params.push(sinceDate);
      }
    }

    if (until) {
      const untilDate = new Date(until);
      if (!isNaN(untilDate.getTime())) {
        whereSql += ' AND recorded_at <= ?';
        params.push(untilDate);
      }
    }

    const sql = `SELECT * FROM location_history ${whereSql} ORDER BY recorded_at ${order} LIMIT ? OFFSET ?`;
    const [rows] = await pool.query(sql, [...params, limit, offset]);

    return rows.map((r) => ({
      id: r.id,
      imei: r.imei,
      latitude: parseFloat(r.latitude),
      longitude: parseFloat(r.longitude),
      speed_kmh: parseFloat(r.speed_kmh || 0),
      direction: parseFloat(r.direction || 0),
      accOn: Boolean(r.acc_on),
      acc_on: r.acc_on,
      gpsStatus: r.gps_status || 'A',
      gps_status: r.gps_status || 'A',
      rawData: r.raw_data || undefined,
      recorded_at: r.recorded_at ? new Date(r.recorded_at).toISOString() : null,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
  } catch (err) {
    logger.error('MYSQL_GET_HISTORY_ERROR', { imei: targetImei, error: err.message });
    return [];
  }
}

/**
 * Get total count of location history records for an IMEI within optional date range.
 */
async function getLocationHistoryCount(imei, { since = null, until = null } = {}) {
  if (!imei) return 0;
  const targetImei = String(imei).trim();

  // Fallback to in-memory store if MySQL is not connected
  if (!pool || !isConnected) {
    let list = memoryLocationHistory.filter((r) => String(r.imei) === targetImei);

    if (since) {
      const sinceDate = new Date(since).getTime();
      if (!isNaN(sinceDate)) {
        list = list.filter((r) => new Date(r.recorded_at).getTime() >= sinceDate);
      }
    }

    if (until) {
      const untilDate = new Date(until).getTime();
      if (!isNaN(untilDate)) {
        list = list.filter((r) => new Date(r.recorded_at).getTime() <= untilDate);
      }
    }

    return list.length;
  }

  try {
    let whereSql = 'WHERE imei = ?';
    const params = [targetImei];

    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        whereSql += ' AND recorded_at >= ?';
        params.push(sinceDate);
      }
    }

    if (until) {
      const untilDate = new Date(until);
      if (!isNaN(untilDate.getTime())) {
        whereSql += ' AND recorded_at <= ?';
        params.push(untilDate);
      }
    }

    const [rows] = await pool.query(`SELECT COUNT(*) AS total FROM location_history ${whereSql}`, params);
    return rows[0]?.total || 0;
  } catch (err) {
    logger.error('MYSQL_GET_HISTORY_COUNT_ERROR', { imei: targetImei, error: err.message });
    return 0;
  }
}

/**
 * Retrieve recent command logs for an IMEI.
 */
/**
 * Retrieve recent command logs for an IMEI.
 */
async function getCommandLogs(imei, limit = 50) {
  if (!pool || !isConnected || !imei) return [];

  try {
    const sql = 'SELECT * FROM command_logs WHERE imei = ? ORDER BY created_at DESC LIMIT ?';
    const [rows] = await pool.query(sql, [imei, Math.min(parseInt(limit, 10) || 50, 200)]);
    return rows;
  } catch (err) {
    logger.error('MYSQL_GET_COMMAND_LOGS_ERROR', { imei, error: err.message });
    return [];
  }
}

// In-memory store: userId -> Map<token, { deviceType, updatedAt }>
const memoryFcmTokens = new Map();

/**
 * Save / Register an FCM device token for a user.
 */
async function saveUserFcmToken(userId, token, deviceType = 'android') {
  if (!userId || !token) return false;
  const cleanUserId = Number(userId) || userId;
  const cleanToken = String(token).trim();
  const cleanDeviceType = String(deviceType || 'android').trim();

  // In-memory update
  if (!memoryFcmTokens.has(cleanUserId)) {
    memoryFcmTokens.set(cleanUserId, new Map());
  }
  memoryFcmTokens.get(cleanUserId).set(cleanToken, {
    token: cleanToken,
    deviceType: cleanDeviceType,
    updatedAt: new Date().toISOString(),
  });

  if (pool && isConnected) {
    try {
      const sql = `
        INSERT INTO fcm_tokens (user_id, token, device_type)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE device_type = VALUES(device_type), updated_at = CURRENT_TIMESTAMP
      `;
      await pool.query(sql, [cleanUserId, cleanToken, cleanDeviceType]);
      return true;
    } catch (err) {
      logger.error('MYSQL_SAVE_FCM_TOKEN_ERROR', { userId, error: err.message });
    }
  }
  return true;
}

/**
 * Get all registered FCM tokens for a user.
 */
async function getUserFcmTokens(userId) {
  if (!userId) return [];
  const cleanUserId = Number(userId) || userId;

  if (pool && isConnected) {
    try {
      const [rows] = await pool.query('SELECT token FROM fcm_tokens WHERE user_id = ?', [cleanUserId]);
      if (rows && rows.length > 0) {
        return rows.map((r) => r.token);
      }
    } catch (err) {
      logger.error('MYSQL_GET_USER_FCM_TOKENS_ERROR', { userId, error: err.message });
    }
  }

  const userMap = memoryFcmTokens.get(cleanUserId);
  return userMap ? Array.from(userMap.keys()) : [];
}

/**
 * Delete an FCM token (e.g. on user logout or invalid token cleanup).
 */
async function deleteUserFcmToken(userId, token) {
  if (!token) return false;
  const cleanToken = String(token).trim();

  if (userId) {
    const cleanUserId = Number(userId) || userId;
    const userMap = memoryFcmTokens.get(cleanUserId);
    if (userMap) userMap.delete(cleanToken);
  } else {
    for (const [uid, userMap] of memoryFcmTokens.entries()) {
      userMap.delete(cleanToken);
    }
  }

  if (pool && isConnected) {
    try {
      if (userId) {
        await pool.query('DELETE FROM fcm_tokens WHERE user_id = ? AND token = ?', [userId, cleanToken]);
      } else {
        await pool.query('DELETE FROM fcm_tokens WHERE token = ?', [cleanToken]);
      }
      return true;
    } catch (err) {
      logger.error('MYSQL_DELETE_FCM_TOKEN_ERROR', { userId, token: cleanToken, error: err.message });
    }
  }
  return true;
}

/**
 * Get all FCM tokens for the owner of a device by its IMEI.
 */
async function getDeviceOwnerFcmTokens(imei) {
  if (!imei) return [];
  const cleanImei = String(imei).trim();

  let userId = null;

  // 1. Check in-memory device
  const memDevice = memoryDevices.get(cleanImei);
  if (memDevice && memDevice.user_id) {
    userId = memDevice.user_id;
  }

  // 2. Check MySQL device
  if (!userId && pool && isConnected) {
    try {
      const [rows] = await pool.query('SELECT user_id FROM devices WHERE imei = ? LIMIT 1', [cleanImei]);
      if (rows && rows.length > 0 && rows[0].user_id) {
        userId = rows[0].user_id;
      }
    } catch (err) {
      logger.error('MYSQL_GET_DEVICE_OWNER_FCM_ERROR', { imei, error: err.message });
    }
  }

  if (!userId) return [];
  return getUserFcmTokens(userId);
}

module.exports = {
  initMysql,
  createUser,
  findUserByEmailOrUsername,
  findUserByUsername,
  findUserById,
  deleteUser,
  updateUserPassword,
  saveDeletionOtp,
  getDeletionOtp,
  removeDeletionOtp,
  savePasswordResetOtp,
  getPasswordResetOtp,
  removePasswordResetOtp,
  registerNewDevice,
  getAllDevices,
  getDeviceByImei,
  getDevicesByUser,
  updateDeviceInfo,
  deleteDevice,
  upsertDevice,
  saveLocationHistory,
  logCommand,
  updateCommandStatus,
  getLocationHistory,
  getLocationHistoryCount,
  getCommandLogs,
  saveUserFcmToken,
  getUserFcmTokens,
  deleteUserFcmToken,
  getDeviceOwnerFcmTokens,
  isMysqlConnected: () => isConnected,
  getPool: () => pool,
};
