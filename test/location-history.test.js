/**
 * Automated Test Suite: Location History API & Filtering
 */
const assert = require('assert');
const gpsRoutes = require('../src/gpsRoutes');
const { initMysql, saveLocationHistory, getLocationHistory, getLocationHistoryCount, deleteDevice } = require('../src/db/mysql');

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

// Find history route handler in router stack
const historyLayer = gpsRoutes.stack.find((l) => l.route?.path === '/devices/:imei/history');
const handleGetLocationHistory = historyLayer?.route?.stack?.[0]?.handle;

const testImei = '867232054899999';
const mockAdminUser = { id: 1, email: 'admin@example.com', role: 'admin' };

async function runTests() {
  console.log('\n=== Running Location History API Automated Tests ===\n');

  assert(handleGetLocationHistory, 'Expected /devices/:imei/history route handler to be found');

  await initMysql();

  // 1. Clean up any previous test data
  await deleteDevice(testImei);

  // 2. Insert test waypoints with controlled timestamps
  const baseTime = new Date('2026-08-29T10:00:00.000Z').getTime();
  for (let i = 0; i < 5; i++) {
    await saveLocationHistory({
      imei: testImei,
      latitude: 4.888 + i * 0.001,
      longitude: 6.913 + i * 0.001,
      speed_kmh: 10 + i * 5,
      direction: i * 45,
      accOn: true,
      gpsStatus: 'A',
      timestamp: new Date(baseTime + i * 60000).toISOString(),
    });
  }

  // Test 1: Fetch default history (GET /api/gps/devices/:imei/history)
  console.log('Test 1: Fetch location history for device');
  const req1 = {
    params: { imei: testImei },
    query: {},
    user: mockAdminUser,
  };
  const res1 = createMockResponse();
  await handleGetLocationHistory(req1, res1);

  assert.strictEqual(res1.statusCode, 200);
  assert.strictEqual(res1.body.success, true);
  assert.strictEqual(res1.body.imei, testImei);
  assert.strictEqual(res1.body.count, 5);
  assert.strictEqual(res1.body.total, 5);
  assert.strictEqual(res1.body.history.length, 5);
  // Default order is DESC (newest point first: index 4 has lat 4.892)
  assert.strictEqual(res1.body.history[0].latitude, 4.892);
  console.log('✔ Test 1 Passed: Default history returned 5 records in DESC order');

  // Test 2: Chronological order (order=ASC for map route playback)
  console.log('\nTest 2: Chronological sorting (order=ASC)');
  const req2 = {
    params: { imei: testImei },
    query: { order: 'ASC' },
    user: mockAdminUser,
  };
  const res2 = createMockResponse();
  await handleGetLocationHistory(req2, res2);

  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(res2.body.history[0].latitude, 4.888); // Earliest point first
  assert.strictEqual(res2.body.history[4].latitude, 4.892); // Latest point last
  console.log('✔ Test 2 Passed: order=ASC sorted from start to end correctly');

  // Test 3: Pagination (limit=2, page=1 and page=2)
  console.log('\nTest 3: Pagination (limit and page)');
  const req3_p1 = {
    params: { imei: testImei },
    query: { limit: '2', page: '1', order: 'ASC' },
    user: mockAdminUser,
  };
  const res3_p1 = createMockResponse();
  await handleGetLocationHistory(req3_p1, res3_p1);

  assert.strictEqual(res3_p1.statusCode, 200);
  assert.strictEqual(res3_p1.body.count, 2);
  assert.strictEqual(res3_p1.body.total, 5);
  assert.strictEqual(res3_p1.body.pagination.totalPages, 3);
  assert.strictEqual(res3_p1.body.pagination.hasMore, true);
  assert.strictEqual(res3_p1.body.history[0].latitude, 4.888);

  const req3_p2 = {
    params: { imei: testImei },
    query: { limit: '2', page: '2', order: 'ASC' },
    user: mockAdminUser,
  };
  const res3_p2 = createMockResponse();
  await handleGetLocationHistory(req3_p2, res3_p2);

  assert.strictEqual(res3_p2.statusCode, 200);
  assert.strictEqual(res3_p2.body.count, 2);
  assert.strictEqual(res3_p2.body.history[0].latitude, 4.890); // 3rd point
  console.log('✔ Test 3 Passed: Pagination with pages and limit works accurately');

  // Test 4: Date Range Filtering (since / until)
  console.log('\nTest 4: Date Range Filtering (since & until)');
  const sinceTime = new Date(baseTime + 1 * 60000).toISOString(); // 10:01
  const untilTime = new Date(baseTime + 3 * 60000).toISOString(); // 10:03
  const req4 = {
    params: { imei: testImei },
    query: { since: sinceTime, until: untilTime, order: 'ASC' },
    user: mockAdminUser,
  };
  const res4 = createMockResponse();
  await handleGetLocationHistory(req4, res4);

  assert.strictEqual(res4.statusCode, 200);
  assert.strictEqual(res4.body.count, 3);
  assert.strictEqual(res4.body.total, 3);
  console.log('✔ Test 4 Passed: Date range correctly filtered 3 out of 5 waypoints');

  // Test 5: Alias endpoint /api/gps/history with ?imei=...
  console.log('\nTest 5: Query parameter alias (?imei=...)');
  const req5 = {
    params: {},
    query: { imei: testImei },
    user: mockAdminUser,
  };
  const res5 = createMockResponse();
  await handleGetLocationHistory(req5, res5);

  assert.strictEqual(res5.statusCode, 200);
  assert.strictEqual(res5.body.count, 5);
  console.log('✔ Test 5 Passed: Alias query parameter route verified');

  // Clean up
  await deleteDevice(testImei);
  console.log('\n=============================================');
  console.log('  ALL LOCATION HISTORY TESTS PASSED (100%)');
  console.log('=============================================\n');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
