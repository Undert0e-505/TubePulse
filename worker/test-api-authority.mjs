import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  BufferedKvNamespace,
  TubePulseAuthorityCoordinator,
  authoritySha256,
  authorityTestHelpers,
  createAuthorityWorker,
} from './tubepulse-api/authority.mjs';

const SECRET = 'synthetic-authority-secret-that-is-at-least-32-characters';
const DEVICE = 'synthetic-device-authority-test';

class MemoryKv {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
    this.reads = 0;
    this.writes = 0;
    this.failPutOnce = false;
  }
  async get(name, type = 'text') {
    this.reads++;
    const value = this.values.has(name) ? this.values.get(name) : null;
    return type === 'json' && value !== null ? JSON.parse(value) : value;
  }
  async put(name, value) {
    if (this.failPutOnce) { this.failPutOnce = false; throw new Error('synthetic-write-failure'); }
    this.writes++;
    this.values.set(name, String(value));
  }
  async delete(name) { this.writes++; this.values.delete(name); }
  async list() {
    return { keys: [...this.values.keys()].sort().map((name) => ({ name })), list_complete: true };
  }
}

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(name) { return this.values.get(name); }
  async put(name, value) { this.values.set(name, structuredClone(value)); }
  async delete(name) {
    if (Array.isArray(name)) {
      for (const key of name) this.values.delete(key);
      return;
    }
    this.values.delete(name);
  }
  async list({ prefix = '' } = {}) {
    return new Map([...this.values].filter(([name]) => name.startsWith(prefix)));
  }
  async blockConcurrencyWhile(operation) { return await operation(); }
}

function coordinatorFixture(entries = {}) {
  const kv = new MemoryKv(entries);
  const storage = new MemoryStorage();
  const coordinator = new TubePulseAuthorityCoordinator({ storage }, { TUBEPULSE_KV: kv });
  const namespace = {
    idFromName(name) { return name; },
    get() { return { fetch: (input, init) => coordinator.fetch(input instanceof Request ? input : new Request(input, init)) }; },
  };
  return { kv, storage, coordinator, namespace };
}

async function callCoordinator(coordinator, path, body, method = 'POST') {
  const response = await coordinator.fetch(new Request(`https://authority.test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }));
  return { response, payload: await response.json() };
}

async function seedCoordinator(fixture) {
  const snapshot = await callCoordinator(fixture.coordinator, '/snapshot', { leaseId: 'reconcile-synthetic-0001' });
  assert.equal(snapshot.response.status, 200);
  const activated = await callCoordinator(fixture.coordinator, '/activate', snapshot.payload);
  assert.equal(activated.response.status, 200);
  return snapshot.payload;
}

function authorityEnv(fixture, homeFetch, overrides = {}) {
  return {
    TUBEPULSE_KV: fixture.kv,
    TUBEPULSE_AUTHORITY_COORDINATOR: fixture.namespace,
    TUBEPULSE_HOME_AUTHORITY_ENABLED: 'true',
    TUBEPULSE_HOME_AUTHORITY_TRAFFIC_ENABLED: 'true',
    TUBEPULSE_HOME_AUTHORITY_TRANSPORT: 'vpc',
    TUBEPULSE_HOME_AUTHORITY_ORIGIN: 'http://gateway-origin:8788',
    TUBEPULSE_HOME_AUTHORITY_SECRET: SECRET,
    TUBEPULSE_HOME_AUTHORITY_TIMEOUT_MS: '500',
    TUBEPULSE_HOME_VPC: { fetch: homeFetch },
    ...overrides,
  };
}

function appRequest(path, body = {}) {
  return new Request(`https://api.example.test${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DEVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('feature off preserves the exact app request/response and performs no authority work', async () => {
  const originalResponse = new Response('unchanged', { status: 202 });
  const originalRequest = appRequest('/register');
  let received;
  let namespaceCalls = 0;
  const worker = createAuthorityWorker({ async fetch(request) { received = request; return originalResponse; } });
  const response = await worker.fetch(originalRequest, {
    TUBEPULSE_HOME_AUTHORITY_ENABLED: 'false',
    TUBEPULSE_AUTHORITY_COORDINATOR: { get() { namespaceCalls++; } },
  }, {});
  assert.equal(response, originalResponse);
  assert.equal(received, originalRequest);
  assert.equal(namespaceCalls, 0);
});

test('configured authority with traffic latch off exposes only signed controls and leaves app traffic unchanged', async () => {
  const fixture = coordinatorFixture();
  let calls = 0;
  let receivedEnv;
  const worker = createAuthorityWorker({ async fetch(_request, env) {
    calls++;
    receivedEnv = env;
    return new Response('unchanged', { status: 202 });
  } });
  const response = await worker.fetch(appRequest('/register'), authorityEnv(
    fixture,
    async () => { throw new Error('Home must not be called'); },
    { TUBEPULSE_HOME_AUTHORITY_TRAFFIC_ENABLED: 'false' },
  ), {});
  assert.equal(response.status, 202);
  assert.equal(await response.text(), 'unchanged');
  assert.equal(calls, 1);
  assert.equal(receivedEnv.TUBEPULSE_KV, fixture.kv);
  assert.equal(fixture.kv.reads, 0);
  assert.equal(fixture.kv.writes, 0);
});

test('active authority acknowledges legacy WebSub pushes without writes and disables verification persistence', async () => {
  const fixture = coordinatorFixture();
  await seedCoordinator(fixture);
  let calls = 0;
  const worker = createAuthorityWorker({ async fetch(request, env) {
    calls++;
    assert.equal(request.method, 'GET');
    assert.equal(env.TUBEPULSE_DISABLE_WEBSUB, 'true');
    return new Response('challenge', { status: 200 });
  } });
  const env = authorityEnv(fixture, async () => new Response('{}'));
  const push = await worker.fetch(new Request('https://api.example.test/websub', {
    method: 'POST', body: '<entry>synthetic</entry>',
  }), env, {});
  assert.equal(push.status, 200);
  assert.equal(await push.text(), 'OK');
  assert.equal(calls, 0);
  assert.equal(fixture.kv.writes, 0);
  const verification = await worker.fetch(new Request(
    'https://api.example.test/websub?hub.mode=subscribe&hub.topic=x&hub.challenge=challenge',
  ), env, {});
  assert.equal(verification.status, 200);
  assert.equal(calls, 1);
  assert.equal(fixture.kv.writes, 0);
});

test('enabled but invalid authority fails mutations and internal controls closed while reads remain available', async () => {
  let calls = 0;
  const worker = createAuthorityWorker({ async fetch() { calls++; return Response.json({ source: 'canonical' }); } }, {
    logger: { warn() {} },
  });
  const env = {
    TUBEPULSE_HOME_AUTHORITY_ENABLED: 'true',
    TUBEPULSE_HOME_AUTHORITY_TRAFFIC_ENABLED: 'true',
    TUBEPULSE_HOME_AUTHORITY_SECRET: 'short',
  };
  let response = await worker.fetch(appRequest('/register'), env, {});
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
  response = await worker.fetch(new Request('https://api.example.test/feed', {
    headers: { Authorization: `Bearer ${DEVICE}` },
  }), env, {});
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  response = await worker.fetch(new Request('https://api.example.test/_tubepulse/authority/status'), env, {});
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
});

test('buffered KV emits exact conditional deltas and does not mutate canonical storage', async () => {
  const canonical = new MemoryKv({ existing: 'old', same: 'value' });
  const buffered = new BufferedKvNamespace(canonical);
  await buffered.put('existing', 'new');
  await buffered.put('same', 'value');
  await buffered.put('created', 'fresh', { expiration: 2_000_000_000 });
  await buffered.delete('missing');
  const deltas = await buffered.deltas();
  assert.deepEqual(deltas.map(({ key, operation }) => ({ key, operation })), [
    { key: 'created', operation: 'put' },
    { key: 'existing', operation: 'put' },
  ]);
  assert.equal(deltas[0].baseHash, null);
  assert.equal(deltas[0].nextHash, await authoritySha256('fresh'));
  assert.equal(deltas[1].baseHash, await authoritySha256('old'));
  assert.equal(canonical.values.get('existing'), 'old');
  assert.equal(canonical.values.has('created'), false);
});

test('coordinator seeds a canonical baseline, applies conditional batches, and blocks genuine divergence', async () => {
  const fixture = coordinatorFixture({ alpha: 'one' });
  await seedCoordinator(fixture);
  let result = await callCoordinator(fixture.coordinator, '/acquire', { leaseId: 'publication-lease-0001', kind: 'publication' });
  assert.equal(result.response.status, 200);
  result = await callCoordinator(fixture.coordinator, '/commit', {
    leaseId: 'publication-lease-0001',
    deltas: [{
      key: 'alpha', operation: 'put', value: 'two',
      baseHash: await authoritySha256('one'), nextHash: await authoritySha256('two'), options: {},
    }],
  });
  assert.equal(result.response.status, 200);
  assert.equal(fixture.kv.values.get('alpha'), 'two');

  result = await callCoordinator(fixture.coordinator, '/acquire', { leaseId: 'publication-lease-0002', kind: 'publication' });
  assert.equal(result.response.status, 200);
  result = await callCoordinator(fixture.coordinator, '/commit', {
    leaseId: 'publication-lease-0002',
    deltas: [{
      key: 'alpha', operation: 'put', value: 'three',
      baseHash: await authoritySha256('wrong'), nextHash: await authoritySha256('three'), options: {},
    }],
  });
  assert.equal(result.response.status, 409);
  assert.equal(fixture.kv.values.get('alpha'), 'two');
  const status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.replication.status, 'stale');
  assert.equal(status.payload.replication.reason, 'canonical-baseline-diverged');
});

test('leased canonical snapshot can export exact values without exposing excluded records', async () => {
  const fixture = coordinatorFixture({ alpha: 'one', 'device:test:settings': '{"enabled":true}', 'fcm:cache:token': 'secret-cache' });
  const result = await callCoordinator(fixture.coordinator, '/snapshot', {
    leaseId: 'reconcile-export-values-0001', includeValues: true,
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.recordCount, 2);
  assert.deepEqual(result.payload.records.map(({ key }) => key), ['alpha', 'device:test:settings']);
  assert.equal(result.payload.records[0].value, 'one');
  assert.equal(result.payload.records[0].hash, await authoritySha256('one'));
  assert.equal(JSON.stringify(result.payload).includes('secret-cache'), false);
  assert.equal(fixture.kv.reads, 2);
});

test('an API mutation invalidates an unactivated snapshot and remains canonical', async () => {
  const fixture = coordinatorFixture({ alpha: 'one' });
  const snapshot = await callCoordinator(fixture.coordinator, '/snapshot', {
    leaseId: 'reconcile-overlap-snapshot-01', includeValues: true,
  });
  assert.equal(snapshot.response.status, 200);
  let result = await callCoordinator(fixture.coordinator, '/acquire', {
    leaseId: 'api-overlap-reconcile-0001', kind: 'api', neededKeys: ['alpha'],
  });
  assert.equal(result.response.status, 200);
  result = await callCoordinator(fixture.coordinator, '/commit', {
    leaseId: 'api-overlap-reconcile-0001',
    deltas: [{
      key: 'alpha', operation: 'put', value: 'two', options: {},
      baseHash: await authoritySha256('one'), nextHash: await authoritySha256('two'),
    }],
  });
  assert.equal(result.response.status, 200);
  assert.equal(fixture.kv.values.get('alpha'), 'two');
  result = await callCoordinator(fixture.coordinator, '/activate', snapshot.payload);
  assert.equal(result.response.status, 409);
  const status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.replication.status, 'stale');
  assert.equal(status.payload.replication.reason, 'reconciliation-overlapped');
});

test('cutover invalidation can explicitly clear a previously probed seed', async () => {
  const fixture = coordinatorFixture({ alpha: 'one' });
  await seedCoordinator(fixture);
  const stale = await callCoordinator(fixture.coordinator, '/stale', {
    reason: 'cutover-seed', clearSeeded: true,
  });
  assert.equal(stale.response.status, 200);
  const status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.replication.status, 'stale');
  assert.equal(status.payload.replication.seeded, false);
  assert.equal(status.payload.replication.recordCount, 0);
});

test('coordinator reserves Cloudflare KV headroom for app mutations and defers backup publication at its cap', async () => {
  const fixture = coordinatorFixture({ alpha: 'one', profile: 'old' });
  fixture.coordinator.env.TUBEPULSE_AUTHORITY_KV_PUBLICATION_CAP = '1';
  fixture.coordinator.env.TUBEPULSE_AUTHORITY_KV_WRITE_HARD_CAP = '3';
  await seedCoordinator(fixture);

  await callCoordinator(fixture.coordinator, '/acquire', { leaseId: 'publication-budget-001', kind: 'publication' });
  let result = await callCoordinator(fixture.coordinator, '/commit', {
    leaseId: 'publication-budget-001',
    deltas: [{ key: 'alpha', operation: 'put', value: 'two', options: {}, baseHash: await authoritySha256('one'), nextHash: await authoritySha256('two') }],
  });
  assert.equal(result.response.status, 200);

  await callCoordinator(fixture.coordinator, '/acquire', { leaseId: 'publication-budget-002', kind: 'publication' });
  result = await callCoordinator(fixture.coordinator, '/commit', {
    leaseId: 'publication-budget-002',
    deltas: [{ key: 'alpha', operation: 'put', value: 'three', options: {}, baseHash: await authoritySha256('two'), nextHash: await authoritySha256('three') }],
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.deferred, true);
  assert.equal(fixture.kv.values.get('alpha'), 'two');

  await callCoordinator(fixture.coordinator, '/acquire', { leaseId: 'api-budget-reserve-0001', kind: 'api' });
  result = await callCoordinator(fixture.coordinator, '/commit', {
    leaseId: 'api-budget-reserve-0001', observedKvReads: 1,
    deltas: [{ key: 'profile', operation: 'put', value: 'new', options: {}, baseHash: await authoritySha256('old'), nextHash: await authoritySha256('new') }],
  });
  assert.equal(result.response.status, 200);
  assert.equal(fixture.kv.values.get('profile'), 'new');
  const status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.quota.publicationWrites, 1);
  assert.equal(status.payload.quota.apiWrites, 1);
  assert.equal(status.payload.quota.kvReads >= 3, true);
  assert.equal(status.payload.quota.limits.apiReserve, 99);
  assert.equal(status.payload.pendingBackupKeys, 1, 'unrelated deferred backup remains coalesced');
});

test('same-key /seen mutation flushes a deferred scheduler value before canonical execution and keeps Home current', async () => {
  const stateKey = `device:${DEVICE}:state:UCsamekey0000000000000000`;
  const canonicalOld = JSON.stringify({ unwatched: ['old-video'], lastNagAt: null, nagCount: 0 });
  const schedulerNew = JSON.stringify({ unwatched: ['new-video', 'old-video'], lastNagAt: null, nagCount: 0 });
  const appFinal = JSON.stringify({ unwatched: ['new-video'], lastNagAt: null, nagCount: 0 });
  const fixture = coordinatorFixture({ [stateKey]: canonicalOld });
  fixture.coordinator.env.TUBEPULSE_AUTHORITY_KV_PUBLICATION_CAP = '0';
  fixture.coordinator.env.TUBEPULSE_AUTHORITY_KV_WRITE_HARD_CAP = '100';
  await seedCoordinator(fixture);
  await callCoordinator(fixture.coordinator, '/acquire', { leaseId: 'publication-deferred-seen', kind: 'publication' });
  let result = await callCoordinator(fixture.coordinator, '/commit', {
    leaseId: 'publication-deferred-seen',
    deltas: [{
      key: stateKey, operation: 'put', value: schedulerNew, options: {},
      baseHash: await authoritySha256(canonicalOld), nextHash: await authoritySha256(schedulerNew),
    }],
  });
  assert.equal(result.payload.deferred, true);
  assert.equal(fixture.kv.values.get(stateKey), canonicalOld);

  let homeValue = schedulerNew;
  const homeFetch = async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/preflight')) return Response.json({ ok: true });
    if (path.endsWith('/commit')) {
      const body = await request.json();
      assert.equal(body.deltas.length, 1);
      assert.equal(body.deltas[0].baseHash, await authoritySha256(schedulerNew));
      homeValue = body.deltas[0].value;
      return Response.json({ ok: true });
    }
    if (path.endsWith('/cancel')) return Response.json({ ok: true });
    throw new Error(`unexpected Home path ${path}`);
  };
  const appWorker = {
    async fetch(request, env) {
      const body = await request.json();
      const current = await env.TUBEPULSE_KV.get(`device:${DEVICE}:state:${body.channelId}`, 'json');
      assert.deepEqual(current.unwatched, ['new-video', 'old-video']);
      current.unwatched = current.unwatched.filter((id) => id !== 'old-video');
      await env.TUBEPULSE_KV.put(stateKey, JSON.stringify(current));
      return Response.json({ ok: true });
    },
  };
  const worker = createAuthorityWorker(appWorker);
  const response = await worker.fetch(appRequest('/seen', {
    channelId: 'UCsamekey0000000000000000', videoIds: ['old-video'],
  }), authorityEnv(fixture, homeFetch), {});
  assert.equal(response.status, 200);
  assert.equal(fixture.kv.values.get(stateKey), appFinal);
  assert.equal(homeValue, appFinal);
  const status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.replication.status, 'current');
  assert.equal(status.payload.pendingBackupKeys, 0);
});

test('partial canonical batch is durably resumed before another lease is admitted', async () => {
  const fixture = coordinatorFixture({ alpha: 'one', beta: 'one' });
  await seedCoordinator(fixture);
  let result = await callCoordinator(fixture.coordinator, '/acquire', { leaseId: 'publication-crash-0001', kind: 'publication' });
  assert.equal(result.response.status, 200);
  let writes = 0;
  const originalPut = fixture.kv.put.bind(fixture.kv);
  fixture.kv.put = async (...args) => {
    writes++;
    if (writes === 2) throw new Error('synthetic-mid-batch-crash');
    return await originalPut(...args);
  };
  result = await callCoordinator(fixture.coordinator, '/commit', {
    leaseId: 'publication-crash-0001',
    deltas: [
      { key: 'alpha', operation: 'put', value: 'two', baseHash: await authoritySha256('one'), nextHash: await authoritySha256('two'), options: {} },
      { key: 'beta', operation: 'put', value: 'two', baseHash: await authoritySha256('one'), nextHash: await authoritySha256('two'), options: {} },
    ],
  });
  assert.equal(result.response.status, 503);
  assert.equal(fixture.kv.values.get('alpha'), 'two');
  assert.equal(fixture.kv.values.get('beta'), 'one');
  fixture.kv.put = originalPut;
  // Expire the persisted lease to simulate a process/request crash. Acquire
  // must recover the stored transaction before considering the new writer.
  const oldLease = fixture.storage.values.get('authority:lease');
  fixture.storage.values.set('authority:lease', { ...oldLease, expiresAt: Date.now() - 1 });
  result = await callCoordinator(fixture.coordinator, '/acquire', { leaseId: 'api-after-recovery-01', kind: 'api' });
  assert.equal(result.response.status, 200);
  assert.equal(fixture.kv.values.get('beta'), 'two');
  assert.equal(fixture.storage.values.has('authority:transaction'), false);
});

test('retained publication lease spans multiple committed batches without exposing a transaction', async () => {
  const fixture = coordinatorFixture({ alpha: 'one' });
  await seedCoordinator(fixture);
  let result = await callCoordinator(fixture.coordinator, '/acquire', {
    leaseId: 'publication-retained-001', kind: 'publication',
  });
  assert.equal(result.response.status, 200);
  result = await callCoordinator(fixture.coordinator, '/commit', {
    leaseId: 'publication-retained-001', retainLease: true,
    deltas: [{ key: 'alpha', operation: 'put', value: 'two', options: {}, baseHash: await authoritySha256('one'), nextHash: await authoritySha256('two') }],
  });
  assert.equal(result.response.status, 200);
  let status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.transaction, null);
  assert.equal(status.payload.lease.kind, 'publication');
  result = await callCoordinator(fixture.coordinator, '/commit', {
    leaseId: 'publication-retained-001',
    deltas: [{ key: 'alpha', operation: 'put', value: 'three', options: {}, baseHash: await authoritySha256('two'), nextHash: await authoritySha256('three') }],
  });
  assert.equal(result.response.status, 200);
  status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.lease, null);
  assert.equal(fixture.kv.values.get('alpha'), 'three');
});

test('feed waits out partial transactions but remains readable during a retained post-publication lease', async () => {
  const fixture = coordinatorFixture({ alpha: 'one' });
  await seedCoordinator(fixture);
  let appCalls = 0;
  const worker = createAuthorityWorker({
    async fetch() { appCalls++; return Response.json({ channels: [], source: 'canonical' }); },
  }, { logger: { warn() {} } });
  const env = authorityEnv(fixture, async () => Response.json({ ok: true }), {
    TUBEPULSE_HOME_AUTHORITY_TIMEOUT_MS: '50',
  });
  const feed = () => worker.fetch(new Request('https://api.example.test/feed', {
    headers: { Authorization: `Bearer ${DEVICE}` },
  }), env, {});
  fixture.storage.values.set('authority:transaction', {
    id: 'partial', kind: 'publication', count: 1, nextIndex: 0, retainLease: true,
  });
  let response = await feed();
  assert.equal(response.status, 503);
  assert.equal(appCalls, 0);
  fixture.storage.values.delete('authority:transaction');
  fixture.storage.values.set('authority:lease', {
    leaseId: 'retained-publication', kind: 'publication', expiresAt: Date.now() + 60_000,
  });
  response = await feed();
  assert.equal(response.status, 200);
  assert.equal(appCalls, 1);
});

test('every authenticated device reads the unified Home store with canonical fallback on outage or stale state', async () => {
  const fixture = coordinatorFixture({ alpha: 'one' });
  await seedCoordinator(fixture);
  let canonicalCalls = 0;
  let homeCalls = 0;
  const worker = createAuthorityWorker({
    async fetch() { canonicalCalls++; return Response.json({ channels: [], source: 'cloudflare' }); },
  }, { logger: { warn() {} } });
  const homeFetch = async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    homeCalls++;
    assert.equal(new URL(request.url).pathname, '/_tubepulse/authority/feed');
    assert.match(request.headers.get('X-TubePulse-Authority-Signature'), /^[a-f0-9]{64}$/);
    const device = request.headers.get('Authorization')?.slice(7);
    return Response.json({ channels: [], source: `home:${device}` });
  };
  const env = authorityEnv(fixture, homeFetch);
  for (const device of ['synthetic-device-one', 'synthetic-device-two']) {
    const response = await worker.fetch(new Request('https://api.example.test/feed', {
      headers: { Authorization: `Bearer ${device}` },
    }), env, {});
    assert.equal((await response.json()).source, `home:${device}`);
    assert.equal(response.headers.get('X-TubePulse-Authority-Route'), 'home');
  }
  assert.equal(canonicalCalls, 0);
  assert.equal(homeCalls, 2);

  env.TUBEPULSE_HOME_VPC = { async fetch() { homeCalls++; return Response.json({ error: 'offline' }, { status: 503 }); } };
  let response = await worker.fetch(new Request('https://api.example.test/feed', {
    headers: { Authorization: 'Bearer synthetic-device-three' },
  }), env, {});
  assert.equal((await response.json()).source, 'cloudflare');
  assert.equal(response.headers.get('X-TubePulse-Authority-Route'), 'cloudflare');

  await callCoordinator(fixture.coordinator, '/stale', { reason: 'synthetic-home-outage' });
  const before = homeCalls;
  response = await worker.fetch(new Request('https://api.example.test/feed', {
    headers: { Authorization: 'Bearer synthetic-device-four' },
  }), env, {});
  assert.equal((await response.json()).source, 'cloudflare');
  assert.equal(homeCalls, before, 'stale Home must not receive app reads');
});

test('Home read semantic authentication errors are preserved instead of hidden by fallback', async () => {
  const fixture = coordinatorFixture();
  await seedCoordinator(fixture);
  let canonicalCalls = 0;
  const worker = createAuthorityWorker({
    async fetch() { canonicalCalls++; return Response.json({ channels: [] }); },
  }, { logger: { warn() {} } });
  const env = authorityEnv(fixture, async () => Response.json({ error: 'Authenticated device identity required' }, { status: 401 }));
  const response = await worker.fetch(new Request('https://api.example.test/feed'), env, {});
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('X-TubePulse-Authority-Route'), 'home');
  assert.equal(canonicalCalls, 0);
});

test('feed seqlock discards a response spanning a canonical version change and retries', async () => {
  const fixture = coordinatorFixture();
  await seedCoordinator(fixture);
  await callCoordinator(fixture.coordinator, '/stale', { reason: 'force-canonical-fallback' });
  let appCalls = 0;
  const worker = createAuthorityWorker({
    async fetch() {
      appCalls++;
      if (appCalls === 1) {
        const state = fixture.storage.values.get('authority:state');
        fixture.storage.values.set('authority:state', { ...state, canonicalVersion: Number(state.canonicalVersion || 0) + 1 });
      }
      return Response.json({ channels: [], attempt: appCalls });
    },
  }, { logger: { warn() {} } });
  const response = await worker.fetch(new Request('https://api.example.test/feed', {
    headers: { Authorization: `Bearer ${DEVICE}` },
  }), authorityEnv(fixture, async () => { throw new Error('stale Home must not be called'); }), {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).attempt, 2);
  assert.equal(appCalls, 2);
});

test('all authenticated devices use Cloudflare-first exact delta replication', async () => {
  const fixture = coordinatorFixture({ 'device:one:settings': '{"old":true}' });
  await seedCoordinator(fixture);
  const events = [];
  const appWorker = {
    async fetch(request, env) {
      events.push('canonical-handler');
      assert.match(request.headers.get('Authorization'), /^Bearer /);
      await env.TUBEPULSE_KV.put('device:one:settings', '{"old":false}');
      await env.TUBEPULSE_KV.put('device:one:channels', '["UC1"]');
      return Response.json({ ok: true });
    },
  };
  const homeFetch = async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    const body = await request.json();
    events.push(new URL(request.url).pathname.endsWith('/preflight') ? 'home-preflight' : 'home-commit');
    if (body.deltas) assert.deepEqual(body.deltas.map((delta) => delta.key), ['device:one:channels', 'device:one:settings']);
    return Response.json({ ok: true });
  };
  const worker = createAuthorityWorker(appWorker, { logger: { warn() {} } });
  const response = await worker.fetch(appRequest('/settings'), authorityEnv(fixture, homeFetch), {});
  assert.equal(response.status, 200);
  assert.deepEqual(events, ['home-preflight', 'canonical-handler', 'home-commit']);
  assert.equal(fixture.kv.values.get('device:one:settings'), '{"old":false}');
  assert.equal(fixture.kv.values.get('device:one:channels'), '["UC1"]');
});

test('Home preflight outage does not break canonical mutation but makes authority globally stale', async () => {
  const fixture = coordinatorFixture({ value: 'old' });
  await seedCoordinator(fixture);
  const worker = createAuthorityWorker({
    async fetch(_request, env) { await env.TUBEPULSE_KV.put('value', 'new'); return Response.json({ ok: true }); },
  }, { logger: { warn() {} } });
  const response = await worker.fetch(appRequest('/register'), authorityEnv(fixture, async () => {
    throw new Error('Home offline');
  }), {});
  assert.equal(response.status, 200);
  assert.equal(fixture.kv.values.get('value'), 'new');
  const status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.replication.status, 'stale');
  assert.equal(status.payload.replication.reason, 'home-preflight-unavailable');
  const publication = await callCoordinator(fixture.coordinator, '/acquire', {
    leaseId: 'publication-while-stale', kind: 'publication',
  });
  assert.equal(publication.response.status, 409);
});

test('failure to durably mark Home stale aborts before the canonical handler and releases the lease', async () => {
  const fixture = coordinatorFixture({ value: 'old' });
  await seedCoordinator(fixture);
  let appCalls = 0;
  const realNamespace = fixture.namespace;
  const failingNamespace = {
    idFromName: (name) => realNamespace.idFromName(name),
    get(id) {
      const stub = realNamespace.get(id);
      return {
        async fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          if (new URL(request.url).pathname === '/stale') throw new Error('synthetic-stale-write-failure');
          return await stub.fetch(request);
        },
      };
    },
  };
  const worker = createAuthorityWorker({
    async fetch(_request, env) { appCalls++; await env.TUBEPULSE_KV.put('value', 'unsafe'); return Response.json({ ok: true }); },
  }, { logger: { warn() {} } });
  const response = await worker.fetch(appRequest('/register'), authorityEnv(fixture, async () => {
    throw new Error('Home offline');
  }, { TUBEPULSE_AUTHORITY_COORDINATOR: failingNamespace }), {});
  assert.equal(response.status, 503);
  assert.equal(appCalls, 0);
  assert.equal(fixture.kv.values.get('value'), 'old');
  const status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.lease, null);
});

test('semantic errors and failed waitUntil work discard buffered writes', async (t) => {
  await t.test('semantic error', async () => {
    const fixture = coordinatorFixture({ value: 'old' });
    await seedCoordinator(fixture);
    const worker = createAuthorityWorker({
      async fetch(_request, env) { await env.TUBEPULSE_KV.put('value', 'hidden'); return Response.json({ error: 'bad' }, { status: 422 }); },
    }, { logger: { warn() {} } });
    const response = await worker.fetch(appRequest('/settings'), authorityEnv(fixture, async () => Response.json({ ok: true })), {});
    assert.equal(response.status, 422);
    assert.equal(fixture.kv.values.get('value'), 'old');
  });
  await t.test('waitUntil rejection', async () => {
    const fixture = coordinatorFixture({ value: 'old' });
    await seedCoordinator(fixture);
    const worker = createAuthorityWorker({
      async fetch(_request, env, ctx) {
        await env.TUBEPULSE_KV.put('value', 'hidden');
        ctx.waitUntil(Promise.reject(new Error('background-write-intent-failed')));
        return Response.json({ ok: true });
      },
    }, { logger: { warn() {} } });
    const response = await worker.fetch(appRequest('/register'), authorityEnv(fixture, async () => Response.json({ ok: true })), {});
    assert.equal(response.status, 500);
    assert.equal(fixture.kv.values.get('value'), 'old');
  });
});

test('coordinator outage fails a mutation closed before running the app handler', async () => {
  const fixture = coordinatorFixture();
  let appCalls = 0;
  const worker = createAuthorityWorker({ async fetch() { appCalls++; return Response.json({ ok: true }); } }, {
    logger: { warn() {} },
  });
  const env = authorityEnv(fixture, async () => Response.json({ ok: true }), {
    TUBEPULSE_AUTHORITY_COORDINATOR: {
      idFromName(name) { return name; },
      get() { return { async fetch() { throw new Error('DO unavailable'); } }; },
    },
  });
  const response = await worker.fetch(appRequest('/seen'), env, {});
  assert.equal(response.status, 503);
  assert.equal(appCalls, 0);
});

test('authority canonical signatures are stable and body/authorization sensitive', async () => {
  const base = {
    timestamp: 1, requestId: 'synthetic-request-0001', operation: 'authority-commit',
    method: 'POST', target: '/_tubepulse/authority/commit',
    authorizationDigest: crypto.createHash('sha256').update('Bearer one').digest('hex'),
    bodyDigest: crypto.createHash('sha256').update('{}').digest('hex'),
  };
  const first = authorityTestHelpers.authorityCanonical(base);
  const second = authorityTestHelpers.authorityCanonical({ ...base, bodyDigest: await authoritySha256('{"x":1}') });
  assert.notEqual(first, second);
});
