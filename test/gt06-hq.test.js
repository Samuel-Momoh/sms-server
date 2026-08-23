'use strict';

const assert = require('assert');
const {
  nmeaToDecimal,
  parseHqMessage,
  formatV1Timestamp,
  buildHqAck,
  buildAck,
  crc16,
  _processBuffer,
  deviceRegistry,
} = require('../src/gt06Server');
const { logger } = require('../src/logger');

// Mock socket to capture logs and writes
function createMockSocket(remoteAddress = '127.0.0.1', remotePort = 12345, failWrite = false) {
  const written = [];
  return {
    remoteAddress,
    remotePort,
    written,
    setKeepAlive: () => {},
    setNoDelay: () => {},
    write: (data, cb) => {
      if (failWrite) {
        if (cb) cb(new Error('Simulated write failure'));
        return;
      }
      written.push(data);
      if (cb) cb(null);
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
  // TEST 0: formatV1Timestamp helper
  // ───────────────────────────────────────────────────────────────────────────
  console.log('Test 0: Testing formatV1Timestamp helper');
  const mockDate = new Date('2026-08-23T12:00:00Z');
  const formattedTs = formatV1Timestamp('210226', mockDate);
  assert.strictEqual(formattedTs, '20260823210226', `Expected 20260823210226, got ${formattedTs}`);
  console.log('✅ Test 0 Passed!\n');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST A: Parse GPS message (*HQ,...,V1,...) & verify H02/A3 V4 confirmation response
  // ───────────────────────────────────────────────────────────────────────────
  console.log('Test A: Parsing *HQ,867232054850970,V1,210226,A,0453.2956,N,00654.7924,E,0.00,0,');
  const msgA = '*HQ,867232054850970,V1,210226,A,0453.2956,N,00654.7924,E,0.00,0,';
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

  // Check HQ_ACK_SENT for V1: must be *HQ,<IMEI>,V4,V1,<YYYYMMDD210226>#\r\n
  const ackLogA = capturedLogs.find((l) => l.event === 'HQ_ACK_SENT' && l.data.responseAscii.includes('V4,V1'));
  assert(ackLogA, 'Expected HQ_ACK_SENT log event with V4,V1 confirmation');
  assert.strictEqual(ackLogA.data.imei, '867232054850970');
  assert(/^\*HQ,867232054850970,V4,V1,\d{8}210226#\r\n$/.test(ackLogA.data.responseAscii), `Response format invalid: ${ackLogA.data.responseAscii}`);
  assert.strictEqual(ackLogA.data.responseHex, Buffer.from(ackLogA.data.responseAscii).toString('hex'));
  assert.strictEqual(mockSockA.written.length, 1, 'Expected V4 confirmation ACK written to socket');
  console.log('✅ Test A Passed!\n');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST B: HQ Heartbeat (*HQ,867232054850970,HTBT#\r\n) & verify *HQ,<IMEI>,HTBT# response
  // ───────────────────────────────────────────────────────────────────────────
  console.log('Test B: Parsing *HQ,867232054850970,HTBT#\\r\\n');
  const msgB = '*HQ,867232054850970,HTBT#\r\n';
  const mockSockB = createMockSocket();
  const stateB = { protocol: null, buffer: Buffer.from(msgB) };
  _processBuffer(mockSockB, stateB);

  const logB = capturedLogs.find((l) => l.event === 'HQ_HEARTBEAT');
  assert(logB, 'Expected HQ_HEARTBEAT log event');
  assert.strictEqual(logB.data.imei, '867232054850970');

  // Check HQ_ACK_SENT for HTBT: must be *HQ,<IMEI>,HTBT#\r\n
  const ackLogB = capturedLogs.find((l) => l.event === 'HQ_ACK_SENT' && l.data.responseAscii.includes('HTBT'));
  assert(ackLogB, 'Expected HQ_ACK_SENT log event for HTBT');
  assert.strictEqual(ackLogB.data.imei, '867232054850970');
  assert.strictEqual(ackLogB.data.responseAscii, '*HQ,867232054850970,HTBT#\r\n');
  assert.strictEqual(ackLogB.data.responseHex, Buffer.from('*HQ,867232054850970,HTBT#\r\n').toString('hex'));
  assert.strictEqual(mockSockB.written.length, 1, 'Expected HTBT ACK written to socket');
  console.log('✅ Test B Passed!\n');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST C: Incoming V0 Login packet (*HQ,867232054850970,V0#\r\n)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('Test C: Parsing *HQ,867232054850970,V0#\\r\\n (V0 Login)');
  const msgC = '*HQ,867232054850970,V0#\r\n';
  const mockSockC = createMockSocket();
  const stateC = { protocol: null, buffer: Buffer.from(msgC) };
  _processBuffer(mockSockC, stateC);

  const logC = capturedLogs.find((l) => l.event === 'HQ_LOGIN');
  assert(logC, 'Expected HQ_LOGIN log event');
  assert.strictEqual(logC.data.imei, '867232054850970');

  const ackLogC = capturedLogs.find((l) => l.event === 'HQ_ACK_SENT' && l.data.responseAscii.includes('V0'));
  assert(ackLogC, 'Expected HQ_ACK_SENT log event for V0 login');
  assert.strictEqual(ackLogC.data.responseAscii, '*HQ,867232054850970,V0#\r\n');
  assert.strictEqual(ackLogC.data.responseHex, Buffer.from('*HQ,867232054850970,V0#\r\n').toString('hex'));
  assert.strictEqual(mockSockC.written.length, 1, 'Expected V0 ACK written to socket');
  console.log('✅ Test C Passed!\n');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST D: Fragmented TCP input
  // ───────────────────────────────────────────────────────────────────────────
  console.log('Test D: Fragmented TCP stream reassembly');
  const mockSockD = createMockSocket();
  const stateD = { protocol: null, buffer: Buffer.alloc(0) };

  const chunk1 = Buffer.from('*HQ,8672320548');
  const chunk2 = Buffer.from('50970,V1,210046,A,0453.2956,N,00654.7924,E,0.00,0,\n');

  stateD.buffer = Buffer.concat([stateD.buffer, chunk1]);
  _processBuffer(mockSockD, stateD);
  assert.strictEqual(stateD.protocol, 'HQ', 'Protocol should be detected as HQ');
  assert.strictEqual(stateD.buffer.length, chunk1.length, 'Incomplete buffer should remain buffered');

  stateD.buffer = Buffer.concat([stateD.buffer, chunk2]);
  _processBuffer(mockSockD, stateD);

  const gpsLogsD = capturedLogs.filter((l) => l.event === 'HQ_GPS_UPDATE');
  assert.strictEqual(gpsLogsD.length, 2, 'Expected GPS update after chunk 2');
  assert.strictEqual(stateD.buffer.length, 0, 'Buffer should be fully consumed');
  console.log('✅ Test D Passed!\n');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST E: Multiple HQ messages in one TCP chunk
  // ───────────────────────────────────────────────────────────────────────────
  console.log('Test E: Multiple HQ messages in one chunk');
  const mockSockE = createMockSocket();
  const stateE = { protocol: null, buffer: Buffer.alloc(0) };

  const multiChunk = Buffer.from(
    '*HQ,867232054850970,V1,210046,A,0453.2956,N,00654.7924,E,0.00,0,\n*HQ,867232054850970,HTBT#\r\n'
  );
  stateE.buffer = multiChunk;
  _processBuffer(mockSockE, stateE);

  const gpsLogsE = capturedLogs.filter((l) => l.event === 'HQ_GPS_UPDATE');
  const hbLogsE = capturedLogs.filter((l) => l.event === 'HQ_HEARTBEAT');
  assert(gpsLogsE.length >= 3, 'Expected GPS update log');
  assert(hbLogsE.length >= 2, 'Expected Heartbeat log');
  assert.strictEqual(mockSockE.written.length, 2, 'Expected 2 ACKs sent for 2 messages in single chunk');
  assert.strictEqual(stateE.buffer.length, 0, 'Buffer should be empty');
  console.log('✅ Test E Passed!\n');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST F: Socket write failure error checking
  // ───────────────────────────────────────────────────────────────────────────
  console.log('Test F: Socket write failure error logging');
  const mockSockF = createMockSocket('127.0.0.1', 9999, true /* failWrite */);
  const stateF = { protocol: 'HQ', buffer: Buffer.from('*HQ,867232054850970,HTBT#\r\n') };
  _processBuffer(mockSockF, stateF);

  const writeErrLog = capturedLogs.find((l) => l.event === 'HQ_WRITE_ERROR');
  assert(writeErrLog, 'Expected HQ_WRITE_ERROR log event');
  assert.strictEqual(writeErrLog.data.error, 'Simulated write failure');
  console.log('✅ Test F Passed!\n');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST G: Existing GT06 Login packet
  // ───────────────────────────────────────────────────────────────────────────
  console.log('Test G: GT06 Login packet');
  const mockSockG = createMockSocket();
  const stateG = { protocol: null, buffer: Buffer.alloc(0) };

  // GT06 Login frame:
  // 78 78 (start) 0d (len) 01 (protocol) 01 23 45 67 89 01 23 40 (imei) 00 01 (serial) <crc2> 0d 0a
  const imeiBytes = Buffer.from([0x01, 0x23, 0x45, 0x67, 0x89, 0x01, 0x23, 0x40]);
  const serialNo = Buffer.from([0x00, 0x01]);
  const payloadG = Buffer.concat([Buffer.from([0x0d, 0x01]), imeiBytes, serialNo]);
  const crcValG = crc16(payloadG);
  const crcBufG = Buffer.alloc(2);
  crcBufG.writeUInt16BE(crcValG, 0);
  const gt06LoginFrame = Buffer.concat([
    Buffer.from([0x78, 0x78]),
    payloadG,
    crcBufG,
    Buffer.from([0x0D, 0x0A]),
  ]);

  stateG.buffer = gt06LoginFrame;
  _processBuffer(mockSockG, stateG);

  assert.strictEqual(stateG.protocol, 'GT06');
  const loginLog = capturedLogs.find((l) => l.event === 'GT06_LOGIN');
  assert(loginLog, 'Expected GT06_LOGIN log event');
  assert.strictEqual(loginLog.data.imeiHex, '0123456789012340');
  assert.strictEqual(mockSockG.written.length, 1, 'Expected ACK to be written back to tracker');
  console.log('✅ Test G Passed!\n');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST H: Existing GT06 Heartbeat packet
  // ───────────────────────────────────────────────────────────────────────────
  console.log('Test H: GT06 Heartbeat packet');
  const mockSockH = createMockSocket();
  const stateH = { protocol: 'GT06', buffer: Buffer.alloc(0) };

  const hbPayload = Buffer.from([0x05, 0x13, 0x00, 0x02]); // len=5, proto=0x13, serial=0x0002
  const crcValH = crc16(hbPayload);
  const crcBufH = Buffer.alloc(2);
  crcBufH.writeUInt16BE(crcValH, 0);
  const gt06HeartbeatFrame = Buffer.concat([
    Buffer.from([0x78, 0x78]),
    hbPayload,
    crcBufH,
    Buffer.from([0x0D, 0x0A]),
  ]);

  stateH.buffer = gt06HeartbeatFrame;
  _processBuffer(mockSockH, stateH);

  assert.strictEqual(mockSockH.written.length, 1, 'Expected GT06 Heartbeat ACK to be written');
  console.log('✅ Test H Passed!\n');

  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
} finally {
  restoreLogs();
}
