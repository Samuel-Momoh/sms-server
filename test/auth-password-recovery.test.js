'use strict';

const assert = require('assert');
const {
  createUser,
  findUserByEmailOrUsername,
  getPasswordResetOtp,
} = require('../src/db/mysql');
const gpsRoutes = require('../src/gpsRoutes');
const { verifyToken } = require('../src/adminAuth');

function createMockResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status: function (code) {
      this.statusCode = code;
      return this;
    },
    json: function (data) {
      this.body = data;
      return this;
    },
  };
  return res;
}

// Find route handlers in router stack
const loginLayer = gpsRoutes.stack.find((l) => l.route?.path === '/auth/login');
const handleLogin = loginLayer?.route?.stack?.[0]?.handle;

const forgotPassLayer = gpsRoutes.stack.find((l) => l.route?.path === '/auth/forgot-password');
const handleForgotPassword = forgotPassLayer?.route?.stack?.[0]?.handle;

const resetPassLayer = gpsRoutes.stack.find((l) => l.route?.path === '/auth/reset-password');
const handleResetPassword = resetPassLayer?.route?.stack?.[0]?.handle;

async function runAuthAndRecoveryTests() {
  console.log('Running Password Recovery & Remember Me Automated Tests...\n');

  assert(handleLogin, 'Expected /auth/login handler');
  assert(handleForgotPassword, 'Expected /auth/forgot-password handler');
  assert(handleResetPassword, 'Expected /auth/reset-password handler');

  const testEmail = `user_recover_${Date.now()}@example.com`;
  const initialPassword = 'InitialPassword123!';
  const updatedPassword = 'NewSecretPassword456!';

  // 1. Create a test user
  const user = await createUser({
    email: testEmail,
    username: testEmail.split('@')[0],
    password: initialPassword,
    name: 'Recovery Test User',
  });
  assert(user && user.id, 'User should be created');

  // ── TEST 1: Standard Login without Remember Me ──────────────────────────────
  console.log('Test 1: Login without Remember Me (Standard 24h session)');
  const req1 = {
    body: {
      email: testEmail,
      password: initialPassword,
      rememberMe: false,
    },
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res1 = createMockResponse();
  await handleLogin(req1, res1);

  assert.strictEqual(res1.statusCode, 200);
  assert.strictEqual(res1.body.success, true);
  assert.strictEqual(res1.body.auth.expiresIn, '24h');
  assert.strictEqual(res1.body.auth.rememberMe, false);
  console.log('✅ Test 1 Passed: Standard login returned 24h token\n');

  // ── TEST 2: Login with Remember Me = true ──────────────────────────────────
  console.log('Test 2: Login with Remember Me = true (Long-lived forever token)');
  const req2 = {
    body: {
      email: testEmail,
      password: initialPassword,
      rememberMe: true,
    },
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res2 = createMockResponse();
  await handleLogin(req2, res2);

  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(res2.body.success, true);
  assert.strictEqual(res2.body.auth.expiresIn, '3650d');
  assert.strictEqual(res2.body.auth.rememberMe, true);
  const decoded = verifyToken(res2.body.token);
  assert(decoded, 'Token should decode properly');
  console.log('✅ Test 2 Passed: Remember Me login returned 10-year / 3650d token\n');

  // ── TEST 3: Step 1 - Request Password Reset OTP ─────────────────────────────
  console.log('Test 3: Step 1 - Request Password Reset OTP (POST /forgot-password)');
  const req3 = {
    body: { email: testEmail },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res3 = createMockResponse();
  await handleForgotPassword(req3, res3);

  assert.strictEqual(res3.statusCode, 200);
  assert.strictEqual(res3.body.success, true);
  assert.strictEqual(res3.body.email, testEmail);

  const storedOtp = getPasswordResetOtp(testEmail);
  assert(storedOtp && storedOtp.code, 'OTP code must be saved');
  assert.strictEqual(storedOtp.code.length, 6, 'OTP must be 6 digits');
  console.log('✅ Test 3 Passed: 6-Digit Password Reset OTP generated & saved\n');

  // ── TEST 4: Step 2 - Attempt Reset with Invalid Code ────────────────────────
  console.log('Test 4: Attempt reset with invalid code');
  const req4 = {
    body: {
      email: testEmail,
      code: '999999',
      newPassword: updatedPassword,
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res4 = createMockResponse();
  await handleResetPassword(req4, res4);

  assert.strictEqual(res4.statusCode, 400);
  assert.strictEqual(res4.body.success, false);
  console.log('✅ Test 4 Passed: Invalid code rejected with 400 Bad Request\n');

  // ── TEST 5: Step 2 - Confirm Reset with Valid Code ──────────────────────────
  console.log('Test 5: Step 2 - Confirm Password Reset (POST /reset-password)');
  const req5 = {
    body: {
      email: testEmail,
      code: storedOtp.code,
      newPassword: updatedPassword,
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res5 = createMockResponse();
  await handleResetPassword(req5, res5);

  assert.strictEqual(res5.statusCode, 200);
  assert.strictEqual(res5.body.success, true);
  assert(res5.body.token, 'Should return fresh JWT token on password reset');
  console.log('✅ Test 5 Passed: Password reset successful\n');

  // ── TEST 6: Verify Login with New Password ─────────────────────────────────
  console.log('Test 6: Verify Login with New Password');
  const req6 = {
    body: {
      email: testEmail,
      password: updatedPassword,
    },
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res6 = createMockResponse();
  await handleLogin(req6, res6);

  assert.strictEqual(res6.statusCode, 200);
  assert.strictEqual(res6.body.success, true);
  console.log('✅ Test 6 Passed: User authenticated with new password successfully\n');

  // ── TEST 7: Verify Old Password No Longer Works ────────────────────────────
  console.log('Test 7: Verify Old Password is rejected');
  const req7 = {
    body: {
      email: testEmail,
      password: initialPassword,
    },
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res7 = createMockResponse();
  await handleLogin(req7, res7);

  assert.strictEqual(res7.statusCode, 401);
  assert.strictEqual(res7.body.success, false);
  console.log('✅ Test 7 Passed: Old password rejected with 401 Unauthorized\n');

  console.log('🎉 ALL AUTH RECOVERY & REMEMBER ME TESTS PASSED SUCCESSFULLY!\n');
}

runAuthAndRecoveryTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
