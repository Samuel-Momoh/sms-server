require('dotenv').config();

const http                  = require('http');
const express               = require('express');
const swaggerUi             = require('swagger-ui-express');
const { sendSms }           = require('./src/infobip');
const { normalizePhone }    = require('./src/normalizePhone');
const { logger }            = require('./src/logger');
const { createGt06Server, closeGt06Server } = require('./src/gt06Server');
const { initWebSocketServer } = require('./src/wsServer');
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
    '/api/gps/auth/login': {
      post: {
        tags: ['GPS Auth'],
        summary: 'Admin Login',
        description: 'Validates admin credentials and returns a signed JWT token to pass as `Authorization: Bearer <token>`.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: {
                  username: { type: 'string', example: 'admin' },
                  password: { type: 'string', example: 'secret' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Authenticated successfully with JWT token',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    message: { type: 'string', example: 'Admin authenticated successfully' },
                    token: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
                    auth: {
                      type: 'object',
                      properties: {
                        type: { type: 'string', example: 'Bearer' },
                        token: { type: 'string' },
                        header: { type: 'string', example: 'Bearer eyJhbGci...' },
                        expiresIn: { type: 'string', example: '24h' },
                      },
                    },
                    user: {
                      type: 'object',
                      properties: {
                        username: { type: 'string', example: 'admin' },
                        role: { type: 'string', example: 'admin' },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Invalid credentials' },
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
            content: { 'application/json': { schema: { type: 'object', properties: {
              success: { type: 'boolean', example: true },
              count:   { type: 'number', example: 1 },
              devices: { type: 'array', items: { type: 'object' } },
            }}}},
          },
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
        summary: 'Send Raw Cantrack Command',
        description: 'Send custom raw commands with arguments (e.g. command="WKMD", params=["0"]).',
        parameters: [
          { in: 'path', name: 'imei', required: true, schema: { type: 'string' }, example: '867232054850970' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['command'],
                properties: {
                  command: { type: 'string', example: 'WKMD', description: 'Command code (e.g. WKMD, D1, S20, R1)' },
                  params:  { type: 'array', items: { type: 'string' }, example: ['0'] },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Raw command sent' } },
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
