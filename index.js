require('dotenv').config();

const http                  = require('http');
const express               = require('express');
const swaggerUi             = require('swagger-ui-express');
const { sendSms }           = require('./src/infobip');
const { normalizePhone }    = require('./src/normalizePhone');
const { logger }            = require('./src/logger');
const { createGt06Server, closeGt06Server } = require('./src/gt06Server');
const { initWebSocketServer } = require('./src/wsServer');
const { initMysql }           = require('./src/db/mysql');
const { initRedis }           = require('./src/db/redis');
const gpsRoutes             = require('./src/gpsRoutes');

const app  = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = process.env.NODE_ENV === 'development'
  ? `http://localhost:${PORT}`
  : `http://140.238.88.183:${PORT}`;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Request logger middleware ─────────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.info('INCOMING_REQUEST', {
    method: req.method,
    path:   req.path,
    query:  { ...req.query, password: req.query.password ? '***' : undefined },
    body:   { ...(req.body || {}), password: req.body?.password ? '***' : undefined },
    ip:     req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    ua:     req.headers['user-agent'],
  });
  next();
});

// ── Swagger spec (programmatic dynamic base URL) ──────────────────────────────
const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'SMS Gateway & GPS Tracker Management API',
    version: '1.2.0',
    description:
      'Unified Gateway Server powered by Infobip and Cantrack/GT06 GPS Tracker TCP/WebSocket Engine.\n\n' +
      '### Real-Time WebSocket Connection (Admin Web App)\n' +
      `- **Socket.IO Endpoint:** \`${BASE_URL}\`\n` +
      '- **Room Subscription by IMEI:** Emit `join` with `{ "imei": "867232054850970" }` to only receive events for that tracker.\n' +
      '- **Admin All Devices:** Emit `join_all` to receive real-time streams from all devices.\n' +
      '- **Events Broadcasted:** `gps:update`, `gps:heartbeat`, `gps:login`, `gps:lbs`, `gps:wifi`, `gps:confirm`, `gps:connected`, `gps:disconnected`, `gps:reconnected`, `gps:ack_sent`, `gps:command_sent`\n\n' +
      '### SMS Gateway Portal URL:\n' +
      `\`${BASE_URL}/sendsms.php?username=USER&password=PASSWORD&number=%NUMBER%&message=%MESSAGE%\`\n`,
  },
  servers: [
    {
      url: BASE_URL,
      description: process.env.NODE_ENV === 'development' ? 'Local dev' : 'Production',
    },
  ],
  tags: [
    { name: 'GPS Auth', description: 'Admin authentication for GPS management APIs' },
    { name: 'GPS Devices', description: 'Query connected devices and telemetry states (Admin Auth Required)' },
    { name: 'GPS Commands (Cantrack A/3)', description: 'Send GPRS control commands to online GPS trackers over TCP (Admin Auth Required)' },
    { name: 'GPS Command Queue', description: 'Manage offline command queue for sleeping/disconnected trackers' },
    { name: 'GPS History', description: 'Retrieve historical trajectory and command logs from MySQL' },
    { name: 'SMS Gateway', description: 'Send SMS via Infobip' },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT Bearer token obtained from POST /api/gps/auth/login. Passed as Authorization: Bearer <token>',
      },
      BasicAuth: {
        type: 'http',
        scheme: 'basic',
        description: 'Admin credentials (set in ADMIN_USER and ADMIN_PWD)',
      },
      AdminUserHeader: {
        type: 'apiKey',
        in: 'header',
        name: 'x-admin-user',
        description: 'Admin username header',
      },
      AdminPasswordHeader: {
        type: 'apiKey',
        in: 'header',
        name: 'x-admin-pwd',
        description: 'Admin password header',
      },
    },
  },
  security: [
    { BearerAuth: [] },
    { BasicAuth: [] },
    { AdminUserHeader: [], AdminPasswordHeader: [] },
  ],
  paths: {
    '/': {
      get: {
        summary: 'Health check',
        responses: { 200: { description: 'Server is running' } },
      },
    },

    // ── GPS Auth ──────────────────────────────────────────────────────────────
    '/api/gps/auth/register': {
      post: {
        tags: ['GPS Auth'],
        summary: 'Register New User (Email & Password)',
        description: 'Creates a new user account with email and password and immediately returns a signed JWT Bearer token.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', example: 'driver_john@example.com' },
                  password: { type: 'string', example: 'securePassword123' },
                  name: { type: 'string', example: 'John Doe' },
                  phone: { type: 'string', example: '+2348011223344' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'User registered successfully with JWT Bearer token' },
          400: { description: 'Invalid input or email already exists' },
        },
      },
    },

    '/api/gps/auth/login': {
      post: {
        tags: ['GPS Auth'],
        summary: 'User & Admin Login',
        description: 'Authenticates user with email and password. Optional `rememberMe` keeps user logged in forever (10 years).',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', example: 'driver_john@example.com' },
                  password: { type: 'string', example: 'securePassword123' },
                  rememberMe: { type: 'boolean', default: false, example: true, description: 'Keep user logged in forever (10 years / 3650d)' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Authenticated successfully with JWT Bearer token' },
          401: { description: 'Invalid credentials' },
        },
      },
    },

    '/api/gps/auth/forgot-password': {
      post: {
        tags: ['GPS Auth'],
        summary: 'Forgot Password (Request 6-Digit OTP)',
        description: 'Dispatches a 6-digit verification code to the registered email address via SendGrid (valid for 15 minutes).',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email'],
                properties: {
                  email: { type: 'string', format: 'email', example: 'driver_john@example.com' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Verification code dispatched to email' },
          400: { description: 'Invalid email' },
          404: { description: 'No account registered with this email' },
        },
      },
    },

    '/api/gps/auth/reset-password': {
      post: {
        tags: ['GPS Auth'],
        summary: 'Reset Password (Verify OTP & Set New Password)',
        description: 'Validates the 6-digit verification code sent by email and updates the account password.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'code', 'newPassword'],
                properties: {
                  email: { type: 'string', format: 'email', example: 'driver_john@example.com' },
                  code: { type: 'string', example: '492815', description: '6-digit OTP verification code' },
                  newPassword: { type: 'string', example: 'newSecurePassword456', description: 'New password (min 6 characters)' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Password reset successfully and returns new JWT login token' },
          400: { description: 'Invalid or expired OTP code, or password too short' },
          404: { description: 'No registered user found' },
        },
      },
    },

    '/api/gps/auth/me': {
      get: {
        tags: ['GPS Auth'],
        summary: 'Current User Profile',
        description: 'Returns the currently authenticated user profile from the JWT token.',
        responses: {
          200: { description: 'User profile retrieved successfully' },
          401: { description: 'Unauthorized' },
        },
      },
    },

    '/api/gps/auth/delete-account': {
      post: {
        tags: ['GPS Auth'],
        summary: 'Delete User Account (2-Step Verification Flow)',
        description:
          'Permanently deletes a user account, all registered vehicles, GPS devices, and location history.\n\n' +
          '**Step 1 (Request OTP):** Call with `verify: false` and `email`. A 6-digit verification code is dispatched to the user via SendGrid.\n\n' +
          '**Step 2 (Confirm Deletion):** Call with `verify: true`, `email`, and the 6-digit `code`. The account and all associated devices are permanently purged.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email'],
                properties: {
                  email: {
                    type: 'string',
                    format: 'email',
                    example: 'driver_john@example.com',
                    description: 'Registered user email address',
                  },
                  code: {
                    type: 'string',
                    example: '492815',
                    description: '6-digit OTP verification code received via email (Required when verify is true)',
                  },
                  verify: {
                    type: 'boolean',
                    default: false,
                    example: false,
                    description: 'Set to false in Step 1 to request code, or true in Step 2 to confirm deletion',
                  },
                  reason: {
                    type: 'string',
                    example: 'No longer need vehicle tracking service',
                    description: 'Optional feedback / reason for account deletion',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Step 1 OTP dispatched OR Step 2 Account successfully deleted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    verify: { type: 'boolean', example: false },
                    email: { type: 'string', example: 'driver_john@example.com' },
                    message: { type: 'string', example: 'A 6-digit verification code has been sent to your email.' },
                    expiresInMinutes: { type: 'number', example: 15 },
                    deletedAt: { type: 'string', format: 'date-time', example: '2026-08-28T00:00:00.000Z' },
                  },
                },
              },
            },
          },
          400: { description: 'Invalid code, expired code, or missing required fields' },
          404: { description: 'No registered user found with the provided email' },
          500: { description: 'Internal server error during deletion' },
        },
      },
    },

    // ── GPS Devices ───────────────────────────────────────────────────────────
    '/api/gps/devices': {
      get: {
        tags: ['GPS Devices'],
        summary: 'List all GPS devices and active telemetry states',
        description: 'Returns all registered GPS trackers, their TCP connection status, and last known telemetry/alarms.',
        responses: {
          200: {
            description: 'List of devices',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    count:   { type: 'number', example: 1 },
                    devices: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['GPS Devices'],
        summary: 'Register New Device',
        description: 'Registers a new GPS tracking hardware with vehicle and SIM metadata.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['imei'],
                properties: {
                  imei: { type: 'string', example: '867232054850970' },
                  name: { type: 'string', example: 'Toyota Camry - Samuel' },
                  plateNumber: { type: 'string', example: 'LAG-123AA' },
                  simNumber: { type: 'string', example: '+2348012345678' },
                  model: { type: 'string', example: 'Cantrack G02' },
                  icon: { type: 'string', example: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/></svg>', description: 'Optional SVG string for custom vehicle/tracker icon' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Device registered successfully' },
          400: { description: 'Invalid IMEI or request data' },
        },
      },
    },
    '/api/gps/devices/{imei}': {
      get: {
        tags: ['GPS Devices'],
        summary: 'Get details for a specific GPS tracker by IMEI',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        responses: {
          200: { description: 'Device details found' },
          404: { description: 'Device not found in registry' },
        },
      },
      put: {
        tags: ['GPS Devices'],
        summary: 'Update Device Metadata & Icon',
        description: 'Updates device vehicle name, plate number, SIM number, model, and optional SVG icon.',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', example: 'Toyota Camry 2024' },
                  plateNumber: { type: 'string', example: 'LAG-999ZZ' },
                  simNumber: { type: 'string', example: '+2348099887766' },
                  model: { type: 'string', example: 'Cantrack G02' },
                  icon: { type: 'string', example: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>', description: 'Optional SVG markup string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Device updated successfully' },
          404: { description: 'Device not found' },
        },
      },
      delete: {
        tags: ['GPS Devices'],
        summary: 'Delete Device & Permanently Purge All Records',
        description: 'Permanently unregisters device and deletes all associated records (location history, command logs, Redis queue, memory state).',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        responses: {
          200: { description: 'Device and all records purged successfully' },
          403: { description: 'Forbidden' },
          404: { description: 'Device not found' },
        },
      },
    },

    // ── GPS Telemetry Simulation ──────────────────────────────────────────────
    '/api/gps/simulate': {
      post: {
        tags: ['GPS Simulation & Testing'],
        summary: 'Simulate Car Ignition ON & Driving Telemetry',
        description: 'Simulates real-time vehicle ignition ON / driving telemetry with realistic GPS coordinates, speed, heading, and triggers automatic queue flushing for testing.',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  imei: { type: 'string', example: '867232054850970', description: 'Tracker IMEI' },
                  accOn: { type: 'boolean', default: true, example: true, description: 'Simulate engine/ignition status (true = ON/Driving, false = OFF/Parked)' },
                  speed: { type: 'number', default: 42.5, example: 42.5, description: 'Vehicle speed in km/h' },
                  latitude: { type: 'number', default: 4.888188, example: 4.888188, description: 'GPS Latitude (Port Harcourt, Nigeria)' },
                  longitude: { type: 'number', default: 6.913182, example: 6.913182, description: 'GPS Longitude' },
                  direction: { type: 'number', default: 170, example: 170, description: 'Compass heading in degrees' },
                  batteryLevel: { type: 'number', default: 100, example: 100 },
                  steps: { type: 'number', default: 1, example: 5, description: 'Number of driving points to generate' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Telemetry simulated, saved to MySQL, and broadcasted to WebSockets' },
          403: { description: 'Forbidden (Non-admin attempting to simulate on another user device)' },
        },
      },
    },

    // ── GPS Commands ──────────────────────────────────────────────────────────
    '/api/gps/devices/{imei}/password': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Change Tracker Password (S1)',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['newPassword'],
                properties: {
                  oldPassword: { type: 'string', default: '123456', example: '123456' },
                  newPassword: { type: 'string', example: '000000' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Password change command sent' } },
      },
    },

    '/api/gps/devices/{imei}/center-number': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Set Center Phone Number (S2)',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['number'],
                properties: {
                  number: { type: 'string', example: '08012345678' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Center number command sent' } },
      },
    },

    '/api/gps/devices/{imei}/admin-numbers': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Set Admin Phone Numbers (S3)',
        description: 'Set up to 5 admin phone numbers for the device.',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['numbers'],
                properties: {
                  numbers: { type: 'array', items: { type: 'string' }, example: ['08012345678', '08087654321'] },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Admin numbers command sent' } },
      },
    },

    '/api/gps/devices/{imei}/alarm-mode': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Set Alarm Notification Mode (S18)',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  mode: { type: 'integer', enum: [0, 1, 2], default: 1, description: '0=Close SMS & Calling, 1=SMS alarm, 2=Calling center number' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Alarm mode command sent' } },
      },
    },

    '/api/gps/devices/{imei}/alarm-types': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Configure Alarm Switches (S19)',
        description: 'Enable or disable specific alarm triggers on the device.',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  alarmType: { type: 'integer', enum: [0, 1, 2, 3, 4], default: 1, description: '0=Power cut, 1=ACC Ignition, 2=Low battery, 3=Vibration, 4=Removal' },
                  enable:    { type: 'boolean', default: true, description: 'true=Open alarm, false=Close alarm' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Alarm type switch command sent' } },
      },
    },

    '/api/gps/devices/{imei}/cut-fuel': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Remote Cut Off Engine / Fuel (S20 Disable)',
        description: 'Sends S20 command to activate the relay and disable vehicle fuel/electricity.',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  dynamic: { type: 'boolean', default: false, description: 'false=Static relay cut, true=Dynamic (5s pulse)' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Fuel cut command sent' } },
      },
    },

    '/api/gps/devices/{imei}/restore-fuel': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Restore Engine / Fuel (S20 Enable)',
        description: 'Sends S20 command to deactivate the relay and restore vehicle fuel/electricity.',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        responses: { 200: { description: 'Fuel restore command sent' } },
      },
    },

    '/api/gps/devices/{imei}/geofence': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Set Circular Geo-fence (S21)',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  radiusMeters: { type: 'integer', default: 1000, example: 1000, description: 'Radius in meters. 0 closes fence.' },
                  mode:         { type: 'integer', enum: [1, 2, 3], default: 1, description: '1=Out fence, 2=In fence, 3=In & Out' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Geofence command sent' } },
      },
    },

    '/api/gps/devices/{imei}/server-address': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Set GPS Server IP Address & Port (S23)',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ip'],
                properties: {
                  ip:   { type: 'string', example: '140.238.88.183' },
                  port: { type: 'integer', default: 5022, example: 5022 },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Server IP/Port command sent' } },
      },
    },

    '/api/gps/devices/{imei}/apn': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Set Cellular APN & Credentials (S24)',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['apn'],
                properties: {
                  apn:         { type: 'string', example: 'web.gprs.mtnnigeria.net' },
                  apnUser:     { type: 'string', example: 'web' },
                  apnPassword: { type: 'string', example: 'web' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'APN command sent' } },
      },
    },

    '/api/gps/devices/{imei}/factory-reset': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Factory Default Reset (S25)',
        description: 'Restores tracker to factory default settings.',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        responses: { 200: { description: 'Factory reset command sent' } },
      },
    },

    '/api/gps/devices/{imei}/read-state': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Read Device State / Parameters / Version (S26)',
        description: 'Queries parameters from tracker: 0=Basic data, 1=Software version, 2=Other data.',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  type: { type: 'integer', enum: [0, 1, 2], default: 0 },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Read state command sent' } },
      },
    },

    '/api/gps/devices/{imei}/overspeed': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Set Overspeed Alarm Threshold (S33)',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  speedKmh: { type: 'integer', default: 80, example: 80, description: 'Speed limit in km/h. 0 disables overspeed alarm.' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Overspeed command sent' } },
      },
    },

    '/api/gps/devices/{imei}/check-lbs': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Check LBS Base Station Info (S80)',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  baseCount: { type: 'integer', default: 3, example: 3, description: 'Number of Cell ID base stations (1 to 7)' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Check LBS command sent' } },
      },
    },

    '/api/gps/devices/{imei}/interval': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Set GPRS Reporting Interval (D1)',
        description: 'Sets the interval in seconds between GPS location uploads to the server.',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  intervalSeconds: { type: 'integer', default: 30, example: 30, description: 'Interval in seconds (e.g. 10, 30, 60)' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Interval command sent to device' } },
      },
    },

    '/api/gps/devices/{imei}/fast-locate': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Fast Locate from GPS Server (D2)',
        description: 'Opens GPS module for specified duration when in LBS power-saving mode.',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  openGpsSeconds: { type: 'integer', default: 180, example: 180, description: 'Duration in seconds to open GPS module' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Fast locate command sent' } },
      },
    },

    '/api/gps/devices/{imei}/restart': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Reboot / Restart Tracker (R1)',
        description: 'Remotely restarts the GPS tracker module.',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        responses: { 200: { description: 'Restart command sent' } },
      },
    },

    '/api/gps/devices/{imei}/working-mode': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Change Working Mode (WKMD)',
        description:
          'Sets working mode for G01/G02 trackers:\n' +
          '- `0`: GPS Real-time Tracking (GPS kept open, 10s position upload)\n' +
          '- `1`: LBS Power-saving mode (GPS closed, LBS data every 600s)\n' +
          '- `2`: GPS Intelligent mode (GPS open, 5-minute interval)',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  mode: { type: 'integer', enum: [0, 1, 2], default: 0, description: '0=Realtime, 1=LBS, 2=Intelligent 5min' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Command sent to device successfully' } },
      },
    },

    '/api/gps/devices/{imei}/raw': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Send Raw Tracker Command',
        description:
          'Send custom raw commands directly to the tracker over TCP socket.\n\n' +
          'Supports either:\n' +
          '1. **Full Raw ASCII String**: `rawCommand: "HQ,867232054850970,S20,195440,1,1#"` or `"*HQ,867232054850970,S20,195440,1,1#"` or `"RELAY,1#"` (automatically formatted and dispatched).\n' +
          '2. **Structured Command & Params**: `command: "WKMD"`, `params: ["0"]` (automatically wraps in Cantrack frame).',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  rawCommand: {
                    type: 'string',
                    example: 'HQ,867232054850970,S20,195440,1,1#',
                    description: 'Full raw command string (with or without leading *).',
                  },
                  command: {
                    type: 'string',
                    example: 'WKMD',
                    description: 'Command code (e.g. WKMD, D1, S20, R1) or full raw command string.',
                  },
                  params: {
                    type: 'array',
                    items: { type: 'string' },
                    example: ['0'],
                    description: 'Optional arguments array when using command code.',
                  },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Raw command sent or queued successfully' } },
      },
    },

    '/api/gps/command/{imei}/{cmd}': {
      post: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Unified GPS Command Router',
        description:
          'Unified router to send or queue any command to the device.\n\n' +
          'Common command aliases for `{cmd}`:\n' +
          '- `cut_fuel` / `cut-fuel` (S20: Disable fuel relay)\n' +
          '- `resume_fuel` / `restore-fuel` (S20: Restore fuel relay)\n' +
          '- `set_upload_interval` (D1: Interval in seconds)\n' +
          '- `set_apn` (S24: APN, user, password)\n' +
          '- `set_ip` (S23: IP and port)\n' +
          '- `set_speed_alarm` / `clear_speed_alarm` (S33)\n' +
          '- `set_geofence` / `clear_geofence` (S21)\n' +
          '- `restart` (R1)\n' +
          '- `raw` (Send custom `rawCommand` in request body)',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
          { in: 'path', name: 'cmd', required: true, schema: { type: 'string' }, example: 'cut_fuel' },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  rawCommand: { type: 'string', example: 'HQ,867232054850970,S20,195440,1,1#' },
                  interval: { type: 'integer', example: 30 },
                  speed: { type: 'integer', example: 80 },
                  radius: { type: 'integer', example: 1000 },
                  params: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Command dispatched or queued' } },
      },
    },

    '/api/gps/devices/{imei}/queue': {
      get: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'List Queued Offline Commands',
        description: 'View pending offline commands waiting to execute when the tracker wakes up.',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        responses: {
          200: {
            description: 'List of queued commands',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    imei: { type: 'string', example: '867232054850970' },
                    count: { type: 'integer', example: 1 },
                    queued: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      },
      delete: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Clear All Queued Offline Commands',
        description: 'Cancels all pending offline commands for this IMEI.',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        responses: { 200: { description: 'Command queue cleared' } },
      },
    },

    '/api/gps/devices/{imei}/queue/{commandId}': {
      delete: {
        tags: ['GPS Commands (Cantrack A/3)'],
        summary: 'Cancel Specific Queued Offline Command',
        description: 'Cancels an individual queued command by its commandId.',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
          { in: 'path', name: 'commandId', required: true, schema: { type: 'string' }, example: 'cmd_1787739338577_8wbpw' },
        ],
        responses: { 200: { description: 'Command cancelled' } },
      },
    },

    // ── SMS Gateway Routes ────────────────────────────────────────────────────
    '/sendsms.php': {
      post: {
        tags: ['SMS Gateway'],
        summary: 'Send SMS via POST (classic gateway format)',
        parameters: [
          { in: 'query', name: 'username', required: true,  schema: { type: 'string' }, example: 'admin' },
          { in: 'query', name: 'password', required: true,  schema: { type: 'string' }, example: 'secret' },
          { in: 'query', name: 'number',   required: true,  schema: { type: 'string' }, example: '08012345678' },
          { in: 'query', name: 'message',  required: true,  schema: { type: 'string' }, example: 'Hello from the gateway!' },
        ],
        responses: {
          200: { description: 'SMS sent' },
          400: { description: 'Missing number or message' },
          401: { description: 'Bad credentials' },
          500: { description: 'Infobip error' },
        },
      },
      get: {
        tags: ['SMS Gateway'],
        summary: 'Send SMS via GET (classic gateway format)',
        parameters: [
          { in: 'query', name: 'username', required: true,  schema: { type: 'string' }, example: 'admin' },
          { in: 'query', name: 'password', required: true,  schema: { type: 'string' }, example: 'secret' },
          { in: 'query', name: 'number',   required: true,  schema: { type: 'string' }, example: '08012345678' },
          { in: 'query', name: 'message',  required: true,  schema: { type: 'string' }, example: 'Hello!' },
        ],
        responses: {
          200: { description: 'SMS sent' },
          400: { description: 'Missing number or message' },
          401: { description: 'Bad credentials' },
          500: { description: 'Infobip error' },
        },
      },
    },

    '/send-sms': {
      post: {
        tags: ['SMS Gateway'],
        summary: 'Send SMS via JSON body (REST)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['number', 'message'],
                properties: {
                  number:  { type: 'string', example: '08012345678' },
                  message: { type: 'string', example: 'Hello!' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'SMS sent' },
          400: { description: 'Missing fields' },
          500: { description: 'Infobip error' },
        },
      },
    },
  },
};

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, { customSiteTitle: 'SMS & GPS Gateway Docs' }));

// ── Mount GPS Routes ──────────────────────────────────────────────────────────
app.use('/api/gps', gpsRoutes);

// ── Root Route ────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'SMS & GPS Gateway Server', docs: '/api-docs' });
});

// ── SMS Handlers ──────────────────────────────────────────────────────────────
async function handleSendSms(req, res) {
  const rawNumber = req.query.number   || req.body?.number;
  const message   = req.query.message  || req.body?.message;
  const username  = req.query.username || req.body?.username;
  const password  = req.query.password || req.body?.password;

  const expectedUser = process.env.GATEWAY_USERNAME;
  const expectedPass = process.env.GATEWAY_PASSWORD;
  if (expectedUser && expectedPass) {
    if (username !== expectedUser || password !== expectedPass) {
      logger.warn('AUTH_FAILED', { username, path: req.path });
      return res.status(401).json({ success: false, error: 'Invalid username or password.' });
    }
  }

  if (!rawNumber || !message) {
    logger.warn('MISSING_PARAMS', { rawNumber, hasMessage: !!message });
    return res.status(400).json({ success: false, error: 'number and message are required.' });
  }

  const number = normalizePhone(rawNumber);
  logger.info('PHONE_NORMALIZED', { raw: rawNumber, normalized: number });

  logger.info('INFOBIP_REQUEST', {
    to:      number,
    message,
    sender:  process.env.INFOBIP_SENDER || 'InfoSMS',
    baseUrl: process.env.INFOBIP_BASE_URL,
  });

  try {
    const result = await sendSms(number, message);
    logger.info('INFOBIP_RESPONSE', {
      to:          number,
      messageId:   result?.messages?.[0]?.messageId,
      status:      result?.messages?.[0]?.status?.name,
      description: result?.messages?.[0]?.status?.description,
    });
    return res.json({ success: true, normalizedNumber: number, data: result });
  } catch (err) {
    logger.error('INFOBIP_ERROR', {
      to:      number,
      message: err.message,
      status:  err.response?.status,
      body:    err.response?.data,
    });
    return res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
}

app.post('/sendsms.php', handleSendSms);
app.get('/sendsms.php',  handleSendSms);

app.post('/send-sms', async (req, res) => {
  const { number: rawNumber, message } = req.body || {};

  if (!rawNumber || !message) {
    logger.warn('MISSING_PARAMS', { rawNumber, hasMessage: !!message });
    return res.status(400).json({ success: false, error: '"number" and "message" are required.' });
  }

  const number = normalizePhone(rawNumber);
  logger.info('PHONE_NORMALIZED', { raw: rawNumber, normalized: number });

  logger.info('INFOBIP_REQUEST', {
    to:      number,
    message,
    sender:  process.env.INFOBIP_SENDER || 'InfoSMS',
    baseUrl: process.env.INFOBIP_BASE_URL,
  });

  try {
    const result = await sendSms(number, message);
    logger.info('INFOBIP_RESPONSE', {
      to:          number,
      messageId:   result?.messages?.[0]?.messageId,
      status:      result?.messages?.[0]?.status?.name,
      description: result?.messages?.[0]?.status?.description,
    });
    return res.json({ success: true, normalizedNumber: number, data: result });
  } catch (err) {
    logger.error('INFOBIP_ERROR', {
      to:      number,
      message: err.message,
      status:  err.response?.status,
      body:    err.response?.data,
    });
    return res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// ── HTTP & WebSocket Server Setup ─────────────────────────────────────────────
const httpServer = http.createServer(app);

// Initialize Socket.IO WebSocket Server
const io = initWebSocketServer(httpServer);

// Initialize Database & Redis Services
initMysql();
initRedis();

httpServer.listen(PORT, () => {
  logger.info('SERVER_STARTED', {
    port:      PORT,
    baseUrl:   BASE_URL,
    swagger:   `${BASE_URL}/api-docs`,
    websocket: `${BASE_URL}`,
    env:       process.env.NODE_ENV || 'production',
  });
});

// Start the GT06 GPS tracker TCP server on a separate port (default: 5022)
const gt06Server = createGt06Server();

// ── Graceful Shutdown Handlers ────────────────────────────────────────────────
let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const source = signal === 'SIGTERM' ? 'systemd_or_process_manager' : 'terminal_interrupt';
  logger.info('SERVER_SHUTDOWN', {
    signal,
    source,
    message: `Received ${signal} (${source}), shutting down gracefully...`,
  });

  try {
    await closeGt06Server(gt06Server, 'server_shutdown');
  } catch (err) {
    logger.error('GT06_SERVER_CLOSE_ERROR', { message: err.message });
  }

  httpServer.close(() => {
    logger.info('HTTP_SERVER_STOPPED', { signal });
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn('FORCE_EXIT', { message: 'Forcing process exit after shutdown timeout' });
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
