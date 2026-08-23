'use strict';

const assert = require('assert');
const {
  nmeaToDecimal,
  parseHqMessage,
  buildHqAck,
  buildAck,
  crc16,
  _processBuffer,
  deviceRegistry,
} = require('../src/gt06Server');
const { logger } = require('../src/logger');

// Mock socket to capture logs and writes
function createMockSocket(remoteAddress = '127.0.0.1', remotePort = 12345) {
  const written = [];
  return {
    remoteAddress,
    remotePort,
    written,
    write: (data) => {
      written.push(data);
    },
  };
}

// Capture logger calls
const capturedLogs = [];
const origInfo = logger.info;
const origWarn = logger.warn;
const origError = logger.error;

function startCapturingLogs() {
  capturedLogs.length = 0;
  logger.info = (event, data) => {
    capturedLogs.push({ level: 'info', event, data });
  };
  logger.warn = (event, data) => {
    capturedLogs.push({ level: 'warn', event, data });
  };
  logger.error = (event, data) => {
    capturedLogs.push({ level: 'error', event, data });
  };
}

function restoreLogs() {
  logger.info = origInfo;
  logger.warn = origWarn;
  logger.error = origError;
}

console.log('Running GT06 & HQ Protocol Unit Tests...\n');

try {
  startCapturingLogs();

  // ───────────────────────────────────────────────────────────────────────────
  // TEST A: Parse GPS message (*HQ,...,V1,...)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('Test A: Parsing *HQ,867232054850970,V1,210046,A,0453.2956,N,00654.7924,E,0.00,0,');
  const msgA = '*HQ,867232054850970,V1,210046,A,0453.2956,N,00654.7924,E,0.00,0,';
  const parsedA = parseHqMessage(msgA);
  assert.strictEqual(parsedA.imei, '867232054850970');
  assert.strictEqual(parsedA.cmd, 'V1');

  const latA = nmeaToDecimal('0453.2956', 'N');
  const lonA = nmeaToDecimal('00654.7924', 'E');
  assert(Math.abs(latA - 4.88826) < 0.0001, `Lat expected ~4.88826, got ${latA}`);
  assert(Math.abs(lonA - 6.9132067) < 0.0001, `Lon expected ~6.9132067, got ${lonA}`);

  // Feed into mock socket via _processBuffer
  const mockSockA = createMockSocket();
  const stateA = { protocol: null, buffer: Buffer.from(msgA + '\n') };
  _processBuffer(mockSockA, stateA);

  const logA = capturedLogs.find((l) => l.event === 'HQ_GPS_UPDATE');
  assert(logA, 'Expected HQ_GPS_UPDATE log event');
  assert.strictEqual(logA.data.imei, '867232054850970');
  assert.strictEqual(logA.data.gpsStatus, 'A');
  assert.strictEqual(logA.data.speed, 0);
  assert.strictEqual(logA.data.latitude, 4.88826);
  assert.strictEqual(logA.data.longitude, 6.913207);
  console.log('✅ Test A Passed!\n');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST B: HQ Heartbeat (*HQ,867232054850970,HTBT#\r\n)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('Test B: Parsing *HQ,867232054850970,HTBT#\\r\\n');
  const msgB = '*HQ,867232054850970,HTBT#\r\n';
  const mockSockB = createMockSocket();
  const stateB = { protocol: null, buffer: Buffer.from(msgB) };
  _processBuffer(mockSockB, stateB);

  const logB = capturedLogs.find((l) => l.event === 'HQ_HEARTBEAT');
  assert(logB, 'Expected HQ_HEARTBEAT log event');
  assert.strictEqual(logB.data.imei, '867232054850970');
  console.log('✅ Test B Passed!\n');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST C: Fragmented TCP input
  // ───────────────────────────────────────────────────────────────────────────
  console.log('Test C: Fragmented TCP stream reassembly');
  const mockSockC = createMockSocket();
  const stateC = { protocol: null, buffer: Buffer.alloc(0) };

  const chunk1 = Buffer.from('*HQ,8672320548');
  const chunk2 = Buffer.from('50970,V1,210046,A,0453.2956,N,00654.7924,E,0.00,0,\n');

  stateC.buffer = Buffer.concat([stateC.buffer, chunk1]);
  _processBuffer(mockSockC, stateC);
  assert.strictEqual(stateC.protocol, 'HQ', 'Protocol should be detected as HQ');
  assert.strictEqual(stateC.buffer.length, chunk1.length, 'Incomplete buffer should remain buffered');

  stateC.buffer = Buffer.concat([stateC.buffer, chunk2]);
  _processBuffer(mockSockC, stateC);

  const gpsLogsC = capturedLogs.filter((l) => l.event === 'HQ_GPS_UPDATE');
  assert.strictEqual(gpsLogsC.length, 2, 'Expected GPS update after chunk 2');
  assert.strictEqual(stateC.buffer.length, 0, 'Buffer should be fully consumed');
  console.log('✅ Test C Passed!\n');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST D: Multiple HQ messages in one TCP chunk
  // ───────────────────────────────────────────────────────────────────────────
  console.log('Test D: Multiple HQ messages in one chunk');
  const mockSockD = createMockSocket();
  const stateD = { protocol: null, buffer: Buffer.alloc(0) };

  const multiChunk = Buffer.from(
    '*HQ,867232054850970,V1,210046,A,0453.2956,N,00654.7924,E,0.00,0,\n*HQ,867232054850970,HTBT#\r\n'
  );
  stateD.buffer = multiChunk;
  _processBuffer(mockSockD, stateD);

  const gpsLogsD = capturedLogs.filter((l) => l.event === 'HQ_GPS_UPDATE');
  const hbLogsD = capturedLogs.filter((l) => l.event === 'HQ_HEARTBEAT');
  assert(gpsLogsD.length >= 3, 'Expected GPS update log');
  assert(hbLogsD.length >= 2, 'Expected Heartbeat log');
  assert.strictEqual(stateD.buffer.length, 0, 'Buffer should be empty');
  console.log('✅ Test D Passed!\n');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST E: Existing GT06 Login packet
  // ───────────────────────────────────────────────────────────────────────────
  console.log('Test E: GT06 Login packet');
  const mockSockE = createMockSocket();
  const stateE = { protocol: null, buffer: Buffer.alloc(0) };

  // GT06 Login frame:
  // 78 78 (start) 0d (len) 01 (protocol) 01 23 45 67 89 01 23 40 (imei) 00 01 (serial) <crc2> 0d 0a
  const imeiBytes = Buffer.from([0x01, 0x23, 0x45, 0x67, 0x89, 0x01, 0x23, 0x40]);
  const serialNo = Buffer.from([0x00, 0x01]);
  const payloadE = Buffer.concat([Buffer.from([0x0d, 0x01]), imeiBytes, serialNo]);
  const crcValE = crc16(payloadE);
  const crcBufE = Buffer.alloc(2);
  crcBufE.writeUInt16BE(crcValE, 0);
  const gt06LoginFrame = Buffer.concat([
    Buffer.from([0x78, 0x78]),
    payloadE,
    crcBufE,
    Buffer.from([0x0D, 0x0A]),
  ]);

  stateE.buffer = gt06LoginFrame;
  _processBuffer(mockSockE, stateE);

  assert.strictEqual(stateE.protocol, 'GT06');
  const loginLog = capturedLogs.find((l) => l.event === 'GT06_LOGIN');
  assert(loginLog, 'Expected GT06_LOGIN log event');
  assert.strictEqual(loginLog.data.imeiHex, '0123456789012340');
  assert.strictEqual(mockSockE.written.length, 1, 'Expected ACK to be written back to tracker');
  console.log('✅ Test E Passed!\n');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST F: Existing GT06 Heartbeat packet
  // ───────────────────────────────────────────────────────────────────────────
  console.log('Test F: GT06 Heartbeat packet');
  const mockSockF = createMockSocket();
  const stateF = { protocol: 'GT06', buffer: Buffer.alloc(0) };

  const hbPayload = Buffer.from([0x05, 0x13, 0x00, 0x02]); // len=5, proto=0x13, serial=0x0002
  const crcValF = crc16(hbPayload);
  const crcBufF = Buffer.alloc(2);
  crcBufF.writeUInt16BE(crcValF, 0);
  const gt06HeartbeatFrame = Buffer.concat([
    Buffer.from([0x78, 0x78]),
    hbPayload,
    crcBufF,
    Buffer.from([0x0D, 0x0A]),
  ]);

  stateF.buffer = gt06HeartbeatFrame;
  _processBuffer(mockSockF, stateF);

  assert.strictEqual(mockSockF.written.length, 1, 'Expected GT06 Heartbeat ACK to be written');
  console.log('✅ Test F Passed!\n');

  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
} finally {
  restoreLogs();
}
