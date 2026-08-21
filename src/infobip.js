const axios = require('axios');

/**
 * Sends an SMS via Infobip REST API v3.
 * @param {string} to   - Recipient phone number (E.164 format, e.g. +447911123456)
 * @param {string} text - Message body
 * @returns {Promise<object>} Infobip response data
 */
async function sendSms(to, text) {
  const baseUrl = process.env.INFOBIP_BASE_URL;
  const apiKey  = process.env.INFOBIP_API_KEY;
  const sender  = process.env.INFOBIP_SENDER || 'InfoSMS';

  if (!baseUrl || !apiKey) {
    throw new Error('INFOBIP_BASE_URL and INFOBIP_API_KEY must be set in .env');
  }

  const base = baseUrl.replace(/\/$/, '');

  const response = await axios.post(
    `${base}/sms/3/messages`,
    {
      messages: [
        {
          sender,
          destinations: [{ to }],
          content: { text },
        },
      ],
    },
    {
      headers: {
        Authorization: `App ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    }
  );

  return response.data;
}

module.exports = { sendSms };
