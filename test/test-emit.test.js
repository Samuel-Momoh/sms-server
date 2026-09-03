/**
 * Test: POST /api/gps/test/emit test alert & socket broadcast
 */
const assert = require('assert');
const gpsRoutes = require('../src/gpsRoutes');
const { gpsEventEmitter } = require('../src/gpsEvents');

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

const testEmitLayer = gpsRoutes.stack.find((l) => l.route?.path === '/test/emit' && l.route?.methods?.post);
const handleTestEmit = testEmitLayer?.route?.stack?.[0]?.handle;

async function runTestEmitTests() {
  console.log('\n=== Running Test Socket Emitter API Tests ===\n');

  assert(typeof handleTestEmit === 'function', 'handleTestEmit handler should be defined');

  let updateReceived = null;
  let alarmReceived = null;

  const onUpdate = (d) => { if (d.imei === '867232054850970') updateReceived = d; };
  const onAlarm = (d) => { if (d.imei === '867232054850970') alarmReceived = d; };

  gpsEventEmitter.on('gps:update', onUpdate);
  gpsEventEmitter.on('gps:alarm', onAlarm);

  // Test 1: Emit an SOS and VIBRATION alert
  const req = {
    body: {
      imei: '867232054850970',
      alarms: ['SOS', 'VIBRATION'],
      speed_kmh: 35.5,
      accOn: true,
    },
  };
  const res = createMockResponse();
  handleTestEmit(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert(res.body.emittedEvents.includes('gps:update'));
  assert(res.body.emittedEvents.includes('gps:alarm'));
  assert(updateReceived !== null, 'gps:update should have been emitted');
  assert(alarmReceived !== null, 'gps:alarm should have been emitted');
  assert.deepStrictEqual(alarmReceived.alarms, ['SOS', 'VIBRATION']);
  assert.strictEqual(alarmReceived.speed_kmh, 35.5);

  gpsEventEmitter.removeListener('gps:update', onUpdate);
  gpsEventEmitter.removeListener('gps:alarm', onAlarm);

  console.log('✔ Test 1 Passed: Both gps:update and gps:alarm emitted with custom payload');

  console.log('\n=============================================');
  console.log('  ALL TEST EMIT API TESTS PASSED (100%)');
  console.log('=============================================\n');
}

runTestEmitTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
