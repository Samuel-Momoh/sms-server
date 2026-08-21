require('dotenv').config();

const express      = require('express');
const swaggerUi    = require('swagger-ui-express');
const swaggerJsDoc = require('swagger-jsdoc');
const { sendSms }  = require('./src/infobip');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Swagger setup ─────────────────────────────────────────────────────────────
const swaggerSpec = swaggerJsDoc({
  swaggerDefinition: {
    openapi: '3.0.0',
    info: {
      title: 'SMS Gateway API',
      version: '1.0.0',
      description:
        'Drop-in SMS gateway server powered by Infobip. ' +
        'Mimics the classic gateway URL format used by portals like Syctech.\n\n' +
        '**Gateway URL format:** `http://YOUR_SERVER/sendsms.php?username=USER&password=PASSWORD&number=%NUMBER%&message=%MESSAGE%`',
    },
    servers: [{ url: `http://localhost:${PORT}`, description: 'Local dev' }],
  },
  apis: ['./index.js'],
});

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, { customSiteTitle: 'SMS Gateway Docs' }));

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /:
 *   get:
 *     summary: Health check
 *     responses:
 *       200:
 *         description: Server is running
 */
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SMS Gateway', docs: `/api-docs` });
});

// Shared handler for GET + POST /sendsms.php
async function handleSendSms(req, res) {
  const number   = req.query.number   || req.body.number;
  const message  = req.query.message  || req.body.message;
  const username = req.query.username || req.body.username;
  const password = req.query.password || req.body.password;

  // Optional credential check (set GATEWAY_USERNAME + GATEWAY_PASSWORD in .env)
  const expectedUser = process.env.GATEWAY_USERNAME;
  const expectedPass = process.env.GATEWAY_PASSWORD;
  if (expectedUser && expectedPass) {
    if (username !== expectedUser || password !== expectedPass) {
      return res.status(401).json({ success: false, error: 'Invalid username or password.' });
    }
  }

  if (!number || !message) {
    return res.status(400).json({ success: false, error: 'number and message are required.' });
  }

  try {
    const result = await sendSms(number, message);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[sendsms]', err.response?.data || err.message);
    return res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
}

/**
 * @swagger
 * /sendsms.php:
 *   post:
 *     summary: Send SMS via POST (classic gateway format)
 *     description: |
 *       Mirrors the Syctech / classic SMS gateway URL.
 *       Configure your portal's **SMS gateway URL** to:
 *       ```
 *       http://YOUR_SERVER/sendsms.php?username=USER&password=PASSWORD&number=%NUMBER%&message=%MESSAGE%
 *       ```
 *     parameters:
 *       - in: query
 *         name: username
 *         required: true
 *         schema: { type: string }
 *         example: admin
 *       - in: query
 *         name: password
 *         required: true
 *         schema: { type: string }
 *         example: secret
 *       - in: query
 *         name: number
 *         required: true
 *         description: Recipient phone — replaces %NUMBER%
 *         schema: { type: string }
 *         example: "+447911123456"
 *       - in: query
 *         name: message
 *         required: true
 *         description: SMS text — replaces %MESSAGE%
 *         schema: { type: string }
 *         example: "Hello from the gateway!"
 *     responses:
 *       200:
 *         description: SMS sent
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:    { type: object }
 *       400:
 *         description: Missing number or message
 *       401:
 *         description: Bad credentials
 *       500:
 *         description: Infobip error
 *   get:
 *     summary: Send SMS via GET (classic gateway format)
 *     description: Same as POST but via GET — use when your portal only supports GET requests.
 *     parameters:
 *       - in: query
 *         name: username
 *         required: true
 *         schema: { type: string }
 *         example: admin
 *       - in: query
 *         name: password
 *         required: true
 *         schema: { type: string }
 *         example: secret
 *       - in: query
 *         name: number
 *         required: true
 *         schema: { type: string }
 *         example: "+447911123456"
 *       - in: query
 *         name: message
 *         required: true
 *         schema: { type: string }
 *         example: "Hello!"
 *     responses:
 *       200:
 *         description: SMS sent
 *       400:
 *         description: Missing number or message
 *       401:
 *         description: Bad credentials
 *       500:
 *         description: Infobip error
 */
app.post('/sendsms.php', handleSendSms);
app.get('/sendsms.php',  handleSendSms);

/**
 * @swagger
 * /send-sms:
 *   post:
 *     summary: Send SMS via JSON body (REST)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [number, message]
 *             properties:
 *               number:  { type: string, example: "+447911123456" }
 *               message: { type: string, example: "Hello!" }
 *     responses:
 *       200:
 *         description: SMS sent
 *       400:
 *         description: Missing fields
 *       500:
 *         description: Infobip error
 */
app.post('/send-sms', async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message)
    return res.status(400).json({ success: false, error: '"number" and "message" are required.' });

  try {
    const result = await sendSms(number, message);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[send-sms]', err.response?.data || err.message);
    return res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  SMS Gateway    → http://localhost:${PORT}`);
  console.log(`📖  Swagger UI     → http://localhost:${PORT}/api-docs`);
  console.log(`   POST/GET /sendsms.php?username=&password=&number=&message=`);
  console.log(`   POST     /send-sms  { number, message }`);
});
