/**
 * Automated Test Suite: Tester Account TomTom Simulation & Command Execution
 */
const assert = require('assert');
const gpsRoutes = require('../src/gpsRoutes');
const { gpsEventEmitter } = require('../src/gpsEvents');
const { isDeviceConnected, getDeviceState } = require('../src/gt06Server');
const {
  isTesterUser,
  fetchTomTomRoute,
  startTesterSimulation,
  stopTesterSimulation,
  handleTesterCommand,
  isTesterSimulationActive,
} = require('../src/services/testerSimulator');

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

// Find route layers
const getDevicesLayer = gpsRoutes.stack.find((l) => l.route?.path === '/devices' && l.route?.methods?.get);
const handleGetDevices = getDevicesLayer?.route?.stack?.[0]?.handle;

const sendCmdLayer = gpsRoutes.stack.find((l) => l.route?.path === '/devices/:imei/command' && l.route?.methods?.post);
const handleSendCommand = sendCmdLayer?.route?.stack?.[1]?.handle;

const cutOilLayer = gpsRoutes.stack.find((l) => l.route?.path === '/devices/:imei/cut-oil' && l.route?.methods?.post);
const handleCutOil = cutOilLayer?.route?.stack?.[1]?.handle;

const restoreOilLayer = gpsRoutes.stack.find((l) => l.route?.path === '/devices/:imei/restore-oil' && l.route?.methods?.post);
const handleRestoreOil = restoreOilLayer?.route?.stack?.[1]?.handle;

const testerUser = {
  id: 99,
  email: 'tester@gmail.com',
  username: 'tester',
  role: 'user',
};

const testerImei = '867232054850970';

async function runTesterSimulatorTests() {
  console.log('\n=== Running Tester Account Simulation & Command Tests ===\n');

  // Test 1: Identify tester user
  console.log('Test 1: Verify isTesterUser identification');
  assert.strictEqual(isTesterUser(testerUser), true);
  assert.strictEqual(isTesterUser({ email: 'other@gmail.com' }), false);
  console.log('✔ Test 1 Passed: Tester user identification verified');

  // Test 2: Fetch TomTom Route (or high-fidelity fallback)
  console.log('\nTest 2: Fetch TomTom Navigation Route');
  const route = await fetchTomTomRoute();
  assert(Array.isArray(route) && route.length >= 10, 'Route should contain at least 10 waypoints');
  assert(typeof route[0].latitude === 'number' && typeof route[0].longitude === 'number');
  console.log(`✔ Test 2 Passed: Route successfully loaded (${route.length} road waypoints)`);

  // Test 3: Querying /devices as tester triggers live transmission
  console.log('\nTest 3: Querying /devices triggers background simulation');
  const receivedUpdates = [];
  const updateListener = (data) => {
    if (data.imei === testerImei) {
      receivedUpdates.push(data);
    }
  };
  gpsEventEmitter.on('gps:update', updateListener);

  const reqGet = { user: testerUser, query: {} };
  const resGet = createMockResponse();
  await handleGetDevices(reqGet, resGet);

  assert.strictEqual(resGet.statusCode, 200);
  assert.strictEqual(resGet.body.success, true);
  assert(resGet.body.devices.length >= 1, 'Should return at least 1 tester device');
  console.log('✔ Test 3 Passed: /api/gps/devices returned tester vehicle list');

  // Await simulation tick
  await new Promise((r) => setTimeout(r, 2500));
  assert(isTesterSimulationActive(testerImei), 'Simulation should be actively running');
  assert(isDeviceConnected(testerImei), 'isDeviceConnected should report true for simulated tester vehicle');
  assert(receivedUpdates.length >= 1, 'Should have received live gps:update WebSocket broadcast');
  console.log(`✔ Test 4 Passed: Live telemetry streaming actively (${receivedUpdates.length} updates received)`);

  // Test 5: Command Execution — S20 Cut Engine / Oil
  console.log('\nTest 5: Cut Engine / Oil Command (S20,1,1)');
  const resCut = await handleTesterCommand(testerImei, 'S20', [1, 1]);
  assert.strictEqual(resCut.success, true);
  assert(resCut.response.includes('V4,S20,DONE'));

  const devStateCut = getDeviceState(testerImei);
  assert.strictEqual(devStateCut.vehicleStatus.isOilCut, true);
  console.log('✔ Test 5 Passed: S20 cut-off fuel executed and updated vehicleStatus.isOilCut = true');

  // Test 6: Command Execution — S20 Restore Engine / Oil
  console.log('\nTest 6: Restore Engine / Oil Command (S20,1,0)');
  const resRestore = await handleTesterCommand(testerImei, 'S20', [1, 0]);
  assert.strictEqual(resRestore.success, true);
  assert(resRestore.response.includes('V4,S20,OK'));

  const devStateRestore = getDeviceState(testerImei);
  assert.strictEqual(devStateRestore.vehicleStatus.isOilCut, false);
  console.log('✔ Test 6 Passed: S20 restore fuel executed and updated vehicleStatus.isOilCut = false');

  // Test 7: Other Commands (WKMD, D1, D2, R1, S26)
  console.log('\nTest 7: Execute WKMD, D1, D2, R1, S26 Tracker Commands');
  const resWkmd = await handleTesterCommand(testerImei, 'WKMD', [0]);
  assert.strictEqual(resWkmd.success, true);

  const resD1 = await handleTesterCommand(testerImei, 'D1', [15]);
  assert.strictEqual(resD1.success, true);

  const resD2 = await handleTesterCommand(testerImei, 'D2', [180]);
  assert.strictEqual(resD2.success, true);

  const resR1 = await handleTesterCommand(testerImei, 'R1', []);
  assert.strictEqual(resR1.success, true);

  const resS26 = await handleTesterCommand(testerImei, 'S26', []);
  assert.strictEqual(resS26.success, true);
  assert(resS26.response.includes('V4,S26'));
  console.log('✔ Test 7 Passed: All tracker commands responded with realistic Cantrack V4 frames');

  // Clean up
  stopTesterSimulation(testerImei);
  gpsEventEmitter.removeListener('gps:update', updateListener);
  assert.strictEqual(isTesterSimulationActive(testerImei), false);
  console.log('✔ Test 8 Passed: Simulation stopped cleanly');

  console.log('\n=============================================');
  console.log('  ALL TESTER SIMULATOR TESTS PASSED (100%)');
  console.log('=============================================\n');
}

runTesterSimulatorTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
