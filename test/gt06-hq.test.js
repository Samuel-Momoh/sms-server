'use strict';

const assert = require('assert');
const {
  nmeaToDecimal,
  parseHqMessage,
  parseEquStatus,
  formatV1Timestamp,
  buildHqAck,
  buildAck,
  crc16,
  _processBuffer,
  deviceRegistry,
  deviceStates,
  registerDevice,
  closeGt06Server,
  buildCantrackCommand,
  buildSecumoreCommand,
  sanitizeCommandString,
  sendDeviceCommand,
  sendRawDeviceCommand,
  getConnectedDevices,
  getDeviceState,
  enforceContinuousTracking,
} = require('../src/gt06Server');
const { gpsEventEmitter } = require('../src/gpsEvents');
const { logger } = require('../src/logger');

// Mock socket to capture logs and writes
function createMockSocket(remoteAddress = '127.0.0.1', remotePort = 12345, failWrite = false) {
  const written = [];
  let isDestroyed = false;
  const eventHandlers = {};

  const socket = {
    remoteAddress,
    remotePort,
    written,
    get isDestroyed() { return isDestroyed; },
    setTimeout: () => { },
    setKeepAlive: () => { },
    setNoDelay: () => { },
    on: (evt, handler) => {
      if (!eventHandlers[evt]) eventHandlers[evt] = [];
      eventHandlers[evt].push(handler);
      return socket;
    },
    emit: (evt, ...args) => {
      if (eventHandlers[evt]) {
        for (const handler of eventHandlers[evt]) {
          handler(...args);
        }
      }
    },
    write: (data, cb) => {
      if (failWrite) {
        if (cb) cb(new Error('Simulated write failure'));
        return;
      }
      written.push(data);
      if (cb) cb(null);
    },
    destroy: () => {
      isDestroyed = true;
      if (socket._trackerState) {
        socket._trackerState.isDestroyedLocally = true;
      }
    },
  };
  return socket;
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

async function runTests() {
  startCapturingLogs();
  try {

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

    const mockSockA = createMockSocket();
    const stateA = { protocol: null, buffer: Buffer.from(msgA + '\n') };
    mockSockA._trackerState = stateA;
    _processBuffer(mockSockA, stateA);

    const logA = capturedLogs.find((l) => l.event === 'HQ_GPS_UPDATE');
    assert(logA, 'Expected HQ_GPS_UPDATE log event');
    assert.strictEqual(logA.data.imei, '867232054850970');
    assert.strictEqual(logA.data.gpsStatus, 'A');
    assert.strictEqual(logA.data.speed, 0);
    assert.strictEqual(logA.data.latitude, 4.88826);
    assert.strictEqual(logA.data.longitude, 6.913207);

    // Check HQ_ACK_SENT for V1: must be *HQ,<IMEI>,V4,V1,<YYYYMMDD210226>#
    const ackLogA = capturedLogs.find((l) => l.event === 'HQ_ACK_SENT' && l.data.responseAscii.includes('V4,V1'));
    assert(ackLogA, 'Expected HQ_ACK_SENT log event with V4,V1 confirmation');
    assert.strictEqual(ackLogA.data.imei, '867232054850970');
    assert(/^\*HQ,867232054850970,V4,V1,\d{8}210226#$/.test(ackLogA.data.responseAscii), `Response format invalid: ${ackLogA.data.responseAscii}`);
    assert.strictEqual(ackLogA.data.responseHex, Buffer.from(ackLogA.data.responseAscii).toString('hex'));
    assert.strictEqual(mockSockA.written.length, 1, 'Expected V4 confirmation ACK written to socket');
    console.log('✅ Test A Passed!\n');

    // ───────────────────────────────────────────────────────────────────────────
    // TEST B: HQ Heartbeat (*HQ,867232054850970,HTBT#) & verify *HQ,<IMEI>,HTBT# response
    // ───────────────────────────────────────────────────────────────────────────
    console.log('Test B: Parsing *HQ,867232054850970,HTBT#');
    const msgB = '*HQ,867232054850970,HTBT#';
    const mockSockB = createMockSocket();
    const stateB = { protocol: null, buffer: Buffer.from(msgB) };
    mockSockB._trackerState = stateB;
    _processBuffer(mockSockB, stateB);

    const logB = capturedLogs.find((l) => l.event === 'HQ_HEARTBEAT');
    assert(logB, 'Expected HQ_HEARTBEAT log event');
    assert.strictEqual(logB.data.imei, '867232054850970');

    const ackLogB = capturedLogs.find((l) => l.event === 'HQ_ACK_SENT' && l.data.responseAscii.includes('HTBT'));
    assert(ackLogB, 'Expected HQ_ACK_SENT log event for HTBT');
    assert.strictEqual(ackLogB.data.imei, '867232054850970');
    assert.strictEqual(ackLogB.data.responseAscii, '*HQ,867232054850970,HTBT#');
    assert.strictEqual(ackLogB.data.responseHex, Buffer.from('*HQ,867232054850970,HTBT#').toString('hex'));
    assert.strictEqual(mockSockB.written.length, 1, 'Expected HTBT ACK written to socket');
    console.log('✅ Test B Passed!\n');

    // ───────────────────────────────────────────────────────────────────────────
    // TEST C: Incoming V0 Login packet (*HQ,867232054850970,V0#\r\n)
    // ───────────────────────────────────────────────────────────────────────────
    console.log('Test C: Parsing *HQ,867232054850970,V0#\\r\\n (V0 Login)');
    const msgC = '*HQ,867232054850970,V0#\r\n';
    const mockSockC = createMockSocket();
    const stateC = { protocol: null, buffer: Buffer.from(msgC) };
    mockSockC._trackerState = stateC;
    _processBuffer(mockSockC, stateC);

    const logC = capturedLogs.find((l) => l.event === 'HQ_LOGIN');
    assert(logC, 'Expected HQ_LOGIN log event');
    assert.strictEqual(logC.data.imei, '867232054850970');

    const ackLogC = capturedLogs.find((l) => l.event === 'HQ_ACK_SENT' && l.data.responseAscii.includes('V0'));
    assert(ackLogC, 'Expected HQ_ACK_SENT log event for V0 login');
    assert.strictEqual(ackLogC.data.responseAscii, '*HQ,867232054850970,V0#');
    assert.strictEqual(mockSockC.written[0], '*HQ,867232054850970,V0#', 'Expected clean V0 login ACK');
    console.log('✅ Test C Passed!\n');

    // ───────────────────────────────────────────────────────────────────────────
    // TEST D: Fragmented TCP input
    // ───────────────────────────────────────────────────────────────────────────
    console.log('Test D: Fragmented TCP stream reassembly');
    const mockSockD = createMockSocket();
    const stateD = { protocol: null, buffer: Buffer.alloc(0) };
    mockSockD._trackerState = stateD;

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
    mockSockE._trackerState = stateE;

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
    mockSockF._trackerState = stateF;
    _processBuffer(mockSockF, stateF);

    const writeErrLog = capturedLogs.find((l) => l.event === 'HQ_WRITE_ERROR');
    assert(writeErrLog, 'Expected HQ_WRITE_ERROR log event');
    assert.strictEqual(writeErrLog.data.error, 'Simulated write failure');
    console.log('✅ Test F Passed!\n');

    // ───────────────────────────────────────────────────────────────────────────
    // TEST G: Continuous tracking simulation over multiple cycles (minutes)
    // ───────────────────────────────────────────────────────────────────────────
    console.log('Test G: Continuous tracking simulation (V1 packets every 30s for 6 cycles = 3 minutes)');
    const mockSockG = createMockSocket('192.168.1.100', 50220);
    const stateG = {
      protocol: null,
      buffer: Buffer.alloc(0),
      imei: null,
      connectedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      closeReason: 'remote_tracker_close',
    };
    mockSockG._trackerState = stateG;

    // Step 1: V0 Login
    stateG.buffer = Buffer.from('*HQ,867232054850970,V0#\r\n');
    _processBuffer(mockSockG, stateG);
    assert.strictEqual(stateG.protocol, 'HQ');
    assert.strictEqual(deviceRegistry.get('867232054850970'), mockSockG);
    assert(mockSockG.written.length >= 1);
    assert.strictEqual(mockSockG.written[0], '*HQ,867232054850970,V0#');

    // Step 2: 6 consecutive V1 updates (representing continuous tracking)
    const timestamps = ['094229', '094259', '094329', '094359', '094429', '094459'];
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const gpsMsg = `*HQ,867232054850970,V1,${ts},A,0453.2956,N,00654.7924,E,0.00,0,\n`;
      stateG.buffer = Buffer.from(gpsMsg);
      _processBuffer(mockSockG, stateG);

      // Verify ACK sent for this packet
      const expectedAckPrefix = `*HQ,867232054850970,V4,V1,`;
      const lastWritten = mockSockG.written[mockSockG.written.length - 1];
      assert(lastWritten.startsWith(expectedAckPrefix), `Expected V4 ACK for cycle ${i}, got: ${lastWritten}`);
      assert(lastWritten.includes(ts), `Expected ACK to contain time ${ts}`);
    }

    assert(mockSockG.written.length >= 7, 'Expected login ACK/commands + 6 GPS ACKs');
    assert.strictEqual(mockSockG.isDestroyed, false, 'Socket should remain open and connected');
    console.log('✅ Test G Passed!\n');

    // ───────────────────────────────────────────────────────────────────────────
    // TEST H: Reconnecting with the same IMEI (duplicate connection handling)
    // ───────────────────────────────────────────────────────────────────────────
    console.log('Test H: Reconnecting with same IMEI (old socket cleanup & registry safety)');
    const mockSockH1 = createMockSocket('192.168.1.101', 50221);
    const stateH1 = {
      protocol: null,
      buffer: Buffer.alloc(0),
      imei: null,
      connectedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      closeReason: 'remote_tracker_close',
    };
    mockSockH1._trackerState = stateH1;

    // Socket 1 connects and registers IMEI
    stateH1.buffer = Buffer.from('*HQ,867232054850970,V0#\r\n');
    _processBuffer(mockSockH1, stateH1);
    assert.strictEqual(deviceRegistry.get('867232054850970'), mockSockH1);

    // Now Socket 2 connects with the same IMEI
    const mockSockH2 = createMockSocket('192.168.1.102', 50222);
    const stateH2 = {
      protocol: null,
      buffer: Buffer.alloc(0),
      imei: null,
      connectedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      closeReason: 'remote_tracker_close',
    };
    mockSockH2._trackerState = stateH2;

    stateH2.buffer = Buffer.from('*HQ,867232054850970,V1,094500,A,0453.2956,N,00654.7924,E,0.00,0,\n');
    _processBuffer(mockSockH2, stateH2);

    // Verify Socket 1 was destroyed and marked as replaced
    assert.strictEqual(mockSockH1.isDestroyed, true, 'Old socket should be destroyed on reconnection');
    assert.strictEqual(stateH1.closeReason, 'replaced_by_new_connection');
    assert.strictEqual(stateH1.isDestroyedLocally, true);

    // Verify deviceRegistry now points to Socket 2
    assert.strictEqual(deviceRegistry.get('867232054850970'), mockSockH2, 'Registry must point to Socket 2');

    // Verify DEVICE_RECONNECTED log was emitted
    const reconnectLog = capturedLogs.find((l) => l.event === 'DEVICE_RECONNECTED' && l.data.imei === '867232054850970');
    assert(reconnectLog, 'Expected DEVICE_RECONNECTED log event');

    // Now simulate Socket 1 close event — verify it does NOT unregister Socket 2!
    if (stateH1.imei && deviceRegistry.get(stateH1.imei) === mockSockH1) {
      deviceRegistry.delete(stateH1.imei);
    }
    assert.strictEqual(deviceRegistry.get('867232054850970'), mockSockH2, 'Old socket close must not delete new socket from registry');

    // Simulate Socket 2 close event — verify it cleans up registry
    if (stateH2.imei && deviceRegistry.get(stateH2.imei) === mockSockH2) {
      deviceRegistry.delete(stateH2.imei);
    }
    assert.strictEqual(deviceRegistry.get('867232054850970'), undefined, 'Active socket close must remove itself from registry');
    console.log('✅ Test H Passed!\n');

    // ───────────────────────────────────────────────────────────────────────────
    // TEST I: GT06 Protocol Packets (Login, Location, Heartbeat, Resync)
    // ───────────────────────────────────────────────────────────────────────────
    console.log('Test I: GT06 Protocol frames (0x01 login, 0x12/0x22 GPS, 0x13 heartbeat, resync)');
    const mockSockI = createMockSocket('10.0.0.1', 60001);
    const stateI = { protocol: null, buffer: Buffer.alloc(0) };
    mockSockI._trackerState = stateI;

    // GT06 Login frame: 78 78 0d 01 ...
    const imeiBytesI = Buffer.from([0x01, 0x23, 0x45, 0x67, 0x89, 0x01, 0x23, 0x40]);
    const serialNoI = Buffer.from([0x00, 0x01]);
    const payloadI = Buffer.concat([Buffer.from([0x0d, 0x01]), imeiBytesI, serialNoI]);
    const crcValI = crc16(payloadI);
    const crcBufI = Buffer.alloc(2);
    crcBufI.writeUInt16BE(crcValI, 0);
    const gt06LoginFrame = Buffer.concat([
      Buffer.from([0x78, 0x78]),
      payloadI,
      crcBufI,
      Buffer.from([0x0D, 0x0A]),
    ]);

    stateI.buffer = gt06LoginFrame;
    _processBuffer(mockSockI, stateI);

    assert.strictEqual(stateI.protocol, 'GT06');
    const loginLogI = capturedLogs.find((l) => l.event === 'GT06_LOGIN');
    assert(loginLogI, 'Expected GT06_LOGIN log event');
    assert.strictEqual(loginLogI.data.imeiHex, '0123456789012340');
    assert.strictEqual(deviceRegistry.get('0123456789012340'), mockSockI);
    assert.strictEqual(mockSockI.written.length, 1, 'Expected GT06 Login ACK written to socket');

    // GT06 Heartbeat frame: 78 78 05 13 ...
    const hbPayloadI = Buffer.from([0x05, 0x13, 0x00, 0x02]);
    const crcValHb = crc16(hbPayloadI);
    const crcBufHb = Buffer.alloc(2);
    crcBufHb.writeUInt16BE(crcValHb, 0);
    const gt06HbFrame = Buffer.concat([
      Buffer.from([0x78, 0x78]),
      hbPayloadI,
      crcBufHb,
      Buffer.from([0x0D, 0x0A]),
    ]);

    stateI.buffer = gt06HbFrame;
    _processBuffer(mockSockI, stateI);
    assert.strictEqual(mockSockI.written.length, 2, 'Expected GT06 Heartbeat ACK written');

    // Resync on noise before GT06 frame
    const noisyBuffer = Buffer.concat([
      Buffer.from([0xAA, 0xBB, 0xCC]),
      gt06HbFrame,
    ]);
    stateI.buffer = noisyBuffer;
    _processBuffer(mockSockI, stateI);
    assert.strictEqual(mockSockI.written.length, 3, 'Expected resync and ACK for heartbeat after noise');

    deviceRegistry.delete('0123456789012340');
    console.log('✅ Test I Passed!\n');

    // ───────────────────────────────────────────────────────────────────────────
    // TEST K: Cantrack equ_status parsing (ACC, alarms, power status)
    // ───────────────────────────────────────────────────────────────────────────
    console.log('Test K: Cantrack equ_status parsing (ACC, alarms, power status)');
    // Example 1: Operating state with ACC ON (Byte 3 bit 2 = 1 -> 0xFF): FFFFFFFF
    const accOnStatus = parseEquStatus('FFFFFFFF');
    assert.strictEqual(accOnStatus.accOn, true, 'Expected ACC to be ON for FFFFFFFF');
    assert.strictEqual(accOnStatus.alarms.length, 0, 'Expected no alarms');
    assert.strictEqual(accOnStatus.isOilCut, false);

    // Example 2: Parked / stationary state with ACC OFF (Byte 3 = 0xFB -> bit 2 = 0): FFFFFBFF
    const parkedStatus = parseEquStatus('FFFFFBFF');
    assert.strictEqual(parkedStatus.accOn, false, 'Expected ACC to be OFF for FFFFFBFF');
    assert.strictEqual(parkedStatus.alarms.length, 0, 'Expected no alarms');

    // Example 3: SOS alarm + ACC OFF + Main Power Cut: FFEBFBFF
    // Byte 1 = 0xFF
    // Byte 2 = 0xEB (bit 4=0: power cut, bit 2=0: SOS)
    // Byte 3 = 0xFB (bit 2=0: ACC off)
    // Byte 4 = 0xFF
    const alarmStatus = parseEquStatus('FFEBFBFF');
    assert.strictEqual(alarmStatus.accOn, false, 'Expected ACC to be OFF');
    assert(alarmStatus.alarms.includes('SOS'), 'Expected SOS alarm');
    assert(alarmStatus.alarms.includes('POWER_CUT'), 'Expected POWER_CUT alarm');
    console.log('✅ Test K Passed!\n');

    // ───────────────────────────────────────────────────────────────────────────
    // TEST L: Speed Knots to km/h conversion, Direction, & DDMMYY Date
    // ───────────────────────────────────────────────────────────────────────────
    console.log('Test L: Cantrack V1 Speed (knots to km/h), Direction, & Date format');
    // 10.00 knots -> 18.52 km/h, direction 180 deg, date 100815 (10 Aug 2015), ACC ON (FFFFFFFF)
    const msgL = '*HQ,865205030330012,V1,145452,A,2240.55181,N,11358.32389,E,10.00,180,100815,FFFFFFFF#\r\n';
    const mockSockL = createMockSocket();
    const stateL = { protocol: null, buffer: Buffer.from(msgL) };
    mockSockL._trackerState = stateL;
    _processBuffer(mockSockL, stateL);

    const logL = capturedLogs.find((l) => l.event === 'HQ_GPS_UPDATE' && l.data.imei === '865205030330012');
    assert(logL, 'Expected HQ_GPS_UPDATE event');
    assert.strictEqual(logL.data.speed_knots, 10.00);
    assert.strictEqual(logL.data.speed_kmh, 18.52, 'Expected 10.00 knots * 1.852 = 18.52 km/h');
    assert.strictEqual(logL.data.direction, 180, 'Expected direction = 180');
    assert.strictEqual(logL.data.timestamp, '2015-08-10 14:54:52 UTC');
    assert.strictEqual(logL.data.accOn, true);

    // ACK should contain date 20150810145452
    const ackLogL = capturedLogs.find((l) => l.event === 'HQ_ACK_SENT' && l.data.imei === '865205030330012');
    assert(ackLogL, 'Expected ACK sent');
    assert.strictEqual(ackLogL.data.responseAscii, '*HQ,865205030330012,V4,V1,20150810145452#');
    console.log('✅ Test L Passed!\n');

    // ───────────────────────────────────────────────────────────────────────────
    // TEST M: V2 GPS, V3 LBS, and V4 Command Confirmation packets
    // ───────────────────────────────────────────────────────────────────────────
    console.log('Test M: Handling V2 (GPS), V3 (LBS), and V4 (Command Confirmation) packets');
    const mockSockM = createMockSocket();
    const stateM = { protocol: null, buffer: Buffer.alloc(0) };
    mockSockM._trackerState = stateM;

    // V2 GPS packet
    stateM.buffer = Buffer.from('*HQ,865205030330012,V2,150421,A,2240.55841,N,11358.33462,E,2.06,0,100815,FFFFFBFF#\r\n');
    _processBuffer(mockSockM, stateM);
    const logM_v2 = capturedLogs.find((l) => l.event === 'HQ_GPS_UPDATE' && l.data.cmd === 'V2');
    assert(logM_v2, 'Expected V2 GPS update log');

    // V3 LBS packet
    stateM.buffer = Buffer.from('*HQ,865205030330012,V3,000201,46000,07,009350,004022,132,-88,0256,0,X,010915,FFFFFBFF#\r\n');
    _processBuffer(mockSockM, stateM);
    const logM_v3 = capturedLogs.find((l) => l.event === 'HQ_LBS_UPDATE');
    assert(logM_v3, 'Expected V3 LBS update log');

    // V4 Confirm packet
    stateM.buffer = Buffer.from('*HQ,865205030330012,V4,S2,150950,151007,A,2240.55503,N,11358.35174,E,0.85,0,100815,FFFFFBFF#\r\n');
    _processBuffer(mockSockM, stateM);
    const logM_v4 = capturedLogs.find((l) => l.event === 'HQ_COMMAND_CONFIRM');
    assert(logM_v4, 'Expected V4 command confirm log');
    assert.strictEqual(logM_v4.data.cmdConfirmed, 'S2');
    console.log('✅ Test M Passed!\n');

    // ───────────────────────────────────────────────────────────────────────────
    // TEST O: Cantrack Command Builders (All 17 Commands: S1..S33, S80, D1, D2, R1, WKMD)
    // ───────────────────────────────────────────────────────────────────────────
    console.log('Test O: Cantrack Command Builders (17 Official Commands)');
    const imeiO = '867232054850970';
    const fixedTime = '120000';

    // 1. S1 Change Password
    const s1Cmd = buildCantrackCommand(imeiO, 'S1', ['123456', '654321'], fixedTime);
    assert.strictEqual(s1Cmd, `*HQ,${imeiO},S1,${fixedTime},123456,654321#`);

    // 2. S2 Center Number
    const s2Cmd = buildCantrackCommand(imeiO, 'S2', ['08012345678'], fixedTime);
    assert.strictEqual(s2Cmd, `*HQ,${imeiO},S2,${fixedTime},08012345678#`);

    // 3. S3 Admin Numbers (up to 5)
    const s3Cmd = buildCantrackCommand(imeiO, 'S3', ['13800000001', '13800000002'], fixedTime);
    assert.strictEqual(s3Cmd, `*HQ,${imeiO},S3,${fixedTime},13800000001,13800000002#`);

    // 4. S18 Alarm Mode
    const s18Cmd = buildCantrackCommand(imeiO, 'S18', [1], fixedTime);
    assert.strictEqual(s18Cmd, `*HQ,${imeiO},S18,${fixedTime},1#`);

    // 5. S19 Alarm Type
    const s19Cmd = buildCantrackCommand(imeiO, 'S19', [1, 1], fixedTime);
    assert.strictEqual(s19Cmd, `*HQ,${imeiO},S19,${fixedTime},1,1#`);

    // 6. S20 Remote Disable / Enable Fuel (Cut / Restore)
    const s20CutCmd = buildCantrackCommand(imeiO, 'cut-fuel', [], fixedTime);
    assert.strictEqual(s20CutCmd, `*HQ,${imeiO},S20,${fixedTime},1,1#`);

    const s20RestoreCmd = buildCantrackCommand(imeiO, 'resume-fuel', [], fixedTime);
    assert.strictEqual(s20RestoreCmd, `*HQ,${imeiO},S20,${fixedTime},1,0#`);

    // 7. S21 Geo-fence Alarm
    const s21Cmd = buildCantrackCommand(imeiO, 'S21', [1000, 1], fixedTime);
    assert.strictEqual(s21Cmd, `*HQ,${imeiO},S21,${fixedTime},1000,1#`);

    // 8. S23 IP & Port
    const s23Cmd = buildCantrackCommand(imeiO, 'S23', ['140.238.88.183', '5022'], fixedTime);
    assert.strictEqual(s23Cmd, `*HQ,${imeiO},S23,${fixedTime},140,238,88,183,5022#`);

    // 9. S24 APN
    const s24Cmd = buildCantrackCommand(imeiO, 'S24', ['CMNET', '', ''], fixedTime);
    assert.strictEqual(s24Cmd, `*HQ,${imeiO},S24,${fixedTime},CMNET,,#`);

    // 10. S25 Factory Default
    const s25Cmd = buildCantrackCommand(imeiO, 'S25', [], fixedTime);
    assert.strictEqual(s25Cmd, `*HQ,${imeiO},S25,${fixedTime}#`);

    // 11. S26 Read Device's State
    const s26Cmd = buildCantrackCommand(imeiO, 'S26', [0], fixedTime);
    assert.strictEqual(s26Cmd, `*HQ,${imeiO},S26,${fixedTime},0#`);

    // 12. S33 Overspeed Alarm
    const s33Cmd = buildCantrackCommand(imeiO, 'S33', [80], fixedTime);
    assert.strictEqual(s33Cmd, `*HQ,${imeiO},S33,${fixedTime},80#`);

    // 13. S80 Check LBS Command
    const s80Cmd = buildCantrackCommand(imeiO, 'S80', [3], fixedTime);
    assert.strictEqual(s80Cmd, `*HQ,${imeiO},S80,${fixedTime},3#`);

    // 14. D1 Set GPRS Interval
    const d1Cmd = buildCantrackCommand(imeiO, 'D1', [30], fixedTime);
    assert.strictEqual(d1Cmd, `*HQ,${imeiO},D1,${fixedTime},30#`);

    // 15. D2 Fast Locate LBS Mode
    const d2Cmd = buildCantrackCommand(imeiO, 'D2', [180], fixedTime);
    assert.strictEqual(d2Cmd, `*HQ,${imeiO},D2,${fixedTime},180#`);

    // 16. R1 Restart Command
    const r1Cmd = buildCantrackCommand(imeiO, 'R1', [], fixedTime);
    assert.strictEqual(r1Cmd, `*HQ,${imeiO},R1,${fixedTime}#`);

    // 17. WKMD Working Mode
    const wkmdCmd = buildCantrackCommand(imeiO, 'WKMD', [0], fixedTime);
    assert.strictEqual(wkmdCmd, `*HQ,${imeiO},WKMD,${fixedTime},0#`);

    // Test sanitizeCommandString stripping any trailing CRLF
    const doubleEscaped = '*HQ,867232054850970,S20,120000,1,1#\\r\\n';
    const cleanedDoubleEscaped = sanitizeCommandString(doubleEscaped);
    assert.strictEqual(cleanedDoubleEscaped, '*HQ,867232054850970,S20,120000,1,1#');
    console.log('✅ Test O Passed!\n');

    // ───────────────────────────────────────────────────────────────────────────
    // TEST P: sendDeviceCommand & Device State Cache
    // ───────────────────────────────────────────────────────────────────────────
    console.log('Test P: sendDeviceCommand & Device State Cache');
    const mockSockP = createMockSocket('192.168.1.50', 50050);
    mockSockP._trackerState = { protocol: 'HQ', imei: imeiO };
    registerDevice(imeiO, mockSockP, 'HQ');

    const emittedGpsEvents = [];
    const eventHandlerP = (payload) => emittedGpsEvents.push(payload);
    gpsEventEmitter.on('gps:command_sent', eventHandlerP);

    const resP = await sendDeviceCommand(imeiO, 'WKMD', [0]);
    assert.strictEqual(resP.success, true);
    assert.strictEqual(mockSockP.written.length, 1);
    assert(mockSockP.written[0].startsWith(`*HQ,${imeiO},WKMD,`));
    assert(mockSockP.written[0].endsWith(',0#'));

    // Test sendRawDeviceCommand: purely trims and writes directly to socket ending in '#'
    const rawDirect = `*HQ,${imeiO},S20,195440,1,1#`;
    const resRawDirect = await sendRawDeviceCommand(imeiO, rawDirect);
    assert.strictEqual(resRawDirect.success, true);
    assert.strictEqual(resRawDirect.cmd, 'RAW');
    assert.strictEqual(resRawDirect.command, `*HQ,${imeiO},S20,195440,1,1#`);
    assert.strictEqual(mockSockP.written[1], `*HQ,${imeiO},S20,195440,1,1#`);

    // Test sendDeviceCommand with alias 'cut-fuel' -> builds Cantrack S20,1,1
    const resCutFuel = await sendDeviceCommand(imeiO, 'cut-fuel');
    assert.strictEqual(resCutFuel.success, true);
    assert(mockSockP.written[2].startsWith(`*HQ,${imeiO},S20,`));
    assert(mockSockP.written[2].endsWith(',1,1#'));

    // Check device state
    const deviceStateP = getDeviceState(imeiO);
    assert.strictEqual(deviceStateP.connected, true);
    assert.strictEqual(deviceStateP.lastCommand.cmd, 'cut-fuel');

    // Check connected devices list
    const allDevices = getConnectedDevices();
    assert(allDevices.some((d) => d.imei === imeiO && d.connected === true));

    // Check event emitter
    assert(emittedGpsEvents.length >= 3);
    assert.strictEqual(emittedGpsEvents[0].imei, imeiO);
    assert.strictEqual(emittedGpsEvents[0].cmd, 'WKMD');
    assert.strictEqual(emittedGpsEvents[1].cmd, 'RAW');
    assert.strictEqual(emittedGpsEvents[2].cmd, 'cut-fuel');

    gpsEventEmitter.off('gps:command_sent', eventHandlerP);
    console.log('✅ Test P Passed!\n');

    // ───────────────────────────────────────────────────────────────────────────
    // TEST Q: Offline Device sendDeviceCommand
    // ───────────────────────────────────────────────────────────────────────────
    console.log('Test Q: Offline device command handling');
    const resOffline = await sendDeviceCommand('999999999999999', 'R1');
    assert.strictEqual(resOffline.success, false);
    assert.strictEqual(resOffline.connected, false);
    console.log('✅ Test Q Passed!\n');

    // Clean registry before shutdown test
    deviceRegistry.clear();

    // ───────────────────────────────────────────────────────────────────────────
    // TEST N: Server Graceful Shutdown (closeGt06Server)
    // ───────────────────────────────────────────────────────────────────────────
    console.log('Test N: Server graceful shutdown (closeGt06Server)');
    const mockSockN = createMockSocket('10.0.0.2', 60002);
    const stateN = {
      protocol: 'HQ',
      buffer: Buffer.alloc(0),
      imei: '867232054850999',
      closeReason: 'remote_tracker_close',
    };
    mockSockN._trackerState = stateN;
    deviceRegistry.set('867232054850999', mockSockN);

    const mockServer = {
      close: (cb) => { if (cb) cb(); },
    };

    await closeGt06Server(mockServer, 'server_shutdown');
    assert.strictEqual(mockSockN.isDestroyed, true, 'Active socket should be destroyed on server shutdown');
    assert.strictEqual(stateN.closeReason, 'server_shutdown');
    assert.strictEqual(deviceRegistry.size, 0, 'Registry should be empty after server shutdown');
    console.log('✅ Test N Passed!\n');

    console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
  } finally {
    restoreLogs();
  }
}

console.log('Running GT06 & HQ Protocol Automated Tests...\n');
runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});



