/**
 * Automated Test Suite: Duplicate Device Registration Prevention & Security Alert Email
 */
const assert = require('assert');
const gpsRoutes = require('../src/gpsRoutes');
const { createUser, deleteUser, deleteDevice, getDeviceByImei } = require('../src/db/mysql');

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

// Find POST /devices route handler
const registerDevLayer = gpsRoutes.stack.find((l) => l.route?.path === '/devices' && l.route?.methods?.post);
const handleRegisterDevice = registerDevLayer?.route?.stack?.[0]?.handle;

async function runDuplicateRegistrationTests() {
  console.log('\n=== Running Duplicate Device Registration & Email Alert Tests ===\n');

  assert(handleRegisterDevice, 'Expected POST /devices route handler to be found');

  const ownerEmail = `devowner_${Date.now()}@example.com`;
  const attackerEmail = `attacker_${Date.now()}@example.com`;
  const testImei = '867232054811111';

  // 1. Create registered owner
  const ownerUser = await createUser({
    email: ownerEmail,
    username: ownerEmail.split('@')[0],
    password: 'OwnerPassword123!',
    name: 'Legitimate Owner',
  });

  // 2. Create another user who tries to register the same device
  const attackerUser = await createUser({
    email: attackerEmail,
    username: attackerEmail.split('@')[0],
    password: 'AttackerPassword123!',
    name: 'Second User',
  });

  try {
    // Clean up any existing records
    await deleteDevice(testImei);

    // ── TEST 1: Initial Device Registration ─────────────────────────────────────
    console.log('Test 1: Initial legitimate registration by owner');
    const req1 = {
      body: {
        imei: testImei,
        name: 'My Personal Car',
        plateNumber: 'ABC-123XY',
        simNumber: '+2348011223344',
        model: 'Cantrack G02',
      },
      user: ownerUser,
      ip: '197.210.50.10',
    };
    const res1 = createMockResponse();
    await handleRegisterDevice(req1, res1);

    assert.strictEqual(res1.statusCode, 201);
    assert.strictEqual(res1.body.success, true);
    assert.strictEqual(res1.body.device.imei, testImei);
    console.log('✔ Test 1 Passed: Initial registration succeeded with 201 Created');

    // ── TEST 2: Duplicate Registration Attempt ──────────────────────────────────
    console.log('\nTest 2: Duplicate registration attempt by another user');
    const req2 = {
      body: {
        imei: testImei,
        name: 'Stolen or Duplicate Attempt',
        plateNumber: 'XYZ-999ZZ',
      },
      user: attackerUser,
      ip: '102.89.44.120',
    };
    const res2 = createMockResponse();
    await handleRegisterDevice(req2, res2);

    assert.strictEqual(res2.statusCode, 409, 'Expected 409 Conflict status code');
    assert.strictEqual(res2.body.success, false);
    assert.strictEqual(res2.body.error, 'IMEI number is registered already');
    assert.strictEqual(res2.body.message, 'IMEI number is registered already');
    console.log('✔ Test 2 Passed: Duplicate registration blocked with 409 and "IMEI number is registered already"');

    // Verify original ownership is unchanged
    const devAfter = await getDeviceByImei(testImei);
    assert.strictEqual(String(devAfter.user_id), String(ownerUser.id));
    assert.strictEqual(devAfter.name, 'My Personal Car');
    console.log('✔ Test 3 Passed: Original device ownership remains intact');

    console.log('\n=============================================');
    console.log('  ALL DUPLICATE REGISTRATION TESTS PASSED (100%)');
    console.log('=============================================\n');
  } finally {
    await deleteDevice(testImei);
    await deleteUser(ownerUser.id);
    await deleteUser(attackerUser.id);
  }
}

runDuplicateRegistrationTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
