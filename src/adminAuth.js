'use strict';

const jwt = require('jsonwebtoken');
const { logger } = require('./logger');

const JWT_SECRET = process.env.JWT_SECRET || 'tracker-admin-jwt-secret-key-2026';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

/**
 * Generate a signed JWT token for the authenticated admin user.
 */
function generateToken(payload = {}) {
  const adminUser = process.env.ADMIN_USER || process.env.GATEWAY_USERNAME || 'admin';
  return jwt.sign(
    {
      sub: payload.username || adminUser,
      username: payload.username || adminUser,
      role: 'admin',
      ...payload,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Verify a JWT token. Returns decoded payload or null.
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (_) {
    return null;
  }
}

/**
 * Admin Authentication Middleware for GPS REST API endpoints.
 *
 * Checks credentials against environment variables:
 *   - ADMIN_USER (fallback: GATEWAY_USERNAME || 'admin')
 *   - ADMIN_PWD  (fallback: GATEWAY_PASSWORD || 'secret')
 *
 * Supported Authentication Methods:
 *   1. JWT Bearer Token: Authorization: Bearer <jwt_token>
 *   2. HTTP Basic Auth: Authorization: Basic <base64(username:password)>
 *   3. Legacy Bearer Token: Authorization: Bearer <password> or <username:password>
 *   4. Custom Headers: x-admin-user and x-admin-pwd, or x-api-key
 *   5. Query / Body Parameters: admin_user / admin_pwd, adminUser / adminPassword
 */
function adminAuth(req, res, next) {
  const adminUser = process.env.ADMIN_USER || process.env.GATEWAY_USERNAME || 'admin';
  const adminPwd  = process.env.ADMIN_PWD  || process.env.GATEWAY_PASSWORD || 'secret';

  const authHeader = req.headers['authorization'];

  // 1. Check Bearer Token (JWT first, then legacy fallback)
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const rawToken = authHeader.substring(7).trim();

    // 1a. Validate as JWT
    const decoded = verifyToken(rawToken);
    if (decoded) {
      req.user = decoded;
      return next();
    }

    // 1b. Fallback: plain password or user:password token
    if (rawToken === adminPwd || rawToken === `${adminUser}:${adminPwd}`) {
      req.user = { username: adminUser, role: 'admin' };
      return next();
    }
  }

  // 2. Check HTTP Basic Auth (Authorization: Basic <base64>)
  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf8');
      const colonIdx = credentials.indexOf(':');
      if (colonIdx !== -1) {
        const user = credentials.substring(0, colonIdx);
        const pwd  = credentials.substring(colonIdx + 1);
        if (user === adminUser && pwd === adminPwd) {
          req.user = { username: user, role: 'admin' };
          return next();
        }
      }
    } catch (_) {}
  }

  // 3. Check Custom Headers: x-admin-user, x-admin-pwd, x-api-key
  const headerUser = req.headers['x-admin-user'];
  const headerPwd  = req.headers['x-admin-pwd'];
  if (headerUser && headerPwd) {
    if (headerUser === adminUser && headerPwd === adminPwd) {
      req.user = { username: headerUser, role: 'admin' };
      return next();
    }
  }

  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const decodedKey = verifyToken(apiKey);
    if (decodedKey) {
      req.user = decodedKey;
      return next();
    }
    if (apiKey === adminPwd || apiKey === `${adminUser}:${adminPwd}`) {
      req.user = { username: adminUser, role: 'admin' };
      return next();
    }
  }

  // 4. Check Query Parameters & JSON Body
  const reqUser = req.query.admin_user || req.query.username || req.body?.adminUser || req.body?.admin_user || req.body?.username;
  const reqPwd  = req.query.admin_pwd  || req.query.password || req.body?.adminPwd  || req.body?.admin_pwd  || req.body?.password || req.body?.adminPassword;
  if (reqUser && reqPwd) {
    if (reqUser === adminUser && reqPwd === adminPwd) {
      req.user = { username: reqUser, role: 'admin' };
      return next();
    }
  }

  logger.warn('ADMIN_AUTH_FAILED', {
    path: req.path,
    ip:   req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    hasAuthHeader: Boolean(authHeader),
    hasHeaders:    Boolean(headerUser && headerPwd),
  });

  return res.status(401).json({
    success: false,
    error: 'Unauthorized: Admin login required. Provide Authorization: Bearer <token> or HTTP Basic Auth.',
  });
}

module.exports = { adminAuth, generateToken, verifyToken, JWT_SECRET };
