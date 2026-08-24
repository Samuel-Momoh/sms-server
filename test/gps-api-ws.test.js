'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const { io: Client } = require('socket.io-client');
const gpsRoutes = require('../src/gpsRoutes');
const { initWebSocketServer } = require('../src/wsServer');
const { gpsEventEmitter } = require('../src/gpsEvents');
const {
  deviceRegistry,
  deviceStates,
  registerDevice,
} = require('../src/gt06Server');

function createMockSocket(remoteAddress = '10.0.0.1', remotePort = 50220) {
  const written = [];
  return {
    remoteAddress,
    remotePort,
    written,
    destroyed: false,
    write: (data, cb) => {
      written.push(data);
      if (cb) cb(null);
    },
    destroy: function () { this.destroyed = true; },
  };
}

async function runApiAndWsTests() {
  console.log('Running GPS REST API & WebSocket Room Tests...\n');

  process.env.ADMIN_USER = 'testadmin';
  process.env.ADMIN_PWD  = 'testpwd123';

  // Setup test Express & HTTP & Socket.IO server
  const app = express();
  app.use(express.json());
  app.use('/api/gps', gpsRoutes);

  const server = http.createServer(app);
  const ioServer = initWebSocketServer(server);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const basicAuthHeader = `Basic ${Buffer.from('testadmin:testpwd123').toString('base64')}`;
  let authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': basicAuthHeader,
  };

  try {
    // ── Test 0: Unauthorized request rejection (401) ─────────────────────────
    const unauthRes = await fetch(`${baseUrl}/api/gps/devices`);
    assert.strictEqual(unauthRes.status, 401);
    const unauthData = await unauthRes.json();
    assert.strictEqual(unauthData.success, false);
    console.log('✅ Test 0 Passed: Requests without admin auth return 401 Unauthorized');

    // ── Test 0b: Admin login endpoint returning JWT ───────────────────────────
    const badLoginRes = await fetch(`${baseUrl}/api/gps/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testadmin', password: 'wrongpassword' }),
    });
    assert.strictEqual(badLoginRes.status, 401);

    const goodLoginRes = await fetch(`${baseUrl}/api/gps/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testadmin', password: 'testpwd123' }),
    });
    assert.strictEqual(goodLoginRes.status, 200);
    const loginData = await goodLoginRes.json();
    assert.strictEqual(loginData.success, true);
    assert(loginData.token);
    assert.strictEqual(loginData.auth?.type, 'Bearer');
    assert(loginData.auth?.token);
    console.log('✅ Test 0b Passed: POST /api/gps/auth/login issues JWT Bearer token');

    // Use JWT Bearer header for remaining tests
    authHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${loginData.token}`,
    };

    // ── Test 1: GET /api/gps/devices when empty ──────────────────────────────
    deviceRegistry.clear();
    deviceStates.clear();

    const res1 = await fetch(`${baseUrl}/api/gps/devices`, { headers: authHeaders });
    const data1 = await res1.json();
    assert.strictEqual(data1.success, true);
    assert.strictEqual(data1.count, 0);
    console.log('✅ Test 1 Passed: GET /api/gps/devices returns empty array for admin');

    // ── Test 2: Register device & test GET /api/gps/devices/:imei ─────────────
    const testImei = '867232054850970';
    const mockSock = createMockSocket('102.89.47.144', 40419);
    registerDevice(testImei, mockSock, 'HQ');

    const res2 = await fetch(`${baseUrl}/api/gps/devices/${testImei}`, { headers: authHeaders });
    const data2 = await res2.json();
    assert.strictEqual(data2.success, true);
    assert.strictEqual(data2.device.imei, testImei);
    assert.strictEqual(data2.device.connected, true);
    console.log('✅ Test 2 Passed: GET /api/gps/devices/:imei returns registered device');

    // ── Test 3: POST /api/gps/devices/:imei/working-mode (WKMD) ──────────────
    const res3 = await fetch(`${baseUrl}/api/gps/devices/${testImei}/working-mode`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ mode: 0 }),
    });
    const data3 = await res3.json();
    assert.strictEqual(data3.success, true);
    assert(mockSock.written.length > 0);
    assert(mockSock.written[0].includes('WKMD'));
    console.log('✅ Test 3 Passed: POST /api/gps/devices/:imei/working-mode sends WKMD');

    // ── Test 4: POST /api/gps/devices/:imei/interval (D1) ────────────────────
    const res4 = await fetch(`${baseUrl}/api/gps/devices/${testImei}/interval`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ intervalSeconds: 30 }),
    });
    const data4 = await res4.json();
    assert.strictEqual(data4.success, true);
    assert(mockSock.written.some((w) => w.includes('D1') && w.includes('30')));
    console.log('✅ Test 4 Passed: POST /api/gps/devices/:imei/interval sends D1');

    // ── Test 5: POST /api/gps/devices/:imei/cut-fuel and restore-fuel ────────
    const res5 = await fetch(`${baseUrl}/api/gps/devices/${testImei}/cut-fuel`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ dynamic: false }),
    });
    const data5 = await res5.json();
    assert.strictEqual(data5.success, true);
    assert(mockSock.written.some((w) => w.includes('S20')));

    const res5b = await fetch(`${baseUrl}/api/gps/devices/${testImei}/restore-fuel`, {
      method: 'POST',
      headers: authHeaders,
    });
    const data5b = await res5b.json();
    assert.strictEqual(data5b.success, true);
    console.log('✅ Test 5 Passed: Cut fuel and restore fuel endpoints send S20');

    // ── Test 6: POST /api/gps/devices/:imei/restart (R1) ─────────────────────
    const res6 = await fetch(`${baseUrl}/api/gps/devices/${testImei}/restart`, {
      method: 'POST',
      headers: authHeaders,
    });
    const data6 = await res6.json();
    assert.strictEqual(data6.success, true);
    assert(mockSock.written.some((w) => w.includes('R1')));
    console.log('✅ Test 6 Passed: Restart endpoint sends R1');

    // ── Test 6b: POST /api/gps/devices/:imei/password (S1) ───────────────────
    const res6b = await fetch(`${baseUrl}/api/gps/devices/${testImei}/password`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ oldPassword: '123456', newPassword: '654321' }),
    });
    const data6b = await res6b.json();
    assert.strictEqual(data6b.success, true);
    assert(mockSock.written.some((w) => w.includes('S1') && w.includes('654321')));
    console.log('✅ Test 6b Passed: Password endpoint sends S1');

    // ── Test 6c: POST /api/gps/devices/:imei/admin-numbers (S3) ──────────────
    const res6c = await fetch(`${baseUrl}/api/gps/devices/${testImei}/admin-numbers`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ numbers: ['08012345678', '08087654321'] }),
    });
    const data6c = await res6c.json();
    assert.strictEqual(data6c.success, true);
    assert(mockSock.written.some((w) => w.includes('S3') && w.includes('08012345678')));
    console.log('✅ Test 6c Passed: Admin numbers endpoint sends S3');

    // ── Test 6d: POST /api/gps/devices/:imei/alarm-types (S19) ───────────────
    const res6d = await fetch(`${baseUrl}/api/gps/devices/${testImei}/alarm-types`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ alarmType: 1, enable: true }),
    });
    const data6d = await res6d.json();
    assert.strictEqual(data6d.success, true);
    assert(mockSock.written.some((w) => w.includes('S19') && w.includes('1,1')));
    console.log('✅ Test 6d Passed: Alarm types endpoint sends S19');

    // ── Test 6e: POST /api/gps/devices/:imei/server-address (S23) ────────────
    const res6e = await fetch(`${baseUrl}/api/gps/devices/${testImei}/server-address`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ ip: '140.238.88.183', port: 5022 }),
    });
    const data6e = await res6e.json();
    assert.strictEqual(data6e.success, true);
    assert(mockSock.written.some((w) => w.includes('S23') && w.includes('140,238,88,183,5022')));
    console.log('✅ Test 6e Passed: Server address endpoint sends S23');

    // ── Test 6f: POST /api/gps/devices/:imei/apn (S24) ───────────────────────
    const res6f = await fetch(`${baseUrl}/api/gps/devices/${testImei}/apn`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ apn: 'web.gprs.mtnnigeria.net', apnUser: 'web', apnPassword: 'web' }),
    });
    const data6f = await res6f.json();
    assert.strictEqual(data6f.success, true);
    assert(mockSock.written.some((w) => w.includes('S24') && w.includes('web.gprs.mtnnigeria.net')));
    console.log('✅ Test 6f Passed: APN endpoint sends S24');

    // ── Test 6g: POST /api/gps/devices/:imei/factory-reset (S25) ─────────────
    const res6g = await fetch(`${baseUrl}/api/gps/devices/${testImei}/factory-reset`, {
      method: 'POST',
      headers: authHeaders,
    });
    const data6g = await res6g.json();
    assert.strictEqual(data6g.success, true);
    assert(mockSock.written.some((w) => w.includes('S25')));
    console.log('✅ Test 6g Passed: Factory reset endpoint sends S25');

    // ── Test 6h: POST /api/gps/devices/:imei/check-lbs (S80) ──────────────────
    const res6h = await fetch(`${baseUrl}/api/gps/devices/${testImei}/check-lbs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ baseCount: 3 }),
    });
    const data6h = await res6h.json();
    assert.strictEqual(data6h.success, true);
    assert(mockSock.written.some((w) => w.includes('S80') && w.includes('3')));
    console.log('✅ Test 6h Passed: Check LBS endpoint sends S80');

    // ── Test 6i: POST /api/gps/devices/:imei/fast-locate (D2) ────────────────
    const res6i = await fetch(`${baseUrl}/api/gps/devices/${testImei}/fast-locate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ openGpsSeconds: 180 }),
    });
    const data6i = await res6i.json();
    assert.strictEqual(data6i.success, true);
    assert(mockSock.written.some((w) => w.includes('D2') && w.includes('180')));
    console.log('✅ Test 6i Passed: Fast locate endpoint sends D2');

    // ── Test 7: WebSocket Rooms & Selective Event Broadcasting ───────────────
    const clientA = Client(baseUrl);
    const clientB = Client(baseUrl);
    const clientC = Client(baseUrl);

    const clientAEvents = [];
    const clientBEvents = [];
    const clientCEvents = [];

    await new Promise((resolve) => clientA.on('connect', resolve));
    await new Promise((resolve) => clientB.on('connect', resolve));
    await new Promise((resolve) => clientC.on('connect', resolve));

    clientA.on('gps:update', (payload) => clientAEvents.push(payload));
    clientB.on('gps:update', (payload) => clientBEvents.push(payload));
    clientC.on('gps:update', (payload) => clientCEvents.push(payload));

    const joinAPromise = new Promise((resolve) => clientA.on('joined', resolve));
    const joinBPromise = new Promise((resolve) => clientB.on('joined', resolve));
    const joinCPromise = new Promise((resolve) => clientC.on('joined', resolve));

    clientA.emit('join', { imei: testImei });
    clientB.emit('join', { imei: '999999999999999' });
    clientC.emit('join_all');

    await Promise.all([joinAPromise, joinBPromise, joinCPromise]);

    // Emit GPS update for testImei
    const samplePayload = {
      imei: testImei,
      protocol: 'HQ',
      latitude: 4.888267,
      longitude: 6.913273,
      speed_kmh: 0,
      timestamp: '2026-08-24 13:31:04 UTC',
    };
    gpsEventEmitter.emit('gps:update', samplePayload);

    // Wait 100ms for websocket delivery
    await new Promise((r) => setTimeout(r, 100));

    // Client A (subscribed to testImei) MUST receive the event
    assert.strictEqual(clientAEvents.length, 1);
    assert.strictEqual(clientAEvents[0].imei, testImei);

    // Client B (subscribed to different IMEI) MUST NOT receive the event
    assert.strictEqual(clientBEvents.length, 0);

    // Client C (Admin subscribed to all) MUST receive the event
    assert.strictEqual(clientCEvents.length, 1);
    assert.strictEqual(clientCEvents[0].imei, testImei);

    clientA.disconnect();
    clientB.disconnect();
    clientC.disconnect();
    console.log('✅ Test 7 Passed: WebSocket selective room routing per IMEI and admin room');

    console.log('\n🎉 ALL API & WEBSOCKET TESTS PASSED SUCCESSFULLY!');
  } finally {
    deviceRegistry.clear();
    deviceStates.clear();
    ioServer.close();
    await new Promise((r) => server.close(r));
  }
}

runApiAndWsTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('API & WebSocket tests failed:', err);
    process.exit(1);
  });
