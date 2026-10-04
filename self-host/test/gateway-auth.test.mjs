import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createReconciliationReceipt,
  GatewayReplayGuard,
  gatewayAuthTestHelpers,
  signGatewayRequest,
  verifyGatewayRequest,
} from '../src/gateway-auth.mjs';

const SECRET = 'synthetic-local-gateway-secret-32-characters-minimum';
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const BODY = Buffer.from('{"value":7}');
const AUTHORIZATION = 'Bearer synthetic-authenticated-device';

function lowerCaseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

function signed(overrides = {}) {
  return {
    ...lowerCaseHeaders(signGatewayRequest({
      secret: SECRET,
      timestamp: NOW,
      requestId: 'synthetic-request-0001',
      operation: 'mutation',
      method: 'POST',
      target: '/settings?source=test',
      authorization: AUTHORIZATION,
      body: BODY,
      ...overrides,
    })),
    authorization: AUTHORIZATION,
  };
}

function verify(headers, overrides = {}) {
  return verifyGatewayRequest({
    secret: SECRET,
    headers,
    method: 'POST',
    target: '/settings?source=test',
    body: BODY,
    expectedOperation: 'mutation',
    now: () => NOW,
    skewMs: 60_000,
    ...overrides,
  });
}

test('valid gateway HMAC authenticates method, target, authorization, body digest, and operation', () => {
  assert.deepEqual(verify(signed()), { ok: true, requestId: 'synthetic-request-0001' });
});

test('tampered signature, body, path, and operation are rejected', () => {
  const headers = signed();
  const rejected = verify({ ...headers, 'x-tubepulse-gateway-signature': '0'.repeat(64) });
  assert.deepEqual(rejected, { ok: false, reason: 'signature' });
  assert.equal(JSON.stringify(rejected).includes(AUTHORIZATION), false);
  assert.equal(JSON.stringify(rejected).includes(SECRET), false);
  assert.equal(verify(headers, { body: Buffer.from('{"value":8}') }).ok, false);
  assert.equal(verify(headers, { target: '/_tubepulse/admin/takeover' }).ok, false);
  assert.equal(verify(headers, { expectedOperation: 'read' }).ok, false);
  assert.equal(verify({ ...headers, authorization: 'Bearer tampered-device' }).ok, false);
});

test('expired and future-dated signatures are rejected', () => {
  assert.equal(verify(signed({ timestamp: NOW - 60_001 })).ok, false);
  assert.equal(verify(signed({ timestamp: NOW + 60_001 })).ok, false);
});

test('a valid request ID is single-use inside the replay window', () => {
  const replayGuard = new GatewayReplayGuard({ now: () => NOW, skewMs: 60_000 });
  const headers = signed();
  assert.equal(verify(headers, { replayGuard }).ok, true);
  assert.equal(verify(headers, { replayGuard }).ok, false);
});

test('reconciliation receipt contains only scoped fingerprint metadata and a valid HMAC', () => {
  const fingerprint = 'a'.repeat(64);
  const receipt = createReconciliationReceipt({
    secret: SECRET,
    fingerprint,
    now: () => NOW,
    randomUUID: () => 'synthetic-reconcile-0001',
  });
  assert.deepEqual(Object.keys(receipt).sort(), ['fingerprint', 'requestId', 'signature', 'timestamp']);
  assert.equal(receipt.fingerprint, fingerprint);
  assert.equal(
    receipt.signature,
    gatewayAuthTestHelpers.hmacHex(SECRET, gatewayAuthTestHelpers.reconciliationCanonical(receipt)),
  );
});
