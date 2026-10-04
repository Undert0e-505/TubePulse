import assert from 'node:assert/strict';
import test from 'node:test';
import { createGatewayWorker, gatewayTestHelpers } from './tubepulse-api/gateway.mjs';

const SECRET = 'synthetic-local-gateway-secret-32-characters-minimum';
const DEVICE = 'synthetic-canary-device-for-tests';
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const silentLogger = { info() {}, warn() {}, error() {} };

class MemoryKv {
  constructor() {
    this.values = new Map();
    this.gets = 0;
    this.puts = 0;
  }
  async get(key, type) {
    this.gets++;
    const value = this.values.get(key) ?? null;
    return type === 'json' && value !== null ? JSON.parse(value) : value;
  }
  async put(key, value) {
    this.puts++;
    this.values.set(key, value);
  }
}

async function fixture(overrides = {}) {
  const fingerprint = await gatewayTestHelpers.sha256Hex(DEVICE);
  const kv = new MemoryKv();
  const events = [];
  let appCalls = 0;
  const appWorker = {
    async fetch(request) {
      appCalls++;
      events.push(`cloudflare:${request.method}:${new URL(request.url).pathname}`);
      if (request.method === 'GET') return Response.json({ source: 'cloudflare', channels: [] });
      return Response.json({ ok: true, source: 'cloudflare' });
    },
  };
  const env = {
    TUBEPULSE_KV: kv,
    TUBEPULSE_HOME_GATEWAY_ENABLED: 'true',
    TUBEPULSE_HOME_ORIGIN: 'http://127.0.0.1:9876',
    TUBEPULSE_HOME_GATEWAY_ALLOW_HTTP: 'true',
    TUBEPULSE_HOME_GATEWAY_SECRET: SECRET,
    TUBEPULSE_HOME_CANARY_SHA256: fingerprint,
    TUBEPULSE_HOME_GATEWAY_TIMEOUT_MS: '250',
    ...overrides.env,
  };
  const homeCalls = [];
  const responder = overrides.homeFetch || (async (url) => {
    if (new URL(url).pathname.endsWith('/ready')) {
      return Response.json({ ok: true, ready: true, current: true, role: 'shadow', profilePresent: true });
    }
    return Response.json({ source: 'home', channels: [] });
  });
  const homeFetch = async (url, init) => {
    homeCalls.push({ url, init });
    events.push(`home:${init.method}:${new URL(url).pathname}`);
    return await responder(url, init);
  };
  let sequence = 0;
  const worker = createGatewayWorker(appWorker, {
    fetch: homeFetch,
    now: () => NOW,
    randomUUID: () => `synthetic-request-${String(++sequence).padStart(4, '0')}`,
    logger: silentLogger,
  });
  const markCurrent = async () => {
    kv.values.set(gatewayTestHelpers.stateKey(fingerprint), JSON.stringify({ status: 'current' }));
  };
  return { appWorker, worker, env, kv, fingerprint, events, homeCalls, markCurrent, appCalls: () => appCalls };
}

function request(path, { method = 'GET', device = DEVICE, body, headers = {} } = {}) {
  return new Request(`https://api.example.test${path}`, {
    method,
    headers: {
      ...(device ? { Authorization: `Bearer ${device}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test('feature disabled is the untouched app path with no KV read or Home fetch', async () => {
  let homeCalls = 0;
  const fx = await fixture({
    env: {
      TUBEPULSE_HOME_GATEWAY_ENABLED: 'false',
      TUBEPULSE_HOME_GATEWAY_TRANSPORT: 'vpc',
      TUBEPULSE_HOME_VPC: { async fetch() { homeCalls++; throw new Error('must not fetch'); } },
    },
    homeFetch: async () => { homeCalls++; throw new Error('must not fetch'); },
  });
  const response = await fx.worker.fetch(request('/feed'), fx.env, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, 'cloudflare');
  assert.equal(fx.appCalls(), 1);
  assert.equal(fx.kv.gets, 0);
  assert.equal(fx.kv.puts, 0);
  assert.equal(homeCalls, 0);
});

test('feature-off delegates the original request and response object unchanged', async () => {
  const originalRequest = request('/feed', { headers: { 'X-Synthetic-Client': 'exact' } });
  const originalResponse = new Response('exact-existing-body', {
    status: 418,
    headers: { 'X-Existing-Contract': 'unchanged' },
  });
  let receivedRequest;
  const worker = createGatewayWorker({
    async fetch(candidate) { receivedRequest = candidate; return originalResponse; },
  }, {
    fetch: async () => { throw new Error('must not fetch'); },
    logger: silentLogger,
  });
  const kv = new MemoryKv();
  const response = await worker.fetch(originalRequest, { TUBEPULSE_KV: kv }, {});
  assert.equal(receivedRequest, originalRequest);
  assert.equal(response, originalResponse);
  assert.equal(kv.gets, 0);
  assert.equal(kv.puts, 0);
});

test('invalid enabled configuration fails closed before KV or Home access', async () => {
  const fx = await fixture({ env: { TUBEPULSE_HOME_GATEWAY_SECRET: 'short' } });
  const response = await fx.worker.fetch(request('/feed'), fx.env, {});
  assert.equal((await response.json()).source, 'cloudflare');
  assert.equal(fx.kv.gets, 0);
  assert.equal(fx.homeCalls.length, 0);
});

test('plain HTTP is accepted only for an explicit private/local test origin', async () => {
  let homeCalls = 0;
  const fx = await fixture({
    env: { TUBEPULSE_HOME_ORIGIN: 'http://public-origin.example', TUBEPULSE_HOME_GATEWAY_ALLOW_HTTP: 'true' },
    homeFetch: async () => { homeCalls++; return Response.json({ channels: [] }); },
  });
  const response = await fx.worker.fetch(request('/feed'), fx.env, {});
  assert.equal((await response.json()).source, 'cloudflare');
  assert.equal(homeCalls, 0);
  assert.equal(fx.kv.gets, 0);
});

test('VPC transport requires a fetcher binding and accepts only that private fetch path', async () => {
  const missing = await fixture({
    env: {
      TUBEPULSE_HOME_GATEWAY_TRANSPORT: 'vpc',
      TUBEPULSE_HOME_ORIGIN: 'http://gateway-origin:8788',
      TUBEPULSE_HOME_GATEWAY_ALLOW_HTTP: 'false',
    },
  });
  let response = await missing.worker.fetch(request('/feed'), missing.env, {});
  assert.equal((await response.json()).source, 'cloudflare');
  assert.equal(missing.kv.gets, 0);
  assert.equal(missing.homeCalls.length, 0);

  const vpcCalls = [];
  let publicFetchCalls = 0;
  const binding = {
    async fetch(input, init) {
      const privateRequest = input instanceof Request ? input : new Request(input, init);
      vpcCalls.push({ input, init, privateRequest });
      return new URL(privateRequest.url).pathname.endsWith('/ready')
        ? Response.json({ ok: true, ready: true, current: true, role: 'shadow', profilePresent: true })
        : Response.json({ source: 'home-vpc', channels: [] });
    },
  };
  const fx = await fixture({
    env: {
      TUBEPULSE_HOME_GATEWAY_TRANSPORT: 'vpc',
      TUBEPULSE_HOME_ORIGIN: 'http://gateway-origin:8788',
      TUBEPULSE_HOME_GATEWAY_ALLOW_HTTP: 'false',
      TUBEPULSE_HOME_VPC: binding,
    },
    homeFetch: async () => {
      publicFetchCalls++;
      throw new Error('public fetch must not be used for VPC transport');
    },
  });
  await fx.markCurrent();
  response = await fx.worker.fetch(request('/feed'), fx.env, {});
  assert.equal((await response.json()).source, 'home-vpc');
  assert.equal(publicFetchCalls, 0);
  assert.equal(vpcCalls.length, 2);
  assert.ok(vpcCalls.every(({ input, init }) => input instanceof Request && init === undefined));
  assert.equal(new URL(vpcCalls[0].privateRequest.url).host, 'gateway-origin:8788');
  assert.equal(new URL(vpcCalls[1].privateRequest.url).pathname, '/_tubepulse/gateway/app/feed');
  assert.equal(vpcCalls[1].privateRequest.redirect, 'follow');
  assert.equal(vpcCalls[1].privateRequest.headers.get('Authorization'), `Bearer ${DEVICE}`);
  assert.match(vpcCalls[1].privateRequest.headers.get('X-TubePulse-Gateway-Signature'), /^[a-f0-9]{64}$/);
});

test('VPC transport failure transparently falls back to the canonical Worker', async () => {
  let publicFetchCalls = 0;
  const fx = await fixture({
    env: {
      TUBEPULSE_HOME_GATEWAY_TRANSPORT: 'vpc',
      TUBEPULSE_HOME_ORIGIN: 'http://gateway-origin:8788',
      TUBEPULSE_HOME_VPC: { async fetch() { throw new Error('private connector unavailable'); } },
    },
    homeFetch: async () => {
      publicFetchCalls++;
      throw new Error('public fetch must not be used for VPC transport');
    },
  });
  await fx.markCurrent();
  const response = await fx.worker.fetch(request('/feed'), fx.env, {});
  assert.equal((await response.json()).source, 'cloudflare');
  assert.equal(fx.appCalls(), 1);
  assert.equal(publicFetchCalls, 0);
});

test('non-canary and non-eligible routes remain on Cloudflare', async () => {
  const fx = await fixture();
  let response = await fx.worker.fetch(request('/feed', { device: 'different-synthetic-device' }), fx.env, {});
  assert.equal((await response.json()).source, 'cloudflare');
  response = await fx.worker.fetch(request('/_tubepulse/admin/status'), fx.env, {});
  assert.equal((await response.json()).source, 'cloudflare');
  response = await fx.worker.fetch(request('/resolve?handle=test'), fx.env, {});
  assert.equal((await response.json()).source, 'cloudflare');
  assert.equal(fx.homeCalls.length, 0);
  assert.equal(fx.kv.gets, 0);
});

test('current canary read is served by ready Home and preserves app authorization', async () => {
  const fx = await fixture();
  await fx.markCurrent();
  const response = await fx.worker.fetch(request('/feed', { headers: { 'X-Synthetic-Client': 'preserved' } }), fx.env, {});
  assert.equal((await response.json()).source, 'home');
  assert.equal(fx.appCalls(), 0);
  assert.equal(fx.homeCalls.length, 2);
  assert.equal(fx.homeCalls[1].init.headers.get('Authorization'), `Bearer ${DEVICE}`);
  assert.equal(fx.homeCalls[1].init.headers.get('X-Synthetic-Client'), 'preserved');
  assert.equal(fx.homeCalls[1].init.redirect, 'error');
  assert.match(fx.homeCalls[1].init.headers.get('X-TubePulse-Gateway-Signature'), /^[a-f0-9]{64}$/);
});

test('Home timeout, auth failure, 5xx, and incompatible success transparently fall back', async (t) => {
  for (const [name, homeFetch] of [
    ['network', async () => { throw new Error('offline'); }],
    ['timeout', async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    })],
    ['body-timeout', async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      },
    }), { headers: { 'Content-Type': 'application/json' } })],
    ['auth', async () => new Response('{"error":"bad signature"}', { status: 401, headers: { 'Content-Type': 'application/json' } })],
    ['rate-limit', async () => Response.json({ error: 'rate limited' }, { status: 429 })],
    ['server', async () => Response.json({ error: 'unavailable' }, { status: 503 })],
    ['incompatible', async (url) => new URL(url).pathname.endsWith('/ready')
      ? Response.json({ ok: true, ready: true, current: true, role: 'shadow', profilePresent: true })
      : Response.json({ unexpected: true })],
  ]) {
    await t.test(name, async () => {
      const fx = await fixture({ homeFetch });
      await fx.markCurrent();
      const response = await fx.worker.fetch(request('/feed'), fx.env, {});
      assert.equal((await response.json()).source, 'cloudflare');
      assert.equal(fx.appCalls(), 1);
    });
  }
});

test('a valid semantic Home 4xx is returned without masking it with Cloudflare', async () => {
  const fx = await fixture({
    homeFetch: async (url) => new URL(url).pathname.endsWith('/ready')
      ? Response.json({ ok: true, ready: true, current: true, role: 'shadow', profilePresent: true })
      : Response.json({ error: 'Device not registered' }, { status: 404 }),
  });
  await fx.markCurrent();
  const response = await fx.worker.fetch(request('/feed'), fx.env, {});
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'Device not registered');
  assert.equal(fx.appCalls(), 0);
});

test('canary mutation is Cloudflare-first and synchronously replicates exact body and app headers', async () => {
  const fx = await fixture({ homeFetch: async () => Response.json({ ok: true, source: 'home' }) });
  const body = { includeCommunityPosts: true, nested: { value: 7 } };
  const response = await fx.worker.fetch(request('/settings', {
    method: 'POST',
    body,
    headers: { 'X-Synthetic-Client': 'preserved' },
  }), fx.env, {});
  assert.equal((await response.json()).source, 'cloudflare');
  assert.match(fx.events[0], /^cloudflare:/);
  assert.match(fx.events[1], /^home:/);
  assert.equal(fx.homeCalls.length, 1);
  assert.equal(fx.homeCalls[0].init.headers.get('Authorization'), `Bearer ${DEVICE}`);
  assert.equal(fx.homeCalls[0].init.headers.get('X-Synthetic-Client'), 'preserved');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fx.homeCalls[0].init.body)), body);
});

test('failed Home replication returns Cloudflare success, writes stale once, and stale reads never reach Home', async () => {
  let homeCalls = 0;
  let failHome = true;
  const fx = await fixture({ homeFetch: async () => {
    homeCalls++;
    return failHome
      ? Response.json({ error: 'offline' }, { status: 503 })
      : Response.json({ ok: true, source: 'home' });
  } });
  let response = await fx.worker.fetch(request('/settings', { method: 'POST', body: { includeCommunityPosts: true } }), fx.env, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, 'cloudflare');
  assert.equal(fx.kv.puts, 1);
  failHome = false;
  response = await fx.worker.fetch(request('/settings', { method: 'POST', body: { includeCommunityPosts: false } }), fx.env, {});
  assert.equal(response.status, 200);
  assert.equal(fx.kv.puts, 1, 'a later successful mutation neither rewrites nor clears stale');
  const callsBeforeRead = homeCalls;
  response = await fx.worker.fetch(request('/feed'), fx.env, {});
  assert.equal((await response.json()).source, 'cloudflare');
  assert.equal(homeCalls, callsBeforeRead, 'stale read must not probe Home');
});

test('a failed canonical Cloudflare mutation is never sent to Home', async () => {
  let homeCalls = 0;
  const fingerprint = await gatewayTestHelpers.sha256Hex(DEVICE);
  const kv = new MemoryKv();
  const worker = createGatewayWorker({
    async fetch() { return Response.json({ error: 'canonical rejection' }, { status: 409 }); },
  }, {
    fetch: async () => { homeCalls++; return Response.json({ ok: true }); },
    now: () => NOW,
    randomUUID: () => 'synthetic-request-9999',
    logger: silentLogger,
  });
  const env = {
    TUBEPULSE_KV: kv,
    TUBEPULSE_HOME_GATEWAY_ENABLED: 'true',
    TUBEPULSE_HOME_ORIGIN: 'http://127.0.0.1:9876',
    TUBEPULSE_HOME_GATEWAY_ALLOW_HTTP: 'true',
    TUBEPULSE_HOME_GATEWAY_SECRET: SECRET,
    TUBEPULSE_HOME_CANARY_SHA256: fingerprint,
  };
  const response = await worker.fetch(request('/settings', { method: 'POST', body: { value: true } }), env, {});
  assert.equal(response.status, 409);
  assert.equal(homeCalls, 0);
  assert.equal(kv.gets, 0);
  assert.equal(kv.puts, 0);
});

test('a semantic Home mutation error marks the shadow stale after Cloudflare succeeds', async () => {
  const fx = await fixture({
    homeFetch: async () => Response.json({ error: 'shadow rejected mutation' }, { status: 409 }),
  });
  const response = await fx.worker.fetch(request('/settings', {
    method: 'POST',
    body: { includeCommunityPosts: true },
  }), fx.env, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, 'cloudflare');
  assert.equal(fx.kv.puts, 1);
  const state = JSON.parse([...fx.kv.values.values()].find((value) => JSON.parse(value).status === 'stale'));
  assert.equal(state.status, 'stale');
});

test('explicit signed reconciliation clears stale and restores Home reads', async () => {
  const fx = await fixture();
  fx.kv.values.set(gatewayTestHelpers.stateKey(fx.fingerprint), JSON.stringify({ status: 'stale' }));
  const requestId = 'synthetic-reconcile-0001';
  const signature = await gatewayTestHelpers.hmacHex(
    SECRET,
    gatewayTestHelpers.reconciliationCanonical({ timestamp: NOW, requestId, fingerprint: fx.fingerprint }),
  );
  const reconcile = await fx.worker.fetch(request('/_tubepulse/gateway/reconcile', {
    method: 'POST',
    device: null,
    body: { fingerprint: fx.fingerprint, timestamp: NOW, requestId, signature },
  }), fx.env, {});
  assert.equal(reconcile.status, 200);
  assert.deepEqual(await reconcile.json(), { ok: true, state: 'current', changed: true });
  const response = await fx.worker.fetch(request('/feed'), fx.env, {});
  assert.equal((await response.json()).source, 'home');
});

test('reconciliation observed through KV clears another isolate stale cache', async () => {
  let failHome = true;
  const fx = await fixture({ homeFetch: async (url) => {
    if (failHome) return Response.json({ error: 'offline' }, { status: 503 });
    return new URL(url).pathname.endsWith('/ready')
      ? Response.json({ ok: true, ready: true, current: true, role: 'shadow', profilePresent: true })
      : Response.json({ source: 'home', channels: [] });
  } });
  await fx.markCurrent();
  await fx.worker.fetch(request('/settings', { method: 'POST', body: { value: 1 } }), fx.env, {});
  failHome = false;

  const reconciliationWorker = createGatewayWorker(fx.appWorker, {
    fetch: async () => { throw new Error('not used'); },
    now: () => NOW + 1,
    randomUUID: () => 'synthetic-request-other-isolate',
    logger: silentLogger,
  });
  const requestId = 'synthetic-reconcile-cross-isolate';
  const signature = await gatewayTestHelpers.hmacHex(
    SECRET,
    gatewayTestHelpers.reconciliationCanonical({ timestamp: NOW + 1, requestId, fingerprint: fx.fingerprint }),
  );
  const reconciled = await reconciliationWorker.fetch(request('/_tubepulse/gateway/reconcile', {
    method: 'POST',
    device: null,
    body: { fingerprint: fx.fingerprint, timestamp: NOW + 1, requestId, signature },
  }), fx.env, {});
  assert.equal(reconciled.status, 200);

  const response = await fx.worker.fetch(request('/feed'), fx.env, {});
  assert.equal((await response.json()).source, 'home');
});

test('invalid and expired reconciliation receipts are rejected without state writes', async () => {
  const fx = await fixture();
  let response = await fx.worker.fetch(request('/_tubepulse/gateway/reconcile', {
    method: 'POST',
    device: null,
    body: { fingerprint: fx.fingerprint, timestamp: NOW, requestId: 'synthetic-reconcile-0002', signature: '0'.repeat(64) },
  }), fx.env, {});
  assert.equal(response.status, 401);
  response = await fx.worker.fetch(request('/_tubepulse/gateway/reconcile', {
    method: 'POST',
    device: null,
    body: {
      fingerprint: fx.fingerprint,
      timestamp: NOW - 61_000,
      requestId: 'synthetic-reconcile-0003',
      signature: await gatewayTestHelpers.hmacHex(SECRET, gatewayTestHelpers.reconciliationCanonical({
        timestamp: NOW - 61_000,
        requestId: 'synthetic-reconcile-0003',
        fingerprint: fx.fingerprint,
      })),
    },
  }), fx.env, {});
  assert.equal(response.status, 401);
  assert.equal(fx.kv.puts, 0);
});

test('a receipt issued before a later stale transition cannot clear it', async () => {
  const fx = await fixture();
  fx.kv.values.set(gatewayTestHelpers.stateKey(fx.fingerprint), JSON.stringify({
    status: 'stale',
    changedAt: new Date(NOW).toISOString(),
  }));
  const timestamp = NOW - 1;
  const requestId = 'synthetic-reconcile-too-old';
  const signature = await gatewayTestHelpers.hmacHex(
    SECRET,
    gatewayTestHelpers.reconciliationCanonical({ timestamp, requestId, fingerprint: fx.fingerprint }),
  );
  const response = await fx.worker.fetch(request('/_tubepulse/gateway/reconcile', {
    method: 'POST',
    device: null,
    body: { fingerprint: fx.fingerprint, timestamp, requestId, signature },
  }), fx.env, {});
  assert.equal(response.status, 409);
  assert.equal(fx.kv.puts, 0);
  assert.equal(JSON.parse(fx.kv.values.get(gatewayTestHelpers.stateKey(fx.fingerprint))).status, 'stale');
});

test('gateway logs expose only route outcome and latency metadata', async () => {
  const fingerprint = await gatewayTestHelpers.sha256Hex(DEVICE);
  const lines = [];
  const kv = new MemoryKv();
  kv.values.set(gatewayTestHelpers.stateKey(fingerprint), JSON.stringify({ status: 'current' }));
  const appWorker = { async fetch() { return Response.json({ source: 'cloudflare', channels: [] }); } };
  const worker = createGatewayWorker(appWorker, {
    fetch: async () => Response.json({ error: 'offline' }, { status: 503 }),
    now: () => NOW,
    randomUUID: () => 'synthetic-request-log-test',
    logger: {
      info: (line) => lines.push(line),
      warn: (line) => lines.push(line),
      error: (line) => lines.push(line),
    },
  });
  await worker.fetch(request('/feed'), {
    TUBEPULSE_KV: kv,
    TUBEPULSE_HOME_GATEWAY_ENABLED: 'true',
    TUBEPULSE_HOME_ORIGIN: 'http://127.0.0.1:9876',
    TUBEPULSE_HOME_GATEWAY_ALLOW_HTTP: 'true',
    TUBEPULSE_HOME_GATEWAY_SECRET: SECRET,
    TUBEPULSE_HOME_CANARY_SHA256: fingerprint,
  }, {});
  const logText = lines.join('\n');
  assert.match(logText, /route=\/feed outcome=cloudflare-fallback reason=home-not-ready durationMs=/);
  assert.equal(logText.includes(DEVICE), false);
  assert.equal(logText.includes(fingerprint), false);
  assert.equal(logText.includes('Authorization'), false);
  assert.equal(logText.includes('Bearer'), false);
});
