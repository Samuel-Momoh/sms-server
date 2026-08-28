'use strict';

const axios = require('axios');
const { logger } = require('../logger');

/**
 * Send an email using SendGrid API (v3).
 *
 * @param {object} options
 * @param {string} options.to - Recipient email address
 * @param {string} options.subject - Email subject
 * @param {string} options.text - Plain text content
 * @param {string} options.html - HTML content
 * @returns {Promise<boolean>}
 */
async function sendEmail({ to, subject, text, html }) {
  const apiKey = process.env.SEND_API_KEY || process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM || process.env.ADMIN_USER || process.env.GATEWAY_USERNAME || 'momohofficial@gmail.com';
  const fromName = process.env.SENDGRID_FROM_NAME || 'GPS Fleet Gateway';

  if (!apiKey) {
    logger.warn('SENDGRID_API_KEY_MISSING', {
      to,
      subject,
      message: 'SEND_API_KEY is not configured in .env',
    });
    return false;
  }

  const payload = {
    personalizations: [
      {
        to: [{ email: to.trim().toLowerCase() }],
        subject,
      },
    ],
    from: {
      email: fromEmail.trim(),
      name: fromName.trim(),
    },
    content: [
      {
        type: 'text/plain',
        value: text || subject,
      },
      ...(html ? [{ type: 'text/html', value: html }] : []),
    ],
  };

  try {
    const response = await axios.post('https://api.sendgrid.com/v3/mail/send', payload, {
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    const isSuccess = response.status >= 200 && response.status < 300;
    if (isSuccess) {
      logger.info('EMAIL_SENT_SUCCESSFULLY', {
        to,
        subject,
        statusCode: response.status,
      });
    }
    return isSuccess;
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    logger.error('SENDGRID_EMAIL_SEND_ERROR', {
      to,
      subject,
      error: errMsg,
      status: err.response?.status,
    });
    return false;
  }
}

/**
 * Generate and send an Account Deletion Verification Code email.
 *
 * @param {string} email - User's email
 * @param {string} code - 6-digit OTP code
 * @param {string} [reason] - Optional reason provided by user
 * @returns {Promise<boolean>}
 */
async function sendAccountDeletionOtp(email, code, reason = '') {
  const subject = 'Account Deletion Verification Code - Action Required';
  const text = `Your verification code to permanently delete your GPS Tracking account is: ${code}\n\nThis code will expire in 15 minutes. If you did not request this, please secure your account immediately.`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Account Deletion Verification</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; margin: 0; padding: 20px; color: #f8fafc; }
        .card { max-width: 500px; margin: 0 auto; background: #1e293b; border-radius: 12px; padding: 32px; border: 1px solid #334155; }
        .header { text-align: center; margin-bottom: 24px; }
        .alert-badge { display: inline-block; background: #ef4444; color: #ffffff; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
        .title { font-size: 20px; font-weight: 700; color: #ffffff; margin-top: 12px; margin-bottom: 8px; }
        .code-box { background: #0f172a; border: 2px dashed #ef4444; border-radius: 8px; text-align: center; padding: 18px; margin: 24px 0; }
        .code { font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #f87171; font-family: monospace; }
        .warning { font-size: 13px; color: #94a3b8; line-height: 1.5; margin-bottom: 16px; }
        .footer { font-size: 11px; color: #64748b; text-align: center; border-top: 1px solid #334155; padding-top: 16px; margin-top: 24px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <span class="alert-badge">Warning</span>
          <h2 class="title">Account Deletion Request</h2>
          <p style="color: #94a3b8; font-size: 14px; margin: 0;">You have requested to permanently delete your account.</p>
        </div>

        <div class="code-box">
          <div style="font-size: 12px; color: #94a3b8; text-transform: uppercase; margin-bottom: 6px;">Your Verification Code</div>
          <div class="code">${code}</div>
          <div style="font-size: 11px; color: #64748b; margin-top: 6px;">Valid for 15 minutes</div>
        </div>

        <div class="warning">
          <strong>⚠️ What happens next?</strong><br>
          Entering this code will permanently erase your profile, all registered GPS trackers, vehicle data, and location history. This action cannot be undone.
        </div>

        ${reason ? `<div class="warning" style="background: #0f172a; padding: 10px; border-radius: 6px;"><strong>Reason provided:</strong> ${reason}</div>` : ''}

        <div class="footer">
          If you did not request account deletion, please ignore this email or change your password immediately.
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({ to: email, subject, text, html });
}

/**
 * Generate and send a Password Reset Verification Code email.
 *
 * @param {string} email - User's email
 * @param {string} code - 6-digit OTP code
 * @returns {Promise<boolean>}
 */
async function sendPasswordResetOtp(email, code) {
  const subject = 'Password Reset Verification Code';
  const text = `Your verification code to reset your GPS Tracking password is: ${code}\n\nThis code will expire in 15 minutes. If you did not request a password reset, please ignore this email.`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Password Reset Verification</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; margin: 0; padding: 20px; color: #f8fafc; }
        .card { max-width: 500px; margin: 0 auto; background: #1e293b; border-radius: 12px; padding: 32px; border: 1px solid #334155; }
        .header { text-align: center; margin-bottom: 24px; }
        .badge { display: inline-block; background: #3b82f6; color: #ffffff; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
        .title { font-size: 20px; font-weight: 700; color: #ffffff; margin-top: 12px; margin-bottom: 8px; }
        .code-box { background: #0f172a; border: 2px dashed #3b82f6; border-radius: 8px; text-align: center; padding: 18px; margin: 24px 0; }
        .code { font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #60a5fa; font-family: monospace; }
        .info { font-size: 13px; color: #94a3b8; line-height: 1.5; margin-bottom: 16px; }
        .footer { font-size: 11px; color: #64748b; text-align: center; border-top: 1px solid #334155; padding-top: 16px; margin-top: 24px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <span class="badge">Password Reset</span>
          <h2 class="title">Reset Your Password</h2>
          <p style="color: #94a3b8; font-size: 14px; margin: 0;">Use the verification code below to reset your password.</p>
        </div>

        <div class="code-box">
          <div style="font-size: 12px; color: #94a3b8; text-transform: uppercase; margin-bottom: 6px;">Your Verification Code</div>
          <div class="code">${code}</div>
          <div style="font-size: 11px; color: #64748b; margin-top: 6px;">Valid for 15 minutes</div>
        </div>

        <div class="info">
          Enter this verification code in your mobile application or web portal along with your new password to complete the reset process.
        </div>

        <div class="footer">
          If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({ to: email, subject, text, html });
}

module.exports = {
  sendEmail,
  sendAccountDeletionOtp,
  sendPasswordResetOtp,
};
