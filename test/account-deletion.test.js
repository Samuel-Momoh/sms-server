'use strict';

const assert = require('assert');
const {
  createUser,
  findUserByEmailOrUsername,
  getDeletionOtp,
  registerNewDevice,
  getDeviceByImei,
} = require('../src/db/mysql');
const gpsRoutes = require('../src/gpsRoutes');

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

// Find the handleAccountDeletion middleware in router stack
const deleteAccountLayer = gpsRoutes.stack.find((layer) => layer.route?.path === '/auth/delete-account');
const handleAccountDeletion = deleteAccountLayer?.route?.stack?.[0]?.handle;

async function runAccountDeletionTests() {
  console.log('Running 2-Step Account Deletion Unit/Integration Tests...\n');

  assert(handleAccountDeletion, 'Expected /auth/delete-account route handler to be found');

  const testEmail = `deluser_${Date.now()}@example.com`;
  const testPassword = 'Password123!';
  const testImei = '867232054850999';

  // 1. Create a user to delete
  const user = await createUser({
    email: testEmail,
    username: testEmail.split('@')[0],
    password: testPassword,
    name: 'Deletion Candidate',
  });
  assert(user && user.id, 'User should be created');

  // 2. Assign a device to this user
  await registerNewDevice({
    imei: testImei,
    name: 'Vehicle to Purge',
    userId: user.id,
    model: 'Cantrack G02',
  });
  const devBefore = await getDeviceByImei(testImei);
  assert(devBefore, 'Device should exist before deletion');

  // 3. Step 1: Request Deletion Code with verify: false
  console.log('Test 1: Request account deletion code (verify: false)');
  const req1 = {
    body: {
      email: testEmail,
      reason: 'No longer using tracking service',
      verify: false,
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res1 = createMockResponse();
  await handleAccountDeletion(req1, res1);

  assert.strictEqual(res1.statusCode, 200, 'Step 1 should return 200');
  assert.strictEqual(res1.body.success, true);
  assert.strictEqual(res1.body.verify, false);
  assert.strictEqual(res1.body.email, testEmail);
  console.log('✅ Step 1 Passed: Deletion OTP generated\n');

  // Verify OTP was stored
  const storedOtp = getDeletionOtp(testEmail);
  assert(storedOtp && storedOtp.code, 'OTP code must be stored in memory');
  assert.strictEqual(storedOtp.code.length, 6, 'OTP must be 6 digits');

  // 4. Test Step 2 with INVALID code
  console.log('Test 2: Attempt confirmation with invalid code');
  const reqInvalid = {
    body: {
      email: testEmail,
      code: '000000',
      verify: true,
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const resInvalid = createMockResponse();
  await handleAccountDeletion(reqInvalid, resInvalid);

  assert.strictEqual(resInvalid.statusCode, 400, 'Invalid code should return 400');
  assert.strictEqual(resInvalid.body.success, false);
  console.log('✅ Step 2 Invalid Code Test Passed\n');

  // 5. Test Step 2 with VALID code
  console.log('Test 3: Confirm deletion with correct OTP (verify: true)');
  const req2 = {
    body: {
      email: testEmail,
      code: storedOtp.code,
      verify: true,
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res2 = createMockResponse();
  await handleAccountDeletion(req2, res2);

  assert.strictEqual(res2.statusCode, 200, 'Step 2 should return 200');
  assert.strictEqual(res2.body.success, true);
  assert.strictEqual(res2.body.verify, true);
  console.log('✅ Step 2 Passed: Account and devices purged\n');

  // 6. Verify User is deleted
  const userAfter = await findUserByEmailOrUsername(testEmail);
  assert(!userAfter, 'User should be purged from database/memory');

  // 7. Verify Device is deleted
  const devAfter = await getDeviceByImei(testImei);
  assert(!devAfter, 'Device should be purged from database/memory');

  // 8. Test requesting deletion on non-existent account
  console.log('Test 4: Request deletion on non-existent account');
  const reqNonExistent = {
    body: {
      email: 'nobody@nowhere.com',
      verify: false,
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const resNonExistent = createMockResponse();
  await handleAccountDeletion(reqNonExistent, resNonExistent);

  assert.strictEqual(resNonExistent.statusCode, 404, 'Non-existent account should return 404');
  console.log('✅ Test 4 Passed\n');

  console.log('🎉 ALL ACCOUNT DELETION TESTS PASSED SUCCESSFULLY!\n');
}

runAccountDeletionTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
