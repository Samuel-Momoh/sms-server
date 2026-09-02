'use strict';

const assert = require('assert');

function runCorsMiddleware(req, res, next) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-admin-user, x-admin-pwd, Range');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
}

async function testCors() {
  console.log('\n=== Running CORS & Preflight Unit Tests ===\n');

  // Test 1: OPTIONS Preflight from https://etrack.name.ng
  console.log('[Test 1] Preflight OPTIONS request from https://etrack.name.ng...');
  let headers = {};
  let sentStatus = null;
  let nextCalled = false;

  const req1 = {
    method: 'OPTIONS',
    headers: {
      origin: 'https://etrack.name.ng',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'Content-Type, Authorization',
    },
  };
  const res1 = {
    setHeader: (key, val) => { headers[key.toLowerCase()] = val; },
    sendStatus: (code) => { sentStatus = code; },
  };

  runCorsMiddleware(req1, res1, () => { nextCalled = true; });

  assert.strictEqual(sentStatus, 204, `Expected status 204 for OPTIONS, got ${sentStatus}`);
  assert.strictEqual(headers['access-control-allow-origin'], 'https://etrack.name.ng');
  assert.strictEqual(headers['access-control-allow-credentials'], 'true');
  assert.ok(headers['access-control-allow-methods'].includes('POST'));
  assert.ok(headers['access-control-allow-headers'].includes('Authorization'));
  assert.strictEqual(nextCalled, false);
  console.log('✔ Test 1 Passed: OPTIONS preflight intercepted with 204 and CORS headers');

  // Test 2: Actual POST /api/gps/auth/login
  console.log('\n[Test 2] POST request with Origin https://etrack.name.ng...');
  headers = {};
  sentStatus = null;
  nextCalled = false;

  const req2 = {
    method: 'POST',
    headers: {
      origin: 'https://etrack.name.ng',
      'content-type': 'application/json',
    },
  };
  const res2 = {
    setHeader: (key, val) => { headers[key.toLowerCase()] = val; },
    sendStatus: (code) => { sentStatus = code; },
  };

  runCorsMiddleware(req2, res2, () => { nextCalled = true; });

  assert.strictEqual(headers['access-control-allow-origin'], 'https://etrack.name.ng');
  assert.strictEqual(nextCalled, true);
  console.log('✔ Test 2 Passed: POST request proceeds to next middleware with Access-Control-Allow-Origin');

  console.log('\n=============================================');
  console.log('  ALL CORS PREFLIGHT TESTS PASSED (100%)');
  console.log('=============================================\n');
}

if (require.main === module) {
  testCors().catch(err => {
    console.error('CORS Test Failed:', err);
    process.exit(1);
  });
}
