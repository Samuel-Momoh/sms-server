'use strict';

const assert = require('assert');
const {
  _processBuffer,
  deviceRegistry,
  deviceStates,
  sendDeviceCommand,
} = require('../src/gt06Server');
const {
  enqueueCommand,
  getQueuedCommands,
  cancelQueuedCommand,
  clearQueue,
  flushQueuedCommands,
} = require('../src/services/commandQueue');

function createMockSocket(remoteAddress = '127.0.0.1', remotePort = 12345) {
  const written = [];
  const eventHandlers = {};
  return {
    remoteAddress,
    remotePort,
    written,
    setTimeout: () => {},
    setKeepAlive: () => {},
    setNoDelay: () => {},
    on: (evt, handler) => {
      if (!eventHandlers[evt]) eventHandlers[evt] = [];
      eventHandlers[evt].push(handler);
    },
    write: (data, cb) => {
      written.push(data);
      if (cb) cb(null);
    },
    destroy: () => {},
  };
}

async function runTests() {
  console.log('=== Running Command Queue & Persistence Tests ===\n');

  // 1. Direct Command Queue Logic Tests
  const mockImei = '867232054859999';
  await clearQueue(mockImei);

  console.log('[Test 1] Enqueuing command for offline device...');
  const res1 = await enqueueCommand(
    mockImei,
    'S20',
    [1, 1],
    {},
    () => Promise.resolve({ success: true }),
    () => false // isOnline = false
  );

  assert.strictEqual(res1.success, true, 'Result should be successful');
  assert.strictEqual(res1.queued, true, 'Command should be marked as queued');
  assert.ok(res1.commandId, 'Should return a unique commandId');
  console.log('✔ Enqueued command successfully:', res1.commandId);

  console.log('\n[Test 2] Querying queue items...');
  const queueItems = await getQueuedCommands(mockImei);
  assert.strictEqual(queueItems.length, 1, 'Queue should have 1 item');
  assert.strictEqual(queueItems[0].cmd, 'S20', 'Cmd code should match');
  console.log('✔ Verified queue length = 1');

  console.log('\n[Test 3] Cancelling a queued command...');
  const cancelRes = await cancelQueuedCommand(mockImei, res1.commandId);
  assert.strictEqual(cancelRes, true, 'Should successfully cancel command');
  const emptyQueue = await getQueuedCommands(mockImei);
  assert.strictEqual(emptyQueue.length, 0, 'Queue should be empty after cancellation');
  console.log('✔ Successfully cancelled command');

  // 2. Integration Test with Auto-Flush on Device Wakeup
  console.log('\n[Test 4] TCP Server Wakeup & Queue Auto-Flush Integration...');
  const targetImei = '867232054858888';
  await clearQueue(targetImei);

  // Enqueue S20 cut command while offline
  const enqueueRes = await enqueueCommand(
    targetImei,
    'S20',
    [1, 1],
    {},
    (imei, cmd, params, opts) => sendDeviceCommand(imei, cmd, params, opts),
    () => deviceRegistry.has(targetImei)
  );
  assert.strictEqual(enqueueRes.queued, true);

  // Now simulate tracker connecting and sending V0 login
  const mockSock = createMockSocket();
  const state = { protocol: null, buffer: Buffer.from(`*HQ,${targetImei},V0#\r\n`) };
  _processBuffer(mockSock, state);

  assert.strictEqual(deviceRegistry.get(targetImei), mockSock, 'Device should be registered');
  assert.ok(mockSock.written.length >= 1, 'Mock socket should receive packets');
  const loginAck = mockSock.written[0];
  assert.ok(loginAck.includes('V0'), 'Tracker should receive V0 login ACK');

  // Wait briefly for async auto-flush worker to complete
  await new Promise((r) => setTimeout(r, 100));

  // Verify queue was auto-flushed by _processBuffer on login
  const remainingQueue = await getQueuedCommands(targetImei);
  assert.strictEqual(remainingQueue.length, 0, 'Queue should be empty after auto-flush on wakeup');

  const writtenCommands = mockSock.written.join('');
  assert.ok(writtenCommands.includes('S20'), 'Tracker should receive auto-flushed S20 command on wakeup');
  console.log('✔ Auto-flush on tracker wakeup verified successfully!');

  // Cleanup
  deviceRegistry.delete(targetImei);
  deviceStates.delete(targetImei);
  await clearQueue(targetImei);

  console.log('\n=============================================');
  console.log('  ALL COMMAND QUEUE TESTS PASSED (100%)');
  console.log('=============================================\n');
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
