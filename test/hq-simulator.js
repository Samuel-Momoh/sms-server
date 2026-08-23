'use strict';

/**
 * HQ Protocol Simulator
 *
 * Simulates a real GPS tracker sending ASCII HQ protocol packets to the server.
 * Run this AFTER starting the main server with `npm run dev`.
 *
 * Usage:
 *   node test/hq-simulator.js
 */

const net = require('net');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.GT06_PORT, 10) || 5022;

const client = net.createConnection({ host: HOST, port: PORT }, () => {
  console.log(`\n🔌 Connected to GPS Tracker server at ${HOST}:${PORT}\n`);

  // Step 1: Send V0 Login
  console.log('📤 [1] Sending HQ V0 Login (*HQ,867232054850970,V0#)...');
  client.write('*HQ,867232054850970,V0#\r\n');

  // Step 2: Send Heartbeat
  setTimeout(() => {
    console.log('\n📤 [2] Sending HQ Heartbeat (*HQ,867232054850970,HTBT#)...');
    client.write('*HQ,867232054850970,HTBT#\r\n');
  }, 500);

  // Step 3: Send GPS location (Port Harcourt / Niger Delta coordinates)
  setTimeout(() => {
    console.log('\n📤 [3] Sending HQ GPS Location (*HQ,867232054850970,V1,210046,A,0453.2956,N,00654.7924,E,0.00,0,)...');
    client.write('*HQ,867232054850970,V1,210046,A,0453.2956,N,00654.7924,E,0.00,0,\n');
  }, 1000);

  // Step 4: Send fragmented GPS packet
  setTimeout(() => {
    console.log('\n📤 [4] Sending Fragmented HQ Packet...');
    client.write('*HQ,8672320548');
    setTimeout(() => {
      client.write('50970,V1,210100,A,0453.2956,N,00654.7924,E,15.50,90#\r\n');
    }, 200);
  }, 1500);

  setTimeout(() => {
    console.log('\n✅ HQ Test complete. Closing connection.\n');
    client.end();
  }, 2200);
});

client.on('data', (data) => {
  console.log(`📥 Server response received: ${JSON.stringify(data.toString())} [HEX: ${data.toString('hex')}]`);
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
