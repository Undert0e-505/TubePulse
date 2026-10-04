import crypto from 'node:crypto';

export const GATEWAY_HEADERS = Object.freeze({
  version: 'x-tubepulse-gateway-version',
  timestamp: 'x-tubepulse-gateway-timestamp',
  requestId: 'x-tubepulse-gateway-request-id',
  operation: 'x-tubepulse-gateway-operation',
  bodyDigest: 'x-tubepulse-gateway-body-sha256',
  signature: 'x-tubepulse-gateway-signature',
});

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmacHex(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function requestCanonical({ timestamp, requestId, operation, method, target, authorizationDigest, bodyDigest }) {
  return [
    'tubepulse-gateway-v1',
    String(timestamp),
    requestId,
    operation,
    method.toUpperCase(),
    target,
    authorizationDigest,
    bodyDigest,
  ].join('\n');
}

function reconciliationCanonical({ timestamp, requestId, fingerprint }) {
  return [
    'tubepulse-gateway-reconcile-v1',
    String(timestamp),
    requestId,
    fingerprint,
  ].join('\n');
}

function safeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export class GatewayReplayGuard {
  constructor({ now = () => Date.now(), skewMs = 60_000 } = {}) {
    this.now = now;
    this.skewMs = skewMs;
    this.seen = new Map();
  }

  accept(requestId, timestamp) {
    const current = this.now();
    for (const [id, expiresAt] of this.seen) {
      if (expiresAt < current) this.seen.delete(id);
    }
    if (Math.abs(current - timestamp) > this.skewMs || this.seen.has(requestId)) return false;
    this.seen.set(requestId, current + this.skewMs);
    return true;
  }
}

export function signGatewayRequest({
  secret,
  timestamp,
  requestId,
  operation,
  method,
  target,
  authorization = '',
  body = Buffer.alloc(0),
}) {
  const bodyDigest = sha256Hex(body);
  const authorizationDigest = sha256Hex(authorization);
  const signature = hmacHex(secret, requestCanonical({
    timestamp,
    requestId,
    operation,
    method,
    target,
    authorizationDigest,
    bodyDigest,
  }));
  return {
    'X-TubePulse-Gateway-Version': '1',
    'X-TubePulse-Gateway-Timestamp': String(timestamp),
    'X-TubePulse-Gateway-Request-Id': requestId,
    'X-TubePulse-Gateway-Operation': operation,
    'X-TubePulse-Gateway-Body-SHA256': bodyDigest,
    'X-TubePulse-Gateway-Signature': signature,
  };
}

export function verifyGatewayRequest({
  secret,
  headers,
  method,
  target,
  body = Buffer.alloc(0),
  expectedOperation,
  replayGuard,
  now = () => Date.now(),
  skewMs = 60_000,
}) {
  const version = String(headers[GATEWAY_HEADERS.version] || '');
  const operation = String(headers[GATEWAY_HEADERS.operation] || '');
  const requestId = String(headers[GATEWAY_HEADERS.requestId] || '');
  const bodyDigest = String(headers[GATEWAY_HEADERS.bodyDigest] || '').toLowerCase();
  const signature = String(headers[GATEWAY_HEADERS.signature] || '').toLowerCase();
  const timestamp = Number(headers[GATEWAY_HEADERS.timestamp]);
  if (
    version !== '1'
    || operation !== expectedOperation
    || !/^[a-zA-Z0-9_-]{16,128}$/.test(requestId)
    || !Number.isFinite(timestamp)
    || !/^[a-f0-9]{64}$/.test(bodyDigest)
    || !/^[a-f0-9]{64}$/.test(signature)
  ) return { ok: false, reason: 'invalid-metadata' };
  if (Math.abs(now() - timestamp) > skewMs) return { ok: false, reason: 'expired' };

  const actualDigest = sha256Hex(body);
  if (!safeHexEqual(bodyDigest, actualDigest)) return { ok: false, reason: 'body-digest' };
  const authorizationDigest = sha256Hex(String(headers.authorization || ''));
  const expected = hmacHex(secret, requestCanonical({
    timestamp,
    requestId,
    operation,
    method,
    target,
    authorizationDigest,
    bodyDigest,
  }));
  if (!safeHexEqual(signature, expected)) return { ok: false, reason: 'signature' };
  if (replayGuard && !replayGuard.accept(requestId, timestamp)) return { ok: false, reason: 'replay' };
  return { ok: true, requestId };
}

export function createReconciliationReceipt({ secret, fingerprint, now = () => Date.now(), randomUUID = () => crypto.randomUUID() }) {
  const timestamp = now();
  const requestId = randomUUID();
  const signature = hmacHex(secret, reconciliationCanonical({ timestamp, requestId, fingerprint }));
  return { fingerprint, timestamp, requestId, signature };
}

export const gatewayAuthTestHelpers = Object.freeze({
  hmacHex,
  reconciliationCanonical,
  requestCanonical,
  sha256Hex,
});
