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
const { findUserByEmailOrUsername } = require('../src/db/mysql');

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

    // ── Test 0c: User Registration with Email & Password ────────────────────
    const regRes = await fetch(`${baseUrl}/api/gps/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'driver_john@example.com',
        password: 'securePassword123',
        name: 'John Doe',
        phone: '+2348011223344',
      }),
    });
    const regData = await regRes.json();
    assert.strictEqual(regRes.status, 201);
    assert.strictEqual(regData.success, true);
    assert.strictEqual(regData.user.email, 'driver_john@example.com');
    assert.strictEqual(regData.user.role, 'user');
    assert.ok(regData.token);
    console.log('✅ Test 0c Passed: POST /api/gps/auth/register registers new user with email & password and returns JWT token');

    // ── Test 0d: Login with registered email & password ──────────────────────
    const userLoginRes = await fetch(`${baseUrl}/api/gps/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'driver_john@example.com',
        password: 'securePassword123',
      }),
    });
    const userLoginData = await userLoginRes.json();
    assert.strictEqual(userLoginRes.status, 200);
    assert.strictEqual(userLoginData.success, true);
    assert.strictEqual(userLoginData.user.role, 'user');
    console.log('✅ Test 0d Passed: POST /api/gps/auth/login authenticates user with email & password');

    // ── Test 0e: Profile check (GET /api/gps/auth/me) ─────────────────────────
    const meRes = await fetch(`${baseUrl}/api/gps/auth/me`, {
      headers: { 'Authorization': `Bearer ${userLoginData.token}` },
    });
    const meData = await meRes.json();
    assert.strictEqual(meData.success, true);
    assert.strictEqual(meData.user.email, 'driver_john@example.com');
    console.log('✅ Test 0e Passed: GET /api/gps/auth/me returns current authenticated user');

    // ── Test 0f: Device Registration by User (with optional SVG icon) ────────
    const sampleSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2L2 22h20L12 2z"/></svg>';
    const regDevRes = await fetch(`${baseUrl}/api/gps/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userLoginData.token}`,
      },
      body: JSON.stringify({
        imei: '867232054859991',
        name: 'Toyota RAV4 - John Doe',
        plateNumber: 'ABC-123XY',
        simNumber: '+2348099887766',
        model: 'Cantrack G02',
        icon: sampleSvg,
      }),
    });
    const regDevData = await regDevRes.json();
    assert.strictEqual(regDevRes.status, 201);
    assert.strictEqual(regDevData.success, true);
    assert.strictEqual(regDevData.device.name, 'Toyota RAV4 - John Doe');
    assert.strictEqual(regDevData.device.icon, sampleSvg);
    console.log('✅ Test 0f Passed: POST /api/gps/devices allows registered user to register device with optional SVG icon');

    // ── Test 0f2: PUT /api/gps/devices/:imei (Update Device & Icon) ───────────
    const updatedSvg = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';
    const updateDevRes = await fetch(`${baseUrl}/api/gps/devices/867232054859991`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userLoginData.token}`,
      },
      body: JSON.stringify({
        name: 'Toyota RAV4 2024 Hybrid',
        icon: updatedSvg,
      }),
    });
    const updateDevData = await updateDevRes.json();
    assert.strictEqual(updateDevRes.status, 200);
    assert.strictEqual(updateDevData.success, true);
    assert.strictEqual(updateDevData.device.name, 'Toyota RAV4 2024 Hybrid');
    assert.strictEqual(updateDevData.device.icon, updatedSvg);
    console.log('✅ Test 0f2 Passed: PUT /api/gps/devices/:imei successfully updates device metadata and SVG icon');

    // ── Test 0g: User sends command to OWN device ─────────────────────────────
    const userOwnCmdRes = await fetch(`${baseUrl}/api/gps/command/867232054859991/cut_fuel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userLoginData.token}`,
      },
    });
    const userOwnCmdData = await userOwnCmdRes.json();
    assert.strictEqual(userOwnCmdData.success, true);
    console.log('✅ Test 0g Passed: User CAN send commands to device registered to them');

    // ── Test 0h: User trying to send command to UNAUTHORIZED device (403) ─────
    const userForbiddenRes = await fetch(`${baseUrl}/api/gps/command/867232054850970/cut_fuel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userLoginData.token}`,
      },
    });
    const userForbiddenData = await userForbiddenRes.json();
    assert.strictEqual(userForbiddenRes.status, 403);
    assert.strictEqual(userForbiddenData.success, false);
    console.log('✅ Test 0h Passed: User CANNOT send commands to other devices (403 Forbidden)');

    // ── Test 0i: User trying to access Admin-Only Logs (403) ──────────────────
    const userLogsRes = await fetch(`${baseUrl}/api/gps/logs`, {
      headers: { 'Authorization': `Bearer ${userLoginData.token}` },
    });
    assert.strictEqual(userLogsRes.status, 403);
    console.log('✅ Test 0i Passed: User CANNOT access admin server logs (403 Forbidden)');

    // ── Test 0j: Admin CAN send command to ANY device ─────────────────────────
    const adminCmdRes = await fetch(`${baseUrl}/api/gps/command/867232054859991/restore_fuel`, {
      method: 'POST',
      headers: authHeaders,
    });
    const adminCmdData = await adminCmdRes.json();
    assert.strictEqual(adminCmdData.success, true);
    console.log('✅ Test 0j Passed: Admin CAN send commands to ANY device IMEI');

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
    // ── Test 6j: POST /api/gps/simulate (Car Ignition ON & Driving Simulation)
    const simRes = await fetch(`${baseUrl}/api/gps/simulate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        imei: testImei,
        accOn: true,
        speed: 45.0,
        latitude: 4.888188,
        longitude: 6.913182,
        direction: 170,
        batteryLevel: 100,
        steps: 3,
      }),
    });
    const simData = await simRes.json();
    assert.strictEqual(simRes.status, 200);
    assert.strictEqual(simData.success, true);
    assert.strictEqual(simData.accOn, true);
    assert.strictEqual(simData.pointsCount, 3);
    assert.strictEqual(simData.latestTelemetry.accOn, true);
    assert.strictEqual(simData.latestTelemetry.imei, testImei);
    console.log('✅ Test 6j Passed: POST /api/gps/simulate successfully simulates car driving & ignition ON');

    // ── Test 7: Role-Based WebSocket Security & Selective Event Broadcasting ──
    const adminWsClient = Client(baseUrl, {
      auth: { token: loginData.token },
    });
    const userWsClient = Client(baseUrl, {
      auth: { token: userLoginData.token },
    });

    const adminEvents = [];
    const userEvents = [];

    await new Promise((resolve) => adminWsClient.on('connect', resolve));
    await new Promise((resolve) => userWsClient.on('connect', resolve));

    adminWsClient.on('gps:update', (payload) => adminEvents.push(payload));
    userWsClient.on('gps:update', (payload) => userEvents.push(payload));

    // Admin joins 'all'
    const adminJoinAllPromise = new Promise((resolve) => adminWsClient.on('joined', resolve));
    adminWsClient.emit('join_all');
    await adminJoinAllPromise;

    // User attempts to join 'all' -> should get error (Forbidden)
    const userJoinAllErrPromise = new Promise((resolve) => userWsClient.on('error', resolve));
    userWsClient.emit('join_all');
    const joinAllErr = await userJoinAllErrPromise;
    assert.strictEqual(joinAllErr.success, false);
    console.log('✅ Test 7a Passed: Non-admin socket cannot join "all" room');

    // User joins OWN registered device (867232054859991)
    const userJoinOwnPromise = new Promise((resolve) => userWsClient.on('joined', resolve));
    userWsClient.emit('join', { imei: '867232054859991' });
    await userJoinOwnPromise;
    console.log('✅ Test 7b Passed: User socket successfully subscribed to own device');

    // User attempts to join UNAUTHORIZED device (testImei: 867232054850970)
    const userJoinOtherErrPromise = new Promise((resolve) => userWsClient.on('error', resolve));
    userWsClient.emit('join', { imei: testImei });
    const joinOtherErr = await userJoinOtherErrPromise;
    assert.strictEqual(joinOtherErr.success, false);
    console.log('✅ Test 7c Passed: User socket cannot subscribe to unauthorized device');

    // Emit GPS update for testImei (Admin's / Unowned by User)
    gpsEventEmitter.emit('gps:update', {
      imei: testImei,
      latitude: 4.888267,
      longitude: 6.913273,
      speed_kmh: 0,
      timestamp: '2026-08-24 13:31:04 UTC',
    });

    // Emit GPS update for user's device (867232054859991)
    gpsEventEmitter.emit('gps:update', {
      imei: '867232054859991',
      latitude: 6.524379,
      longitude: 3.379206,
      speed_kmh: 45,
      timestamp: '2026-08-24 13:35:00 UTC',
    });

    // Wait 100ms for delivery
    await new Promise((r) => setTimeout(r, 100));

    // Admin received updates for BOTH devices (because admin is in 'all' room)
    assert.strictEqual(adminEvents.length, 2);

    // Regular user received update ONLY for their own device (867232054859991)
    assert.strictEqual(userEvents.length, 1);
    assert.strictEqual(userEvents[0].imei, '867232054859991');

    adminWsClient.disconnect();
    userWsClient.disconnect();
    console.log('✅ Test 7d Passed: Role-based event broadcasting and telemetry isolation verified');

    // ── Test 8: Admin Delete Device & Cascading Record Purge ──────────────────
    const delDevImei = '867232054859991';
    let deviceDeletedEventFired = false;
    const testAdminWs = Client(baseUrl, { auth: { token: loginData.token } });
    await new Promise((resolve) => testAdminWs.on('connect', resolve));
    const joinAllPromise = new Promise((resolve) => testAdminWs.on('joined', resolve));
    testAdminWs.emit('join_all');
    await joinAllPromise;

    testAdminWs.on('gps:device_deleted', (payload) => {
      if (payload.imei === delDevImei) deviceDeletedEventFired = true;
    });

    const delRes = await fetch(`${baseUrl}/api/gps/devices/${delDevImei}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    const delData = await delRes.json();
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual(delData.success, true);
    assert.strictEqual(delData.imei, delDevImei);

    // Wait 50ms for WS event
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(deviceDeletedEventFired, true);

    // Verify device is removed from GET /devices
    const checkRes = await fetch(`${baseUrl}/api/gps/devices/${delDevImei}`, {
      headers: authHeaders,
    });
    assert.strictEqual(checkRes.status, 404);

    testAdminWs.disconnect();
    console.log('✅ Test 8 Passed: Admin DELETE /api/gps/devices/:imei purges all device records and emits real-time event');

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
