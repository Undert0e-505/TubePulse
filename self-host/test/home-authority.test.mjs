import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AuthorityReplayGuard,
  HomeAuthorityGate,
  HomeAuthorityIngress,
  authorityManifest,
  createHomeAuthorityStateFile,
  installAuthoritySnapshot,
  signAuthorityRequest,
} from '../src/home-authority.mjs';
import { contentHash } from '../src/kv-adapters.mjs';

const SECRET = 'synthetic-home-authority-secret-with-adequate-length';
const BEARER = 'synthetic-device-one';

class MemoryAdapter {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); this.failOnce = false; }
  async listKeys() { return [...this.values.keys()].sort().map((name) => ({ name })); }
  async get(name) { return this.values.has(name) ? this.values.get(name) : null; }
  async put(name, value) {
    if (this.failOnce) { this.failOnce = false; throw new Error('synthetic-local-write-failure'); }
    this.values.set(name, String(value));
  }
  async delete(name) { this.values.delete(name); }
}

async function fixture(t, entries = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-authority-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const adapter = new MemoryAdapter(entries);
  const stateFile = createHomeAuthorityStateFile(directory);
  const gate = new HomeAuthorityGate({ adapter, stateFile });
  await gate.initialize();
  const manifest = await authorityManifest(adapter);
  await gate.reconcile({ manifestHash: manifest.hash, recordCount: manifest.recordCount });
  return { directory, adapter, stateFile, gate, ingress: new HomeAuthorityIngress({ secret: SECRET, gate }) };
}

function signedRequest(pathname, operation, payload, {
  bearer = BEARER, requestId = `request-${crypto.randomUUID()}`, timestamp = Date.now(), bodyOverride,
} = {}) {
  const body = bodyOverride ?? JSON.stringify(payload);
  const authorization = `Bearer ${bearer}`;
  const headers = signAuthorityRequest({
    secret: SECRET, timestamp, requestId, operation, method: 'POST', target: pathname, authorization, body,
  });
  return new Request(`http://gateway-origin:8788${pathname}`, {
    method: 'POST', headers: { ...headers, Authorization: authorization, 'Content-Type': 'application/json' }, body,
  });
}

test('signed preflight and exact commit apply all-device deltas under one lease', async (t) => {
  const fx = await fixture(t, { 'device:one:settings': '{"enabled":true}' });
  const leaseId = 'api-lease-synthetic-0001';
  let response = await fx.ingress.handle(signedRequest('/_tubepulse/authority/preflight', 'authority-preflight', {
    leaseId, method: 'POST', path: '/settings',
  }, { bearer: 'device-one' }));
  assert.equal(response.status, 200);
  response = await fx.ingress.handle(signedRequest('/_tubepulse/authority/commit', 'authority-commit', {
    leaseId,
    deltas: [{
      key: 'device:one:settings', operation: 'put', value: '{"enabled":false}', options: {},
      baseHash: contentHash('{"enabled":true}'), nextHash: contentHash('{"enabled":false}'),
    }],
  }, { bearer: 'device-one' }));
  assert.equal(response.status, 200);
  assert.equal(fx.adapter.values.get('device:one:settings'), '{"enabled":false}');
  assert.equal((await fx.gate.status()).lease, null);
});

test('scheduler lease and API preflight are mutually exclusive in the same gate', async (t) => {
  const fx = await fixture(t);
  await fx.gate.acquire({ leaseId: 'scheduler-exclusive-0001', kind: 'scheduler' });
  const response = await fx.ingress.handle(signedRequest('/_tubepulse/authority/preflight', 'authority-preflight', {
    leaseId: 'api-overlap-synthetic-01', method: 'POST', path: '/seen',
  }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /busy/);
  await fx.gate.release('scheduler-exclusive-0001');
});

test('Home feed is closed during local polling/replication and opens only after canonical publication', async (t) => {
  const fx = await fixture(t, { content: 'old' });
  assert.equal(await fx.gate.readReady(), true);
  const leaseId = 'scheduler-read-gate-0001';
  await fx.gate.acquire({ leaseId, kind: 'scheduler' });
  assert.equal(await fx.gate.readReady(), false);
  await fx.adapter.put('content', 'new');
  await fx.gate.verifyScheduler(leaseId, [{
    key: 'content', operation: 'put', value: 'new', options: {},
    baseHash: contentHash('old'), nextHash: contentHash('new'),
  }]);
  assert.equal(await fx.gate.readReady(), true);
  await fx.gate.release(leaseId);

  await fx.gate.acquire({ leaseId: 'api-read-gate-0000001', kind: 'api', identityHash: contentHash(BEARER) });
  assert.equal(await fx.gate.readReady(), false);
  await fx.gate.release('api-read-gate-0000001');
});

test('route, signature, expiry, replay, body and identity protections fail closed', async (t) => {
  const fx = await fixture(t);
  const payload = { leaseId: 'api-auth-synthetic-0001', method: 'POST', path: '/not-allowed' };
  let response = await fx.ingress.handle(signedRequest('/_tubepulse/authority/preflight', 'authority-preflight', payload));
  assert.equal(response.status, 404);

  const validPayload = { ...payload, path: '/register' };
  const replayId = 'authority-replay-000001';
  const first = signedRequest('/_tubepulse/authority/preflight', 'authority-preflight', validPayload, { requestId: replayId });
  response = await fx.ingress.handle(first);
  assert.equal(response.status, 200);
  const replay = signedRequest('/_tubepulse/authority/cancel', 'authority-cancel', {
    leaseId: validPayload.leaseId,
  }, { requestId: replayId });
  response = await fx.ingress.handle(replay);
  assert.equal(response.status, 401);

  const expired = signedRequest('/_tubepulse/authority/cancel', 'authority-cancel', {
    leaseId: validPayload.leaseId,
  }, { timestamp: Date.now() - 120_000 });
  response = await fx.ingress.handle(expired);
  assert.equal(response.status, 401);

  const tampered = signedRequest('/_tubepulse/authority/cancel', 'authority-cancel', {
    leaseId: validPayload.leaseId,
  }, { bodyOverride: JSON.stringify({ leaseId: 'different-lease-00001' }) });
  // bodyOverride is what is signed, so deliberately corrupt one byte after construction.
  const corruptHeaders = Object.fromEntries(tampered.headers);
  response = await fx.ingress.handle(new Request(tampered.url, {
    method: 'POST', headers: corruptHeaders, body: JSON.stringify({ leaseId: 'different-lease-00002' }),
  }));
  assert.equal(response.status, 401);

  await fx.gate.release(validPayload.leaseId);
  const missingIdentityBody = JSON.stringify({ leaseId: 'api-no-identity-000001', method: 'POST', path: '/register' });
  const headers = signAuthorityRequest({
    secret: SECRET, operation: 'authority-preflight', target: '/_tubepulse/authority/preflight', body: missingIdentityBody,
  });
  response = await fx.ingress.handle(new Request('http://gateway-origin:8788/_tubepulse/authority/preflight', {
    method: 'POST', headers, body: missingIdentityBody,
  }));
  assert.equal(response.status, 401);
});

test('signed mutation ingress allows only canonical app mutation routes', async (t) => {
  const fx = await fixture(t);
  let calls = 0;
  const ingress = new HomeAuthorityIngress({
    secret: SECRET,
    gate: fx.gate,
    mutationHandler: async () => { calls++; return { response: { status: 200, headers: {}, body: '{}' }, deltas: [] }; },
  });
  const response = await ingress.handle(signedRequest('/_tubepulse/authority/mutation', 'authority-mutation', {
    leaseId: 'api-forbidden-route-0001',
    method: 'POST',
    path: '/websub?unexpected=true',
    body: '{}',
    headers: { 'content-type': 'application/json' },
  }));
  assert.equal(response.status, 404);
  assert.equal(calls, 0);
  assert.equal((await fx.gate.status()).lease, null);
});

test('Home mutation execution failure releases its local lease without applying state', async (t) => {
  const fx = await fixture(t, { alpha: 'one' });
  const ingress = new HomeAuthorityIngress({
    secret: SECRET,
    gate: fx.gate,
    mutationHandler: async () => { throw new Error('synthetic-handler-failure'); },
  });
  const response = await ingress.handle(signedRequest('/_tubepulse/authority/mutation', 'authority-mutation', {
    leaseId: 'api-handler-failure-0001',
    method: 'POST',
    path: '/seen',
    body: JSON.stringify({ channelId: 'UCtest', clearAll: true }),
    headers: { 'content-type': 'application/json' },
  }));
  assert.equal(response.status, 500);
  assert.equal(fx.adapter.values.get('alpha'), 'one');
  assert.equal((await fx.gate.status()).lease, null);
});

test('baseline divergence applies no local deltas and marks Home stale', async (t) => {
  const fx = await fixture(t, { alpha: 'one', beta: 'one' });
  const leaseId = 'api-divergence-lease-01';
  await fx.gate.acquire({ leaseId, kind: 'api', identityHash: contentHash(BEARER), method: 'POST', route: '/settings' });
  await assert.rejects(() => fx.gate.commit({
    leaseId, kind: 'api', identityHash: contentHash(BEARER),
    deltas: [
      { key: 'alpha', operation: 'put', value: 'two', baseHash: contentHash('one'), nextHash: contentHash('two') },
      { key: 'beta', operation: 'put', value: 'two', baseHash: contentHash('wrong'), nextHash: contentHash('two') },
    ],
  }), /diverged/);
  assert.equal(fx.adapter.values.get('alpha'), 'one');
  assert.equal(fx.adapter.values.get('beta'), 'one');
  assert.equal((await fx.gate.status()).replication.status, 'stale');
});

test('partial local transaction is persisted and recovered after restart without replaying completed prefix', async (t) => {
  const fx = await fixture(t, { alpha: 'one', beta: 'one' });
  const leaseId = 'scheduler-crash-lease01';
  await fx.gate.acquire({ leaseId, kind: 'scheduler' });
  let writes = 0;
  const originalPut = fx.adapter.put.bind(fx.adapter);
  fx.adapter.put = async (...args) => {
    writes++;
    if (writes === 2) throw new Error('synthetic-mid-transaction-crash');
    return await originalPut(...args);
  };
  await assert.rejects(() => fx.gate.commit({
    leaseId, kind: 'scheduler', deltas: [
      { key: 'alpha', operation: 'put', value: 'two', baseHash: contentHash('one'), nextHash: contentHash('two') },
      { key: 'beta', operation: 'put', value: 'two', baseHash: contentHash('one'), nextHash: contentHash('two') },
    ],
  }), /synthetic-mid/);
  assert.equal(fx.adapter.values.get('alpha'), 'two');
  assert.equal(fx.adapter.values.get('beta'), 'one');
  fx.adapter.put = originalPut;
  const restarted = new HomeAuthorityGate({ adapter: fx.adapter, stateFile: fx.stateFile });
  await restarted.initialize();
  assert.equal(fx.adapter.values.get('beta'), 'two');
  assert.equal((await restarted.status()).transaction, null);
});

test('manifest is stable, key-sensitive, and does not expose record values', async () => {
  const first = await authorityManifest(new MemoryAdapter({ bravo: 'two', alpha: 'one' }));
  const reordered = await authorityManifest(new MemoryAdapter({ alpha: 'one', bravo: 'two' }));
  const changed = await authorityManifest(new MemoryAdapter({ alpha: 'one', bravo: 'different' }));
  assert.deepEqual(first, reordered);
  assert.notEqual(first.hash, changed.hash);
  assert.equal(first.recordCount, 2);
  assert.equal(JSON.stringify(first).includes('one'), false);
});

test('exact canonical snapshot install validates every hash and preserves excluded local records', async () => {
  const adapter = new MemoryAdapter({ old: 'remove', alpha: 'stale', 'fcm:cache:token': 'local-only' });
  const records = [
    { key: 'alpha', value: 'one', hash: contentHash('one') },
    { key: 'bravo', value: 'two', hash: contentHash('two') },
  ];
  const manifestHash = contentHash(records.map(({ key, hash }) => `${key}\0${hash}\n`).join(''));
  const result = await installAuthoritySnapshot(adapter, {
    manifestHash, recordCount: records.length, records,
  });
  assert.deepEqual(result, {
    imported: 1, updated: 1, deleted: 1, unchanged: 0,
    hash: manifestHash, recordCount: 2,
  });
  assert.deepEqual(Object.fromEntries(adapter.values), {
    alpha: 'one', bravo: 'two', 'fcm:cache:token': 'local-only',
  });
  await assert.rejects(() => installAuthoritySnapshot(adapter, {
    manifestHash, recordCount: 2,
    records: [{ ...records[0], value: 'tampered' }, records[1]],
  }), /record hash/);
  await assert.rejects(() => installAuthoritySnapshot(adapter, {
    manifestHash, recordCount: 2,
    records: [records[0], { ...records[1], key: 'fcm:cache:token' }],
  }), /invalid key/);
});

test('replay guard accepts once inside skew and rejects duplicates or stale timestamps', () => {
  const guard = new AuthorityReplayGuard({ now: () => 10_000, skewMs: 1_000 });
  assert.equal(guard.accept('request-one', 10_000), true);
  assert.equal(guard.accept('request-one', 10_000), false);
  assert.equal(guard.accept('request-two', 8_000), false);
});
