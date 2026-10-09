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
import { d1KvTestHelpers } from './tubepulse-api/d1-kv.mjs';
import { FakeD1 } from './test-support/fake-d1.mjs';

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

function d1CoordinatorFixture(entries = {}, generation = 'production-v1') {
  const kv = new MemoryKv(entries);
  const database = new FakeD1();
  const storage = new MemoryStorage();
  const env = {
    TUBEPULSE_KV: kv,
    TUBEPULSE_D1: database,
    TUBEPULSE_CANONICAL_BACKEND: 'd1',
    TUBEPULSE_CANONICAL_BACKEND_GENERATION: generation,
  };
  const coordinator = new TubePulseAuthorityCoordinator({ storage }, env);
  return { kv, database, storage, env, coordinator };
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

function capturingContext() {
  const promises = [];
  return {
    waitUntil(promise) { promises.push(Promise.resolve(promise)); },
    async flush() { await Promise.all(promises); },
  };
}

async function signedInternalRequest(path, operation, body, overrides = {}) {
  const bodyText = JSON.stringify(body);
  const timestamp = overrides.timestamp ?? Date.now();
  const requestId = overrides.requestId || `synthetic-probe-${crypto.randomUUID()}`;
  const bodyDigest = await authoritySha256(bodyText);
  const authorizationDigest = await authoritySha256('');
  const canonical = authorityTestHelpers.authorityCanonical({
    timestamp,
    requestId,
    operation,
    method: 'POST',
    target: path,
    authorizationDigest,
    bodyDigest,
  });
  const signature = crypto.createHmac('sha256', SECRET).update(canonical).digest('hex');
  return new Request(`https://api.example.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-TubePulse-Authority-Version': '1',
      'X-TubePulse-Authority-Timestamp': String(timestamp),
      'X-TubePulse-Authority-Request-Id': requestId,
      'X-TubePulse-Authority-Operation': operation,
      'X-TubePulse-Authority-Body-SHA256': bodyDigest,
      'X-TubePulse-Authority-Signature': overrides.signature || signature,
    },
    body: bodyText,
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

test('signed RSS probe uses only fixed YouTube feed URLs and performs no KV or coordinator operation', async () => {
  const fixture = coordinatorFixture();
  const requested = [];
  let appCalls = 0;
  const worker = createAuthorityWorker({ async fetch() { appCalls++; return new Response('unexpected'); } }, {
    rssProbeFetch: async (url) => {
      const parsed = new URL(url);
      requested.push(parsed);
      const channelId = parsed.searchParams.get('channel_id');
      return new Response(`<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><yt:channelId>${channelId}</yt:channelId></feed>`, {
        headers: { 'Content-Type': 'application/atom+xml' },
      });
    },
  });
  const before = { reads: fixture.kv.reads, writes: fixture.kv.writes };
  const activeChannelId = 'UC0000000000000000000000';
  const request = await signedInternalRequest(
    '/_tubepulse/authority/rss-probe', 'authority-rss-probe', { activeChannelId },
  );
  const response = await worker.fetch(request, authorityEnv(fixture, async () => { throw new Error('Home must not be called'); }), {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.outcome, 'success');
  assert.equal(payload.probes.length, 2);
  assert.equal(appCalls, 0);
  assert.deepEqual({ reads: fixture.kv.reads, writes: fixture.kv.writes }, before);
  assert.equal(requested.length, 2);
  for (const url of requested) {
    assert.equal(url.origin, 'https://www.youtube.com');
    assert.equal(url.pathname, '/feeds/videos.xml');
    assert.deepEqual([...url.searchParams.keys()], ['channel_id']);
  }
  assert.equal(payload.probes.some((probe) => Object.values(probe).includes(activeChannelId)), false);
});

test('RSS probe requires valid HMAC, rejects replay/arbitrary targets, and classifies bounded failures', async () => {
  const fixture = coordinatorFixture();
  let fetchCalls = 0;
  const worker = createAuthorityWorker({ async fetch() { throw new Error('must not run'); } }, {
    rssProbeFetch: async () => { fetchCalls++; return new Response('not found', { status: 404 }); },
  });
  const env = authorityEnv(fixture, async () => { throw new Error('Home must not be called'); });
  const path = '/_tubepulse/authority/rss-probe';
  const requestId = 'synthetic-probe-replay-0001';
  let request = await signedInternalRequest(path, 'authority-rss-probe', {}, { requestId });
  let response = await worker.fetch(request, env, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).outcome, 'failure');
  assert.equal(fetchCalls, 1);

  request = await signedInternalRequest(path, 'authority-rss-probe', {}, { requestId });
  response = await worker.fetch(request, env, {});
  assert.equal(response.status, 401);
  assert.equal(fetchCalls, 1);

  request = await signedInternalRequest(path, 'authority-rss-probe', { url: 'https://example.test/' });
  response = await worker.fetch(request, env, {});
  assert.equal(response.status, 400);
  assert.equal(fetchCalls, 1);

  request = await signedInternalRequest(path, 'authority-rss-probe', {}, { signature: '0'.repeat(64) });
  response = await worker.fetch(request, env, {});
  assert.equal(response.status, 401);
  assert.equal(fetchCalls, 1);
});

test('RSS probe returns independent inability on subrequest network errors and rejects oversized bodies before fetch', async () => {
  const fixture = coordinatorFixture();
  let fetchCalls = 0;
  const worker = createAuthorityWorker({ async fetch() { throw new Error('must not run'); } }, {
    rssProbeFetch: async () => { fetchCalls++; throw new Error('network unavailable'); },
  });
  const env = authorityEnv(fixture, async () => { throw new Error('Home must not be called'); });
  const path = '/_tubepulse/authority/rss-probe';
  let request = await signedInternalRequest(path, 'authority-rss-probe', {});
  let response = await worker.fetch(request, env, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).outcome, 'failure');
  assert.equal(fetchCalls, 1);

  const body = JSON.stringify({ activeChannelId: 'x'.repeat(authorityTestHelpers.RSS_PROBE_MAX_BODY_BYTES + 100) });
  request = new Request(`https://api.example.test${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  response = await worker.fetch(request, env, {});
  assert.equal(response.status, 413);
  assert.equal(fetchCalls, 1);
});

test('RSS probe bounds upstream response size and timeout without returning content', async () => {
  const fixture = coordinatorFixture();
  const path = '/_tubepulse/authority/rss-probe';
  const oversizedWorker = createAuthorityWorker({ async fetch() { throw new Error('must not run'); } }, {
    rssProbeFetch: async () => new Response('x'.repeat(authorityTestHelpers.RSS_PROBE_MAX_RESPONSE_BYTES + 1)),
  });
  let response = await oversizedWorker.fetch(
    await signedInternalRequest(path, 'authority-rss-probe', {}),
    authorityEnv(fixture, async () => { throw new Error('Home must not be called'); }),
    {},
  );
  let payload = await response.json();
  assert.equal(payload.outcome, 'failure');
  assert.equal(payload.probes[0].classification, 'response-too-large');
  assert.equal(Object.hasOwn(payload.probes[0], 'body'), false);

  const timeoutWorker = createAuthorityWorker({ async fetch() { throw new Error('must not run'); } }, {
    rssProbeFetch: async (_url, init) => await new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  response = await timeoutWorker.fetch(
    await signedInternalRequest(path, 'authority-rss-probe', {}),
    authorityEnv(fixture, async () => { throw new Error('Home must not be called'); }),
    {},
  );
  payload = await response.json();
  assert.equal(payload.outcome, 'failure');
  assert.equal(payload.probes[0].classification, 'timeout');
});

test('RSS redirects stop at fixed URLs without forwarding credentials, following or exposing Location/body', async () => {
  const fixture = coordinatorFixture();
  let fetchCalls = 0;
  const worker = createAuthorityWorker({ async fetch() { throw new Error('must not run'); } }, {
    rssProbeFetch: async (url, init) => {
      fetchCalls++;
      assert.equal(new URL(url).origin, 'https://www.youtube.com');
      assert.equal(init.redirect, 'manual');
      assert.deepEqual(Object.keys(init.headers), ['Accept']);
      return new Response('private upstream body', { status: 302, headers: { Location: 'https://evil.test/private-token' } });
    },
  });
  const response = await worker.fetch(
    await signedInternalRequest('/_tubepulse/authority/rss-probe', 'authority-rss-probe', { activeChannelId: 'UC0000000000000000000000' }),
    authorityEnv(fixture, async () => { throw new Error('Home must not run'); }), {},
  );
  const payload = await response.json();
  assert.equal(fetchCalls, 2);
  assert.equal(payload.outcome, 'failure');
  assert.ok(payload.probes.every((entry) => entry.classification === 'redirect' && entry.status === 302));
  assert.equal(JSON.stringify(payload).includes('private'), false);
  assert.equal(JSON.stringify(payload).includes('evil.test'), false);
  assert.equal(response.headers.has('Location'), false);
});

test('a valid remote feed cancels mixed unavailable subrequests and malformed XML never counts as valid', async () => {
  const fixture = coordinatorFixture();
  const active = 'UC0000000000000000000000';
  const worker = createAuthorityWorker({ async fetch() { throw new Error('must not run'); } }, {
    rssProbeFetch: async (url) => {
      const channel = new URL(url).searchParams.get('channel_id');
      return new Response(channel === active ? `<feed><yt:channelId>${channel}</yt:channelId></feed>` : '<feed><yt:channelId>wrong</yt:channelId>');
    },
  });
  const response = await worker.fetch(
    await signedInternalRequest('/_tubepulse/authority/rss-probe', 'authority-rss-probe', { activeChannelId: active }),
    authorityEnv(fixture, async () => { throw new Error('Home must not run'); }), {},
  );
  const payload = await response.json();
  assert.equal(payload.outcome, 'success');
  assert.equal(payload.probes[0].classification, 'invalid-xml');
  assert.equal(payload.probes[1].classification, 'valid-feed');
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

test('coordinator defaults to a 900 publication cap with a 50-write API reserve', async () => {
  const fixture = coordinatorFixture({ alpha: 'one', beta: 'one' });
  await seedCoordinator(fixture);

  let status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.deepEqual(status.payload.quota.limits, {
    total: 950,
    publication: 900,
    apiReserve: 50,
  });

  await fixture.storage.put('authority:quota', {
    day: new Date().toISOString().slice(0, 10),
    kvWrites: 899,
    publicationWrites: 899,
    apiWrites: 0,
    kvReads: 0,
    kvLists: 0,
    doRequests: 0,
  });
  await callCoordinator(fixture.coordinator, '/acquire', {
    leaseId: 'default-publication-limit-0900', kind: 'publication',
  });
  let result = await callCoordinator(fixture.coordinator, '/commit', {
    leaseId: 'default-publication-limit-0900',
    deltas: [{
      key: 'alpha', operation: 'put', value: 'two', options: {},
      baseHash: await authoritySha256('one'), nextHash: await authoritySha256('two'),
    }],
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.deferred, false);
  assert.equal(fixture.kv.values.get('alpha'), 'two');

  await callCoordinator(fixture.coordinator, '/acquire', {
    leaseId: 'default-publication-limit-0901', kind: 'publication',
  });
  result = await callCoordinator(fixture.coordinator, '/commit', {
    leaseId: 'default-publication-limit-0901',
    deltas: [{
      key: 'beta', operation: 'put', value: 'two', options: {},
      baseHash: await authoritySha256('one'), nextHash: await authoritySha256('two'),
    }],
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.deferred, true);
  assert.equal(result.payload.reason, 'publication-cap');
  assert.equal(fixture.kv.values.get('beta'), 'one');

  status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.quota.publicationWrites, 900);
  assert.equal(status.payload.pendingBackupKeys, 1);
});

test('configured publication cap cannot exceed the total hard cap', async () => {
  const fixture = coordinatorFixture();
  fixture.coordinator.env.TUBEPULSE_AUTHORITY_KV_PUBLICATION_CAP = '1200';
  fixture.coordinator.env.TUBEPULSE_AUTHORITY_KV_WRITE_HARD_CAP = '950';
  const status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.deepEqual(status.payload.quota.limits, {
    total: 950,
    publication: 950,
    apiReserve: 0,
  });
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

test('Home-first /seen coalesces over a deferred scheduler value without touching Cloudflare KV', async () => {
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

  const readsBeforeMutation = fixture.kv.reads;
  const writesBeforeMutation = fixture.kv.writes;
  const homeFetch = async (request) => {
    const path = new URL(request.url).pathname;
    assert.equal(path, '/_tubepulse/authority/mutation');
    const body = await request.json();
    assert.equal(body.path, '/seen');
    return Response.json({
      ok: true,
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true,"unwatchedCount":1}' },
      deltas: [{
        key: stateKey, operation: 'put', value: appFinal, options: {},
        baseHash: await authoritySha256(schedulerNew), nextHash: await authoritySha256(appFinal),
      }],
    });
  };
  const appWorker = {
    async fetch() { throw new Error('Cloudflare app handler must not run for Home-primary mutations'); },
  };
  const worker = createAuthorityWorker(appWorker);
  const response = await worker.fetch(appRequest('/seen', {
    channelId: 'UCsamekey0000000000000000', videoIds: ['old-video'],
  }), authorityEnv(fixture, homeFetch), {});
  assert.equal(response.status, 200);
  assert.equal(fixture.kv.values.get(stateKey), canonicalOld);
  assert.equal(fixture.kv.reads, readsBeforeMutation);
  assert.equal(fixture.kv.writes, writesBeforeMutation);
  const status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.replication.status, 'current');
  assert.equal(status.payload.pendingBackupKeys, 1);
  const pending = [...fixture.storage.values.values()].find((value) => value?.delta?.key === stateKey)?.delta;
  assert.equal(pending.baseHash, await authoritySha256(canonicalOld));
  assert.equal(pending.nextHash, await authoritySha256(appFinal));
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

test('successful authenticated feed contact schedules one throttled coordinated activity touch', async () => {
  const fixture = coordinatorFixture();
  await seedCoordinator(fixture);
  let feedCalls = 0;
  let touchCalls = 0;
  const homeFetch = async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    if (new URL(request.url).pathname === '/_tubepulse/authority/feed') {
      feedCalls++;
      return Response.json({ channels: [], source: 'home' });
    }
    const body = await request.json();
    assert.equal(body.path, '/_tubepulse/activity-touch');
    touchCalls++;
    return Response.json({
      ok: true,
      response: {
        status: 200, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true, touched: false, retryAfterMs: 60 * 60 * 1000 }),
      },
      deltas: [],
    });
  };
  const worker = createAuthorityWorker({
    async fetch() { throw new Error('canonical fallback must not run'); },
  }, { logger: { warn() {} } });
  const env = authorityEnv(fixture, homeFetch);
  const context = capturingContext();
  const feed = () => worker.fetch(new Request('https://api.example.test/feed', {
    headers: { Authorization: `Bearer ${DEVICE}` },
  }), env, context);

  const responses = await Promise.all([feed(), feed()]);
  assert.equal(responses.every((response) => response.status === 200), true);
  await context.flush();
  assert.equal(feedCalls, 2);
  assert.equal(touchCalls, 1, 'concurrent contacts must share one in-flight activity touch');

  const laterContext = capturingContext();
  const later = await worker.fetch(new Request('https://api.example.test/feed', {
    headers: { Authorization: `Bearer ${DEVICE}` },
  }), env, laterContext);
  assert.equal(later.status, 200);
  await laterContext.flush();
  assert.equal(touchCalls, 1, 'the Home-provided retry window suppresses repeated no-op coordination');
});

test('activity touch failure never changes a successful primary response', async () => {
  const fixture = coordinatorFixture();
  await seedCoordinator(fixture);
  let warnings = 0;
  const worker = createAuthorityWorker({
    async fetch() { throw new Error('canonical fallback must not run'); },
  }, { logger: { warn() { warnings++; } } });
  const env = authorityEnv(fixture, async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    if (new URL(request.url).pathname === '/_tubepulse/authority/feed') {
      return Response.json({ channels: [], source: 'home' });
    }
    throw new Error('synthetic activity origin failure');
  });
  const context = capturingContext();
  const response = await worker.fetch(new Request('https://api.example.test/feed', {
    headers: { Authorization: `Bearer ${DEVICE}` },
  }), env, context);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { channels: [], source: 'home' });
  await context.flush();
  assert.equal(warnings, 1);
  const status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.lease, null);
  assert.equal(status.payload.pendingBackupKeys, 0);
});

test('unauthenticated, unknown and internal routes do not schedule activity touches', async () => {
  const fixture = coordinatorFixture();
  await seedCoordinator(fixture);
  let touchCalls = 0;
  const worker = createAuthorityWorker({
    async fetch() { return Response.json({ ok: true }); },
  }, { logger: { warn() {} } });
  const env = authorityEnv(fixture, async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    if (new URL(request.url).pathname === '/_tubepulse/authority/feed') {
      return Response.json({ error: 'Authenticated device identity required' }, { status: 401 });
    }
    touchCalls++;
    return Response.json({ error: 'unexpected' }, { status: 500 });
  });
  const context = capturingContext();
  const unauthenticated = await worker.fetch(new Request('https://api.example.test/feed'), env, context);
  assert.equal(unauthenticated.status, 401);
  const unknown = await worker.fetch(new Request('https://api.example.test/unknown', {
    headers: { Authorization: `Bearer ${DEVICE}` },
  }), env, context);
  assert.equal(unknown.status, 200);
  const root = await worker.fetch(new Request('https://api.example.test/'), env, context);
  assert.equal(root.status, 200);
  await context.flush();
  assert.equal(touchCalls, 0);
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

test('authenticated mutations use Home responses and durably defer exact Cloudflare backup', async () => {
  const fixture = coordinatorFixture({ 'device:one:settings': '{"old":true}' });
  await seedCoordinator(fixture);
  const readsBefore = fixture.kv.reads;
  const writesBefore = fixture.kv.writes;
  fixture.kv.get = async () => { throw new Error('KV get() limit exceeded for the day'); };
  const events = [];
  const appWorker = {
    async fetch() { events.push('cloudflare-handler'); throw new Error('Cloudflare handler must not run'); },
  };
  const homeFetch = async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    const body = await request.json();
    events.push('home-mutation');
    assert.equal(new URL(request.url).pathname, '/_tubepulse/authority/mutation');
    assert.equal(body.path, '/settings');
    return Response.json({
      ok: true,
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
      deltas: [{
        key: 'device:one:settings', operation: 'put', value: '{"old":false}', options: {},
        baseHash: await authoritySha256('{"old":true}'), nextHash: await authoritySha256('{"old":false}'),
      }, {
        key: 'device:one:channels', operation: 'put', value: '["UC1"]', options: {},
        baseHash: null, nextHash: await authoritySha256('["UC1"]'),
      }],
    });
  };
  const worker = createAuthorityWorker(appWorker, { logger: { warn() {} } });
  const response = await worker.fetch(appRequest('/settings'), authorityEnv(fixture, homeFetch), {});
  assert.equal(response.status, 200);
  assert.deepEqual(events, ['home-mutation']);
  assert.equal(fixture.kv.values.get('device:one:settings'), '{"old":true}');
  assert.equal(fixture.kv.values.has('device:one:channels'), false);
  assert.equal(fixture.kv.reads, readsBefore);
  assert.equal(fixture.kv.writes, writesBefore);
  const status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.pendingBackupKeys, 2);
});

test('Home mutation outage fails closed without changing Cloudflare or authority health', async () => {
  const fixture = coordinatorFixture({ value: 'old' });
  await seedCoordinator(fixture);
  const worker = createAuthorityWorker({
    async fetch(_request, env) { await env.TUBEPULSE_KV.put('value', 'new'); return Response.json({ ok: true }); },
  }, { logger: { warn() {} } });
  const response = await worker.fetch(appRequest('/register'), authorityEnv(fixture, async () => {
    throw new Error('Home offline');
  }), {});
  assert.equal(response.status, 503);
  assert.equal(fixture.kv.values.get('value'), 'old');
  const status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.replication.status, 'current');
  assert.equal(status.payload.lease, null);
  const publication = await callCoordinator(fixture.coordinator, '/acquire', {
    leaseId: 'publication-after-outage', kind: 'publication',
  });
  assert.equal(publication.response.status, 200);
  await callCoordinator(fixture.coordinator, '/release', { leaseId: 'publication-after-outage' });
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

test('Home semantic errors are returned without queueing backup deltas', async (t) => {
  await t.test('semantic error', async () => {
    const fixture = coordinatorFixture({ value: 'old' });
    await seedCoordinator(fixture);
    const worker = createAuthorityWorker({ async fetch() { throw new Error('must not run'); } }, { logger: { warn() {} } });
    const response = await worker.fetch(appRequest('/settings'), authorityEnv(fixture, async () => Response.json({
      ok: true,
      response: { status: 422, headers: { 'content-type': 'application/json' }, body: '{"error":"bad"}' },
      deltas: [],
    })), {});
    assert.equal(response.status, 422);
    assert.equal(fixture.kv.values.get('value'), 'old');
    const status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
    assert.equal(status.payload.pendingBackupKeys, 0);
    assert.equal(status.payload.lease, null);
  });
  await t.test('Home execution failure', async () => {
    const fixture = coordinatorFixture({ value: 'old' });
    await seedCoordinator(fixture);
    const worker = createAuthorityWorker({ async fetch() { throw new Error('must not run'); } }, { logger: { warn() {} } });
    const response = await worker.fetch(appRequest('/register'), authorityEnv(
      fixture,
      async () => Response.json({ error: 'Home mutation failed' }, { status: 500 }),
    ), {});
    assert.equal(response.status, 503);
    assert.equal(fixture.kv.values.get('value'), 'old');
    const status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
    assert.equal(status.payload.lease, null);
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

test('verified Home snapshot activates D1 generation and archives obsolete KV pending state', async () => {
  const fixture = d1CoordinatorFixture();
  const records = [
    { key: 'alpha', value: 'one', hash: await authoritySha256('one') },
    { key: 'beta', value: JSON.stringify({ zero: 0, nil: null }),
      hash: await authoritySha256(JSON.stringify({ zero: 0, nil: null })) },
  ];
  const manifestHash = await authoritySha256(records.map(({ key, hash }) => `${key}\0${hash}\n`).join(''));
  await fixture.storage.put('authority:pending:legacy', {
    key: 'legacy', delta: { key: 'legacy', baseHash: null, nextHash: await authoritySha256('queued') },
  });
  const leaseId = 'backend-migration-0001';
  let result = await callCoordinator(fixture.coordinator, '/backend-migration/begin', {
    leaseId, manifestHash, recordCount: records.length,
  });
  assert.equal(result.response.status, 200);
  result = await callCoordinator(fixture.coordinator, '/backend-migration/chunk', {
    leaseId, offset: 0, records,
  });
  assert.equal(result.response.status, 200);
  result = await callCoordinator(fixture.coordinator, '/backend-migration/commit', { leaseId });
  assert.equal(result.response.status, 200);

  const status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.deepEqual(status.payload.backend, {
    selected: 'd1', generation: 'production-v1', ready: true, legacyKvFrozen: true,
  });
  assert.equal(status.payload.replication.status, 'current');
  assert.equal(status.payload.pendingBackupKeys, 0);
  assert.equal(status.payload.quota.migrationEstimatedRowsWritten, records.length + 1);
  assert.equal(status.payload.quota.estimatedRowsWritten, records.length + 1);
  assert.equal(fixture.kv.writes, 0, 'legacy KV remains frozen throughout migration');
  const archived = fixture.storage.values.get('authority:legacy-backend-migration');
  assert.equal(archived.archivedPendingCount, 1);
  assert.equal(archived.verifiedManifestHash, manifestHash);
});

test('D1 migration refuses a mismatched manifest without activating or clearing legacy pending', async () => {
  const fixture = d1CoordinatorFixture();
  await fixture.storage.put('authority:pending:legacy', { key: 'legacy', delta: { key: 'legacy' } });
  const leaseId = 'backend-migration-0002';
  const record = { key: 'alpha', value: 'one', hash: await authoritySha256('one') };
  await callCoordinator(fixture.coordinator, '/backend-migration/begin', {
    leaseId, manifestHash: 'f'.repeat(64), recordCount: 1,
  });
  await callCoordinator(fixture.coordinator, '/backend-migration/chunk', {
    leaseId, offset: 0, records: [record],
  });
  const result = await callCoordinator(fixture.coordinator, '/backend-migration/commit', { leaseId });
  assert.equal(result.response.status, 409);
  assert.equal(fixture.database.backend, null);
  assert.equal((await fixture.storage.list({ prefix: 'authority:pending:' })).size, 1);
});

test('D1 coordinator accounts conservative rows, defers at publication cap and fences generation', async () => {
  const fixture = d1CoordinatorFixture();
  fixture.env.TUBEPULSE_AUTHORITY_D1_PUBLICATION_ROW_CAP = '3';
  fixture.env.TUBEPULSE_AUTHORITY_D1_ROW_WRITE_HARD_CAP = '6';
  const oldHash = await authoritySha256('old');
  const manifestHash = await authoritySha256(`alpha\0${oldHash}\n`);
  const leaseId = 'backend-migration-0003';
  await callCoordinator(fixture.coordinator, '/backend-migration/begin', {
    leaseId, manifestHash, recordCount: 1,
  });
  await callCoordinator(fixture.coordinator, '/backend-migration/chunk', {
    leaseId, offset: 0, records: [{ key: 'alpha', value: 'old', hash: oldHash }],
  });
  await callCoordinator(fixture.coordinator, '/backend-migration/commit', { leaseId });

  let result = await callCoordinator(fixture.coordinator, '/acquire', {
    leaseId: 'publication-d1-0001', kind: 'publication',
  });
  assert.equal(result.response.status, 200);
  result = await callCoordinator(fixture.coordinator, '/commit', {
    leaseId: 'publication-d1-0001', deltas: [{
      key: 'alpha', operation: 'put', value: 'new', baseHash: oldHash,
      nextHash: await authoritySha256('new'), options: {},
    }],
  });
  assert.equal(result.payload.applied, 1);
  let status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.quota.estimatedRowsWritten, 5);
  assert.deepEqual(status.payload.quota.limits, {
    totalEstimatedRows: 1000,
    publicationEstimatedRows: 3,
    appReserveEstimatedRows: 997,
    estimatedRowsPerLogicalWrite: 3,
  });

  const repeat = await callCoordinator(fixture.coordinator, '/backend-migration/begin', {
    leaseId: 'backend-migration-repeat', manifestHash, recordCount: 1,
  });
  assert.equal(repeat.response.status, 409, 'an active generation cannot be cleared and reused');

  await callCoordinator(fixture.coordinator, '/acquire', {
    leaseId: 'publication-d1-0002', kind: 'publication',
  });
  result = await callCoordinator(fixture.coordinator, '/commit', {
    leaseId: 'publication-d1-0002', deltas: [{
      key: 'beta', operation: 'put', value: 'queued', baseHash: null,
      nextHash: await authoritySha256('queued'), options: {},
    }],
  });
  assert.equal(result.payload.deferred, true);
  assert.equal(result.payload.reason, 'publication-cap');

  fixture.env.TUBEPULSE_CANONICAL_BACKEND_GENERATION = 'production-v2';
  status = await callCoordinator(fixture.coordinator, '/status', undefined, 'GET');
  assert.equal(status.payload.backend.ready, false);
  result = await callCoordinator(fixture.coordinator, '/acquire', {
    leaseId: 'publication-d1-0003', kind: 'publication',
  });
  assert.equal(result.response.status, 409);
});
