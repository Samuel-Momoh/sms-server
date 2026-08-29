'use strict';

const assert = require('assert');
const gpsRoutes = require('../src/gpsRoutes');
const { gpsEventEmitter } = require('../src/gpsEvents');
const { getDeviceState } = require('../src/gt06Server');

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
const simTripLayer = gpsRoutes.stack.find((l) => l.route?.path === '/devices/simulate-trip');
const handleSimulateTrip = simTripLayer?.route?.stack?.[0]?.handle;

const stopSimTripLayer = gpsRoutes.stack.find((l) => l.route?.path === '/devices/simulate-trip/stop');
const handleStopSimulateTrip = stopSimTripLayer?.route?.stack?.[0]?.handle;

async function runSimulateTripTests() {
  console.log('Running Continuous Trip Simulator Automated Tests...\n');

  assert(handleSimulateTrip, 'Expected /devices/simulate-trip handler');
  assert(handleStopSimulateTrip, 'Expected /devices/simulate-trip/stop handler');

  const testImei = '867232054850970';
  const testCoords = [
    [4.888308, 6.913855],
    [4.888710, 6.914210],
    { latitude: 4.889150, longitude: 6.914620, speed: 50 },
    { lat: 4.889820, lon: 6.915200, speed: 60, direction: 90 },
  ];

  const receivedUpdates = [];
  const updateListener = (data) => {
    if (data.imei === testImei) {
      receivedUpdates.push(data);
    }
  };
  gpsEventEmitter.on('gps:update', updateListener);

  // ── TEST 1: Start Trip Simulation ──────────────────────────────────────────
  console.log('Test 1: Start trip simulation with 4 coordinate steps');
  const req1 = {
    params: { imei: testImei },
    body: {
      imei: testImei,
      coordinates: testCoords,
      intervalMs: 100, // fast 100ms for test
      speed: 45,
      accOn: true,
    },
  };
  const res1 = createMockResponse();
  handleSimulateTrip(req1, res1);

  assert.strictEqual(res1.statusCode, 200);
  assert.strictEqual(res1.body.success, true);
  assert.strictEqual(res1.body.totalPoints, 4);
  assert.strictEqual(receivedUpdates.length, 1, 'First coordinate should broadcast immediately');
  assert.strictEqual(receivedUpdates[0].latitude, 4.888308);
  assert.strictEqual(receivedUpdates[0].longitude, 6.913855);
  assert.strictEqual(receivedUpdates[0].accOn, true);
  console.log('✅ Test 1 Passed: Simulation started and emitted initial coordinate\n');

  // ── TEST 2: Wait for full sequence to broadcast ────────────────────────────
  console.log('Test 2: Await full sequence completion');
  await new Promise((resolve) => setTimeout(resolve, 450));

  assert.strictEqual(receivedUpdates.length, 4, `Expected all 4 coordinates to be received, got ${receivedUpdates.length}`);
  assert.strictEqual(receivedUpdates[1].latitude, 4.888710);
  assert.strictEqual(receivedUpdates[2].latitude, 4.889150);
  assert.strictEqual(receivedUpdates[3].latitude, 4.889820);
  assert.strictEqual(receivedUpdates[3].speed_kmh, 60);

  // Verify in-memory state updated
  const latestState = getDeviceState(testImei);
  assert(latestState && latestState.lastLocation, 'Device state should be cached in memory');
  assert.strictEqual(latestState.lastLocation.latitude, 4.889820);
  console.log('✅ Test 2 Passed: Full coordinate stream broadcasted sequentially to gps:update\n');

  // ── TEST 3: Stop Simulation API ───────────────────────────────────────────
  console.log('Test 3: Stop Simulation API');
  const req3 = {
    params: { imei: testImei },
    body: { imei: testImei },
  };
  const res3 = createMockResponse();
  handleStopSimulateTrip(req3, res3);

  assert.strictEqual(res3.statusCode, 200);
  assert.strictEqual(res3.body.success, true);
  console.log('✅ Test 3 Passed: Stop simulation endpoint verified\n');

  gpsEventEmitter.off('gps:update', updateListener);
  console.log('🎉 ALL TRIP SIMULATOR TESTS PASSED SUCCESSFULLY!\n');
}

runSimulateTripTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
