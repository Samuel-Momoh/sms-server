require('dotenv').config();

const express              = require('express');
const swaggerUi            = require('swagger-ui-express');
const { sendSms }          = require('./src/infobip');
const { normalizePhone }   = require('./src/normalizePhone');
const { logger }           = require('./src/logger');
const { createGt06Server, closeGt06Server } = require('./src/gt06Server');

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

// ── Swagger spec (fully programmatic so BASE_URL is dynamic) ──────────────────
const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'SMS Gateway API',
    version: '1.0.0',
    description:
      'Drop-in SMS gateway server powered by Infobip. ' +
      'Mimics the classic gateway URL format used by portals like Syctech.\n\n' +
      `**Gateway URL:**\n\`${BASE_URL}/sendsms.php?username=USER&password=PASSWORD&number=%NUMBER%&message=%MESSAGE%\`\n\n` +
      '**Phone normalisation (auto-applied):**\n' +
      '- 11-digit numbers starting with `0` → strip `0`, prepend `234`\n' +
      '- 9 or 10 digit numbers → prepend `234`\n' +
      '- Numbers with `+` and more than 11 digits → strip the `+`',
  },
  servers: [
    {
      url: BASE_URL,
      description: process.env.NODE_ENV === 'development' ? 'Local dev' : 'Production (Render)',
    },
  ],
  paths: {
    '/': {
      get: {
        summary: 'Health check',
        responses: {
          200: { description: 'Server is running' },
        },
      },
    },
    '/sendsms.php': {
      post: {
        summary: 'Send SMS via POST (classic gateway format)',
        description:
          'Mirrors the Syctech / classic SMS gateway URL.\n\n' +
          `Configure your portal SMS gateway URL to:\n\`${BASE_URL}/sendsms.php?username=USER&password=PASSWORD&number=%NUMBER%&message=%MESSAGE%\`\n\n` +
          '**Phone normalisation** is applied automatically.',
        parameters: [
          { in: 'query', name: 'username', required: true,  schema: { type: 'string' }, example: 'admin' },
          { in: 'query', name: 'password', required: true,  schema: { type: 'string' }, example: 'secret' },
          { in: 'query', name: 'number',   required: true,  schema: { type: 'string' }, example: '08012345678',
            description: 'Recipient phone. 9/10 digits → 234 prepended. 11-digit starting 0 → 0 stripped + 234. Has + with >11 digits → + stripped.' },
          { in: 'query', name: 'message',  required: true,  schema: { type: 'string' }, example: 'Hello from the gateway!' },
        ],
        responses: {
          200: {
            description: 'SMS sent',
            content: { 'application/json': { schema: { type: 'object', properties: {
              success:          { type: 'boolean', example: true },
              normalizedNumber: { type: 'string',  example: '2348012345678' },
              data:             { type: 'object' },
            }}}},
          },
          400: { description: 'Missing number or message' },
          401: { description: 'Bad credentials' },
          500: { description: 'Infobip error' },
        },
      },
      get: {
        summary: 'Send SMS via GET (classic gateway format)',
        description: 'Same as POST — use when your portal only supports GET requests.',
        parameters: [
          { in: 'query', name: 'username', required: true,  schema: { type: 'string' }, example: 'admin' },
          { in: 'query', name: 'password', required: true,  schema: { type: 'string' }, example: 'secret' },
          { in: 'query', name: 'number',   required: true,  schema: { type: 'string' }, example: '08012345678',
            description: 'Recipient phone. Auto-normalised to Nigerian E.164 format.' },
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
        summary: 'Send SMS via JSON body (REST)',
        description:
          'Modern REST endpoint. Phone normalisation applied automatically:\n' +
          '- 11-digit numbers starting with `0` → strip `0`, prepend `234`\n' +
          '- 9 or 10 digit numbers → prepend `234`\n' +
          '- Numbers with `+` and more than 11 digits → strip the `+`',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['number', 'message'],
                properties: {
                  number:  { type: 'string', example: '08012345678', description: 'Auto-normalised to Nigerian E.164 format.' },
                  message: { type: 'string', example: 'Hello!' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'SMS sent',
            content: { 'application/json': { schema: { type: 'object', properties: {
              success:          { type: 'boolean', example: true },
              normalizedNumber: { type: 'string',  example: '2348012345678' },
              data:             { type: 'object' },
            }}}},
          },
          400: { description: 'Missing fields' },
          500: { description: 'Infobip error' },
        },
      },
    },
  },
};

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, { customSiteTitle: 'SMS Gateway Docs' }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SMS Gateway', docs: '/api-docs' });
});

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

// ── Start ─────────────────────────────────────────────────────────────────────
const httpServer = app.listen(PORT, () => {
  logger.info('SERVER_STARTED', {
    port:    PORT,
    baseUrl: BASE_URL,
    swagger: `${BASE_URL}/api-docs`,
    env:     process.env.NODE_ENV || 'production',
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

  // Force exit after 5 seconds if graceful shutdown takes too long
  setTimeout(() => {
    logger.warn('FORCE_EXIT', { message: 'Forcing process exit after shutdown timeout' });
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

