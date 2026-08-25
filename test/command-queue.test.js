'use strict';

const assert = require('assert');
const net = require('net');
const http = require('http');
const express = require('express');
const { createGt06Server, closeGt06Server } = require('../src/gt06Server');
const {
  enqueueCommand,
  getQueuedCommands,
  cancelQueuedCommand,
  clearQueue,
} = require('../src/services/commandQueue');
const gpsRoutes = require('../src/gpsRoutes');
const { generateToken } = require('../src/adminAuth');

const TEST_TCP_PORT = 5098;
const TEST_HTTP_PORT = 3098;

process.env.GT06_PORT = String(TEST_TCP_PORT);
process.env.AUTO_ENFORCE_TRACKING = 'false';

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

  // 2. Integration Test with TCP Server & Auto-Flush on Device Wakeup
  console.log('\n[Test 4] TCP Server Wakeup & Queue Auto-Flush Integration...');
  const tcpServer = createGt06Server();
  await new Promise((r) => setTimeout(r, 200));

  // Enqueue a command while device is disconnected
  const targetImei = '867232054858888';
  await clearQueue(targetImei);
  const enqueueRes = await enqueueCommand(
    targetImei,
    'S20',
    [1, 1],
    {},
    () => Promise.resolve({ success: true }),
    () => false
  );
  assert.strictEqual(enqueueRes.queued, true);

  // Now simulate tracker connecting and sending V0 login
  const receivedData = [];
  const clientSocket = new net.Socket();

  await new Promise((resolve) => {
    clientSocket.connect(TEST_TCP_PORT, '127.0.0.1', () => {
      // Send HQ login packet
      clientSocket.write(`*HQ,${targetImei},V0#\r\n`);
    });

    clientSocket.on('data', (chunk) => {
      const ascii = chunk.toString();
      receivedData.push(ascii);
      // Once we receive the S20 command from auto-flush, resolve
      if (ascii.includes('S20')) {
        resolve();
      }
    });

    // Timeout safety
    setTimeout(resolve, 2000);
  });

  const fullReceived = receivedData.join('');
  console.log('Received packets by tracker:', fullReceived);
  assert.ok(fullReceived.includes('V4,V0') || fullReceived.includes('V0'), 'Tracker should receive V0 login ACK');
  assert.ok(fullReceived.includes('S20'), 'Tracker should receive auto-flushed S20 command on wakeup');
  console.log('✔ Auto-flush on tracker wakeup verified successfully!');

  clientSocket.destroy();
  await closeGt06Server(tcpServer, 'test_done');

  // 3. HTTP API Endpoints Test
  console.log('\n[Test 5] HTTP Command Queue & History API Tests...');
  const app = express();
  app.use(express.json());
  app.use('/api/gps', gpsRoutes);

  const httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(TEST_HTTP_PORT, r));

  const adminToken = generateToken({ username: 'momohofficial@gmail.com', role: 'admin' });

  // Test POST /api/gps/command/:imei/cut_fuel
  const postRes = await fetch(`http://127.0.0.1:${TEST_HTTP_PORT}/api/gps/command/${targetImei}/cut_fuel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`,
    },
    body: JSON.stringify({}),
  });

  const postData = await postRes.json();
  assert.strictEqual(postRes.status, 200);
  assert.strictEqual(postData.success, true);
  assert.strictEqual(postData.queued, true);
  console.log('✔ API /command/:imei/cut_fuel enqueued command:', postData.result.commandId);

  // Test GET /api/gps/devices/:imei/queue
  const getQueueRes = await fetch(`http://127.0.0.1:${TEST_HTTP_PORT}/api/gps/devices/${targetImei}/queue`, {
    headers: { 'Authorization': `Bearer ${adminToken}` },
  });
  const queueData = await getQueueRes.json();
  assert.strictEqual(queueData.success, true);
  assert.ok(queueData.count >= 1);
  console.log('✔ API /devices/:imei/queue returned pending count:', queueData.count);

  // Test DELETE /api/gps/devices/:imei/queue
  const delQueueRes = await fetch(`http://127.0.0.1:${TEST_HTTP_PORT}/api/gps/devices/${targetImei}/queue`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${adminToken}` },
  });
  const delData = await delQueueRes.json();
  assert.strictEqual(delData.success, true);
  console.log('✔ API DELETE /devices/:imei/queue cleared queue successfully');

  await new Promise((r) => httpServer.close(r));

  console.log('\n=============================================');
  console.log('  ALL COMMAND QUEUE TESTS PASSED (100%)');
  console.log('=============================================\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
