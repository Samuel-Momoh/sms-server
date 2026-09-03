'use strict';

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { logger } = require('../logger');
const { getDeviceOwnerFcmTokens, deleteUserFcmToken } = require('../db/mysql');

// Resolve Service Account Key path
const defaultKeyPath = path.resolve(__dirname, '../../etrack-b00bb-firebase-adminsdk-fbsvc-ed8b03fa14.json');
const altKeyPath = path.resolve(__dirname, '../etrack-b00bb-firebase-adminsdk-fbsvc-ed8b03fa14.json');
const envKeyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ? path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH) : null;

let serviceAccount = null;

function loadServiceAccount() {
  const candidates = [envKeyPath, defaultKeyPath, altKeyPath].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf8');
        serviceAccount = JSON.parse(raw);
        logger.info('FCM_SERVICE_ACCOUNT_LOADED', {
          projectId: serviceAccount.project_id,
          clientEmail: serviceAccount.client_email,
        });
        return serviceAccount;
      } catch (err) {
        logger.error('FCM_SERVICE_ACCOUNT_PARSE_ERROR', { path: candidate, error: err.message });
      }
    }
  }
  logger.warn('FCM_SERVICE_ACCOUNT_NOT_FOUND', {
    message: 'Firebase Service Account JSON not found. Push notifications will be disabled.',
  });
  return null;
}

loadServiceAccount();

// Cached OAuth2 Access Token
let cachedAccessToken = null;
let tokenExpiresAt = 0;

/**
 * Get a valid Google OAuth2 access token for Firebase Cloud Messaging HTTP v1 API.
 */
async function getFcmAccessToken() {
  if (!serviceAccount) {
    serviceAccount = loadServiceAccount();
    if (!serviceAccount) return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && now < tokenExpiresAt - 300) {
    return cachedAccessToken;
  }

  try {
    const signedJwt = jwt.sign(
      {
        iss: serviceAccount.client_email,
        sub: serviceAccount.client_email,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
      },
      serviceAccount.private_key,
      { algorithm: 'RS256' }
    );

    const res = await axios.post(
      'https://oauth2.googleapis.com/token',
      `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJwt}`,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      }
    );

    cachedAccessToken = res.data.access_token;
    tokenExpiresAt = now + (res.data.expires_in || 3600);

    return cachedAccessToken;
  } catch (err) {
    logger.error('FCM_AUTH_TOKEN_ERROR', {
      error: err.response?.data || err.message,
    });
    return null;
  }
}

/**
 * Send an FCM v1 push notification to a single device token.
 */
async function sendSinglePushNotification(token, { title, body, data = {}, sound = 'default' }) {
  if (!token || typeof token !== 'string') return { success: false, error: 'Token is required' };

  const accessToken = await getFcmAccessToken();
  if (!accessToken || !serviceAccount) {
    return { success: false, error: 'FCM service account not configured' };
  }

  const projectId = serviceAccount.project_id;
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  // Stringify all data values for FCM v1 requirement
  const stringData = {};
  for (const [key, val] of Object.entries(data)) {
    stringData[key] = typeof val === 'string' ? val : JSON.stringify(val);
  }
  stringData.click_action = 'FLUTTER_NOTIFICATION_CLICK';

  const messagePayload = {
    message: {
      token,
      notification: {
        title,
        body,
      },
      data: stringData,
      android: {
        priority: 'high',
        notification: {
          channel_id: 'etrack_alerts',
          sound: 'default',
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
          notification_priority: 'PRIORITY_HIGH',
          default_sound: true,
          default_vibrate_timings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
            'content-available': 1,
          },
        },
      },
    },
  };

  try {
    const res = await axios.post(url, messagePayload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    return { success: true, messageId: res.data.name };
  } catch (err) {
    const errorDetails = err.response?.data?.error || {};
    const errorCode = errorDetails.details?.[0]?.errorCode || errorDetails.status || err.message;

    logger.warn('FCM_PUSH_ERROR', {
      token: `${token.slice(0, 10)}...`,
      error: errorCode,
      message: errorDetails.message,
    });

    // Cleanup dead/unregistered tokens automatically
    if (
      errorCode === 'UNREGISTERED' ||
      errorCode === 'INVALID_ARGUMENT' ||
      errorDetails.message?.includes('registration-token-not-registered')
    ) {
      deleteUserFcmToken(null, token).catch(() => {});
    }

    return { success: false, error: errorCode };
  }
}

/**
 * Send push notification to multiple device tokens.
 */
async function sendPushNotification(tokens, payload) {
  if (!tokens || tokens.length === 0) {
    return { success: false, sentCount: 0, reason: 'No tokens provided' };
  }

  const tokenList = Array.isArray(tokens) ? tokens : [tokens];
  const uniqueTokens = Array.from(new Set(tokenList.filter((t) => t && typeof t === 'string')));

  if (uniqueTokens.length === 0) {
    return { success: false, sentCount: 0, reason: 'No valid tokens' };
  }

  const results = await Promise.allSettled(
    uniqueTokens.map((tok) => sendSinglePushNotification(tok, payload))
  );

  const successCount = results.filter((r) => r.status === 'fulfilled' && r.value.success).length;

  logger.info('FCM_MULTICAST_SENT', {
    totalTokens: uniqueTokens.length,
    successCount,
    title: payload.title,
  });

  return {
    success: successCount > 0,
    total: uniqueTokens.length,
    sentCount: successCount,
  };
}

/**
 * Map alarm code to user-friendly notification title and body.
 */
function getAlarmNotificationContent(alarmType, deviceName, imei, speed) {
  const devLabel = deviceName ? `${deviceName} (${imei.slice(-4)})` : `Vehicle ${imei.slice(-4)}`;
  const speedStr = speed ? ` at ${Math.round(speed)} km/h` : '';

  switch (String(alarmType).toUpperCase()) {
    case 'SOS':
      return {
        title: '🚨 Emergency SOS Triggered',
        body: `SOS emergency button was pressed in ${devLabel}! Immediate attention required.`,
      };
    case 'POWER_CUT':
      return {
        title: '⚡ Main Power Cut Alert',
        body: `Main vehicle battery disconnected on ${devLabel}! Running on backup battery.`,
      };
    case 'VIBRATION':
      return {
        title: '📳 Vibration / Shock Detected',
        body: `Movement or impact detected while ${devLabel} is parked!`,
      };
    case 'LOW_BATTERY':
      return {
        title: '🪫 Low Backup Battery',
        body: `Internal tracker backup battery on ${devLabel} is critically low (<10%).`,
      };
    case 'OVERSPEED':
      return {
        title: '🏎️ Overspeed Warning',
        body: `${devLabel} exceeded speed limit${speedStr}.`,
      };
    case 'FENCE_OUT':
      return {
        title: '🔴 Geo-Fence Exited',
        body: `${devLabel} has left the designated safe zone boundary!`,
      };
    case 'FENCE_IN':
      return {
        title: '🟢 Geo-Fence Entered',
        body: `${devLabel} has entered the designated safe zone boundary.`,
      };
    case 'ANTI_TAMPER':
      return {
        title: '🛡️ Tracker Tamper Alert',
        body: `Optical tamper sensor or casing exposed on tracker for ${devLabel}!`,
      };
    case 'BATTERY_REMOVED':
      return {
        title: '🪓 Battery Detached',
        body: `Tracker unit or power cable was removed from ${devLabel}!`,
      };
    default:
      return {
        title: `⚠️ Alert: ${alarmType}`,
        body: `Alarm ${alarmType} triggered on ${devLabel}.`,
      };
  }
}

/**
 * Dispatch alarm push notification to the device owner's registered phone tokens.
 */
async function sendDeviceAlarmNotification({
  imei,
  deviceName = '',
  alarmType,
  latitude,
  longitude,
  speed,
  timestamp,
}) {
  if (!imei || !alarmType) return;

  try {
    // 1. Fetch all registered FCM tokens for the device owner
    const tokens = await getDeviceOwnerFcmTokens(imei);
    if (!tokens || tokens.length === 0) {
      logger.info('FCM_NO_TOKENS_FOR_DEVICE', { imei, alarmType });
      return;
    }

    // 2. Format content
    const { title, body } = getAlarmNotificationContent(alarmType, deviceName, imei, speed);

    const notificationPayload = {
      title,
      body,
      data: {
        type: 'ALARM',
        alarmType: String(alarmType).toUpperCase(),
        imei: String(imei),
        deviceName: deviceName || '',
        latitude: latitude ? String(latitude) : '',
        longitude: longitude ? String(longitude) : '',
        speed: speed ? String(speed) : '0',
        timestamp: timestamp || new Date().toISOString(),
      },
    };

    // 3. Send Push Notification
    await sendPushNotification(tokens, notificationPayload);
  } catch (err) {
    logger.error('FCM_ALARM_DISPATCH_ERROR', { imei, alarmType, error: err.message });
  }
}

module.exports = {
  getFcmAccessToken,
  sendSinglePushNotification,
  sendPushNotification,
  sendDeviceAlarmNotification,
  getAlarmNotificationContent,
};
