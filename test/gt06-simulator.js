'use strict';

/**
 * GT06 Protocol Simulator
 *
 * Simulates a real GPS tracker connecting to the GT06 server.
 * Run this AFTER starting the main server with `npm run dev`.
 *
 * Usage:
 *   node test/gt06-simulator.js
 */

const net = require('net');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.GT06_PORT, 10) || 5022;

// ── CRC (same as server) ───────────────────────────────────────────────────
function crc16(buffer) {
  let crc = 0x0000;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= (buffer[i] << 8);
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) !== 0
        ? ((crc << 1) ^ 0x1021) & 0xFFFF
        : (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

// ── Frame builder ──────────────────────────────────────────────────────────
function buildFrame(protocolNumber, contentBytes) {
  // length = protocol(1) + content + serialNo(2) — but we include serialNo in content
  const length   = 1 + contentBytes.length + 2; // protocol + content + CRC placeholder(2)
  const header   = Buffer.from([0x78, 0x78, length, protocolNumber]);
  const serial   = Buffer.from([0x00, 0x01]);              // serial number
  const body     = Buffer.concat([Buffer.from([length, protocolNumber]), contentBytes, serial]);
  const crcVal   = crc16(body);
  const crcBuf   = Buffer.alloc(2);
  crcBuf.writeUInt16BE(crcVal, 0);
  return Buffer.concat([Buffer.from([0x78, 0x78, length, protocolNumber]), contentBytes, serial, crcBuf, Buffer.from([0x0D, 0x0A])]);
}

// ── Packet factories ───────────────────────────────────────────────────────

// LOGIN — IMEI encoded as 8 BCD bytes (fake IMEI: 012345678901234)
function buildLoginPacket() {
  const imei = Buffer.from([0x01, 0x23, 0x45, 0x67, 0x89, 0x01, 0x23, 0x40]);
  return buildFrame(0x01, imei);
}

// GPS LOCATION — Lagos, Nigeria: 6.524379, 3.379206
function buildGpsPacket() {
  const buf = Buffer.alloc(16);

  // Timestamp: 26-08-23 15:59:00
  buf[0] = 26;   // year (2026)
  buf[1] = 8;    // month
  buf[2] = 23;   // day
  buf[3] = 15;   // hour
  buf[4] = 59;   // minute
  buf[5] = 0;    // second

  // GPS info byte (satellites = 6, length = 0)
  buf[6] = 0xC6;

  // Latitude: 6.524379 * 1,800,000 = 11,743,882
  const rawLat = Math.round(6.524379 * 1800000);
  buf.writeUInt32BE(rawLat, 7);

  // Longitude: 3.379206 * 1,800,000 = 6,082,571
  const rawLon = Math.round(3.379206 * 1800000);
  buf.writeUInt32BE(rawLon, 11);

  // Speed: 0 km/h
  buf[15] = 0;

  // Course/Status: 0x18C0
  //   bit 12 = 1 → GPS realtime fix
  //   bit 11 = 0 → East longitude
  //   bit 10 = 1 → North latitude (isSouthLat = (flag & 0x0400) === 0 → false → North)
  const courseStatus = Buffer.alloc(2);
  courseStatus.writeUInt16BE(0x18C0, 0);  // realtime + north + east

  return buildFrame(0x12, Buffer.concat([buf, courseStatus]));
}

// HEARTBEAT
function buildHeartbeatPacket() {
  // Status: voltage level(1) + GSM signal(1) + alarm(2) + language(2)
  const status = Buffer.from([0x06, 0x04, 0x00, 0x00, 0x00, 0x01]);
  return buildFrame(0x13, status);
}

// ── Runner ─────────────────────────────────────────────────────────────────

const client = net.createConnection({ host: HOST, port: PORT }, () => {
  console.log(`\n🔌 Connected to GT06 server at ${HOST}:${PORT}\n`);

  // Step 1 — Login
  console.log('📤 Sending LOGIN packet (0x01)...');
  client.write(buildLoginPacket());

  setTimeout(() => {
    // Step 2 — GPS fix
    console.log('\n📤 Sending GPS LOCATION packet (0x12) — Lagos, Nigeria...');
    client.write(buildGpsPacket());
  }, 500);

  setTimeout(() => {
    // Step 3 — Heartbeat
    console.log('\n📤 Sending HEARTBEAT packet (0x13)...');
    client.write(buildHeartbeatPacket());
  }, 1000);

  setTimeout(() => {
    console.log('\n✅ Test complete. Closing connection.\n');
    client.end();
  }, 1500);
});

client.on('data', (data) => {
  console.log(`📥 Server ACK received: ${data.toString('hex')}`);
});

client.on('close', () => {
  console.log('🔌 Connection closed.');
});

client.on('error', (err) => {
  if (err.code === 'ECONNREFUSED') {
    console.error(`\n❌ Connection refused — make sure the server is running first:\n\n   npm run dev\n`);
  } else {
    console.error(`❌ Error: ${err.message}`);
  }
});
