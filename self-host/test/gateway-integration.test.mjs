import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readConfig } from '../src/config.mjs';
import { signGatewayRequest } from '../src/gateway-auth.mjs';
import { createTubePulseService } from '../src/service.mjs';
import { resolveCanonicalGatewayPullConflict, SyncEngine } from '../src/sync-engine.mjs';
import { createGatewayWorker, gatewayTestHelpers } from '../../worker/tubepulse-api/gateway.mjs';

const DEVICE = 'synthetic-integration-canary-device';
const SECRET = 'synthetic-local-gateway-secret-32-characters-minimum';
const ADMIN = 'synthetic-integration-admin-token';

class MemoryNamespace {
  constructor() { this.values = new Map(); }
  async get(key, type) {
    const value = this.values.get(key) ?? null;
    if (type === 'json' && value !== null) return JSON.parse(value);
    return value;
  }
  async put(key, value) { this.values.set(key, String(value)); }
  async delete(key) { this.values.delete(key); }
  async list() { return { keys: [...this.values.keys()].map((name) => ({ name })), list_complete: true }; }
  async listKeys() { return [...this.values.keys()].map((name) => ({ name })); }
}

class MemoryStateFile {
  constructor() {
    this.value = { schemaVersion: 1, baseline: {}, conflicts: {}, lastPull: null, lastPush: null };
  }
  async read() { return structuredClone(this.value); }
  async write(value) { this.value = structuredClone(value); }
}

class MarkerKv extends MemoryNamespace {
  constructor() { super(); this.puts = 0; }
  async put(key, value) { this.puts++; await super.put(key, value); }
}

function identity(request) {
  const value = request.headers.get('Authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function createAppWorker(store, source, events, observations = [], { now = () => Date.now() } = {}) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const deviceId = identity(request);
      events.push(`${source}:${request.method}:${url.pathname}`);
      const profileKey = `device:${deviceId}:profile`;
      if (!deviceId) return Response.json({ error: 'Authentication required' }, { status: 401 });
      if (request.method === 'GET' && url.pathname === '/feed') {
        if (!store.values.has(profileKey)) return Response.json({ error: 'Device not registered' }, { status: 404 });
        const channels = JSON.parse(store.values.get(`device:${deviceId}:feed`) || '[]');
        return Response.json({ source, channels });
      }
      if (request.method === 'POST' && url.pathname === '/settings') {
        const rawBody = await request.text();
        observations.push({
          authorization: request.headers.get('Authorization'),
          contentType: request.headers.get('Content-Type'),
          body: rawBody,
        });
        if (!store.values.has(profileKey)) return Response.json({ error: 'Device not registered' }, { status: 404 });
        store.values.set(`device:${deviceId}:settings`, rawBody);
        return Response.json({ ok: true, source });
      }
      if (request.method === 'POST' && url.pathname === '/register') {
        const existing = JSON.parse(store.values.get(profileKey) || '{}');
        store.values.set(profileKey, JSON.stringify({
          ...existing,
          platform: 'synthetic',
          lastSeenAt: Date.now(),
        }));
        return Response.json({ ok: true, source });
      }
      if (request.method === 'POST' && url.pathname === '/subscribe-channel') {
        if (!store.values.has(profileKey)) return Response.json({ error: 'Device not registered' }, { status: 404 });
        const { channelId } = await request.json();
        const channels = JSON.parse(store.values.get(`device:${deviceId}:feed`) || '[]');
        if (!channels.some((channel) => channel.channelId === channelId)) {
          channels.push({ channelId, videos: [] });
          store.values.set(`device:${deviceId}:feed`, JSON.stringify(channels));
        }
        const metaKey = `channel:${channelId}:meta`;
        if (!store.values.has(metaKey)) {
          store.values.set(metaKey, JSON.stringify({
            name: channelId,
            avatarUrl: null,
            lastVideoId: null,
            addedAt: now(),
          }));
        }
        return Response.json({ ok: true, source });
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  };
}

class FakeRuntime {
  constructor(namespace, appWorker) {
    this.namespace = namespace;
    this.appWorker = appWorker;
    this.notificationSends = 0;
  }
  async start() {}
  async getLocalNamespace() { return this.namespace; }
  async dispatchFetch(input, init) { return await this.appWorker.fetch(new Request(input, init)); }
  async dispatchScheduled() { throw new Error('shadow scheduler must remain inactive'); }
  async close() {}
}

class FullCopySyncEngine {
  constructor(remote, local) {
    this.remote = remote;
    this.local = local;
    this.running = null;
    this.lastPull = null;
  }
  async pull() {
    this.running = 'pull';
    this.local.values = new Map(this.remote.values);
    this.lastPull = {
      at: new Date().toISOString(),
      imported: this.local.values.size,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      pendingLocal: 0,
      conflicts: 0,
      excluded: 0,
      status: 'ok',
    };
    this.running = null;
    return structuredClone(this.lastPull);
  }
  async status() {
    return {
      lastPull: structuredClone(this.lastPull),
      lastPush: null,
      conflictCount: 0,
      pendingCount: 0,
    };
  }
}

class ControlledCopySyncEngine extends FullCopySyncEngine {
  constructor(remote, local) {
    super(remote, local);
    this.pullCount = 0;
    this.pause = null;
  }
  pauseNextPull() {
    let signalStarted;
    let release;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const released = new Promise((resolve) => { release = resolve; });
    this.pause = { signalStarted, released };
    return { started, release };
  }
  async pull() {
    this.running = 'pull';
    this.pullCount++;
    const pause = this.pause;
    this.pause = null;
    if (pause) {
      pause.signalStarted();
      await pause.released;
    }
    this.local.values = new Map(this.remote.values);
    this.lastPull = {
      at: new Date().toISOString(),
      imported: this.local.values.size,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      pendingLocal: 0,
      conflicts: 0,
      excluded: 0,
      status: 'ok',
    };
    this.running = null;
    return structuredClone(this.lastPull);
  }
}

class ConflictSyncEngine {
  constructor() { this.running = null; }
  async pull() {
    return {
      at: new Date().toISOString(),
      imported: 0,
      updated: 0,
      deleted: 0,
      unchanged: 1,
      pendingLocal: 0,
      conflicts: 1,
      excluded: 0,
      status: 'conflict',
    };
  }
  async status() {
    return {
      lastPull: { at: new Date().toISOString(), status: 'conflict', pendingLocal: 0 },
      lastPush: null,
      conflictCount: 1,
      pendingCount: 0,
    };
  }
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function signedFetch(baseUrl, target, {
  operation,
  method = 'GET',
  body,
  requestId,
  timestamp = Date.now(),
  device = DEVICE,
} = {}) {
  const bodyBuffer = body ? Buffer.from(body) : Buffer.alloc(0);
  const headers = signGatewayRequest({
    secret: SECRET,
    timestamp,
    requestId,
    operation,
    method,
    target,
    authorization: `Bearer ${device}`,
    body: bodyBuffer,
  });
  headers.Authorization = `Bearer ${device}`;
  if (body) headers['Content-Type'] = 'application/json';
  const originPath = target === '/_tubepulse/gateway/ready'
    ? target
    : `/_tubepulse/gateway/app${target}`;
  return await fetch(`${baseUrl}${originPath}`, {
    method,
    headers,
    ...(body ? { body } : {}),
  });
}

test('isolated two-store canary gateway keeps Cloudflare authoritative and fails closed', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-gateway-integration-'));
  const fingerprint = await gatewayTestHelpers.sha256Hex(DEVICE);
  const cloudflareStore = new MemoryNamespace();
  const homeStore = new MemoryNamespace();
  const markerKv = new MarkerKv();
  const events = [];
  const cloudflareObservations = [];
  const homeObservations = [];
  cloudflareStore.values.set(`device:${DEVICE}:profile`, JSON.stringify({ platform: 'synthetic' }));
  cloudflareStore.values.set(`device:${DEVICE}:feed`, JSON.stringify([{ channelId: 'synthetic-channel', videos: [] }]));

  const homeRuntime = new FakeRuntime(homeStore, createAppWorker(homeStore, 'home', events, homeObservations));
  const config = readConfig({
    TUBEPULSE_DATA_DIR: dataDir,
    TUBEPULSE_HOST: '127.0.0.1',
    TUBEPULSE_PORT: '0',
    TUBEPULSE_MODE: 'mirror',
    TUBEPULSE_ADMIN_TOKEN: ADMIN,
    TUBEPULSE_GATEWAY_ORIGIN_ENABLED: 'true',
    TUBEPULSE_HOME_GATEWAY_SECRET: SECRET,
    TUBEPULSE_HOME_CANARY_SHA256: fingerprint,
    TUBEPULSE_GATEWAY_READINESS_MAX_AGE_SECONDS: '300',
    CLOUDFLARE_ACCOUNT_ID: 'synthetic-account',
    CLOUDFLARE_KV_NAMESPACE_ID: 'synthetic-namespace',
    CLOUDFLARE_API_TOKEN: 'synthetic-token',
  }, { quiet: true });
  const service = await createTubePulseService(config, {
    runtime: homeRuntime,
    timers: false,
    automaticSync: false,
  });
  const syncEngine = new FullCopySyncEngine(cloudflareStore, homeStore);
  service.syncEngine = syncEngine;
  t.after(async () => {
    await service.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const cloudflareWorker = createAppWorker(cloudflareStore, 'cloudflare', events, cloudflareObservations);
  let failHome = false;
  const gateway = createGatewayWorker(cloudflareWorker, {
    fetch: async (...args) => failHome
      ? Response.json({ error: 'synthetic Home failure' }, { status: 503 })
      : await fetch(...args),
    logger: { info() {}, warn() {}, error() {} },
  });
  const env = {
    TUBEPULSE_KV: markerKv,
    TUBEPULSE_HOME_GATEWAY_ENABLED: 'true',
    TUBEPULSE_HOME_ORIGIN: service.url,
    TUBEPULSE_HOME_GATEWAY_ALLOW_HTTP: 'true',
    TUBEPULSE_HOME_GATEWAY_SECRET: SECRET,
    TUBEPULSE_HOME_CANARY_SHA256: fingerprint,
    TUBEPULSE_HOME_GATEWAY_TIMEOUT_MS: '1000',
  };
  const appRequest = (pathname, init = {}) => new Request(`https://api.synthetic.test${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${DEVICE}`, ...(init.headers || {}) },
  });

  const publicStatus = await (await fetch(`${service.url}/_tubepulse/status`)).json();
  const publicStatusText = JSON.stringify(publicStatus);
  assert.equal(publicStatus.configuration.homeGatewayOriginEnabled, true);
  assert.equal(publicStatus.configuration.homeGatewayFingerprintConfigured, true);
  assert.equal(publicStatusText.includes(SECRET), false);
  assert.equal(publicStatusText.includes(fingerprint), false);
  assert.equal(publicStatusText.includes(DEVICE), false);
  const directOriginRead = await fetch(`${service.url}/feed`, {
    headers: { Authorization: `Bearer ${DEVICE}` },
  });
  assert.equal(directOriginRead.status, 404, 'gateway origin must not expose the ordinary app API directly');
  assert.equal(events.length, 0, 'blocked direct request must not reach the Home Worker runtime');

  // Missing current marker is fail-closed: the first read stays on Cloudflare
  // and does not even probe the Home origin.
  let response = await gateway.fetch(appRequest('/feed'), env, {});
  assert.equal((await response.json()).source, 'cloudflare');
  assert.equal(homeStore.values.size, 0);

  // An admin-authenticated full pull issues a scoped receipt. Applying that
  // receipt to the Worker is the only transition that makes Home current.
  response = await fetch(`${service.url}/_tubepulse/admin/gateway/reconcile`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN}` },
  });
  assert.equal(response.status, 200);
  const { receipt } = await response.json();
  assert.equal(receipt.fingerprint, fingerprint);
  response = await gateway.fetch(new Request('https://api.synthetic.test/_tubepulse/gateway/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(receipt),
  }), env, {});
  assert.equal(response.status, 200);

  response = await gateway.fetch(appRequest('/feed'), env, {});
  assert.equal((await response.json()).source, 'home');

  // The canonical mutation runs first and its body/auth semantics are then
  // synchronously reproduced against the isolated Home store.
  events.length = 0;
  const settingsBody = JSON.stringify({ includeCommunityPosts: true, nested: { value: 7 } });
  response = await gateway.fetch(appRequest('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: settingsBody,
  }), env, {});
  assert.equal((await response.json()).source, 'cloudflare');
  assert.deepEqual(events.slice(0, 2), ['cloudflare:POST:/settings', 'home:POST:/settings']);
  assert.equal(cloudflareStore.values.get(`device:${DEVICE}:settings`), settingsBody);
  assert.equal(homeStore.values.get(`device:${DEVICE}:settings`), settingsBody);
  assert.equal(homeObservations.at(-1).authorization, `Bearer ${DEVICE}`);
  assert.equal(homeObservations.at(-1).contentType, 'application/json');
  assert.equal(homeObservations.at(-1).body, settingsBody);

  // A failed shadow write cannot change the successful canonical response,
  // but creates one stale transition and blocks all subsequent Home reads.
  failHome = true;
  response = await gateway.fetch(appRequest('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ includeCommunityPosts: false }),
  }), env, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, 'cloudflare');
  const putsAfterFailure = markerKv.puts;
  response = await gateway.fetch(appRequest('/feed'), env, {});
  assert.equal((await response.json()).source, 'cloudflare');
  assert.equal(markerKv.puts, putsAfterFailure);

  // A new full reconciliation, not a later mutation, restores Home reads.
  failHome = false;
  response = await fetch(`${service.url}/_tubepulse/admin/gateway/reconcile`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN}` },
  });
  const secondReceipt = (await response.json()).receipt;
  response = await gateway.fetch(new Request('https://api.synthetic.test/_tubepulse/gateway/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(secondReceipt),
  }), env, {});
  assert.equal(response.status, 200);
  response = await gateway.fetch(appRequest('/feed'), env, {});
  assert.equal((await response.json()).source, 'home');

  // The authenticated origin rejects replay and expiry, and its allowlist
  // cannot tunnel an admin path into the Worker runtime.
  const replayId = 'synthetic-replay-0001';
  response = await signedFetch(service.url, '/_tubepulse/gateway/ready', { operation: 'ready', requestId: replayId });
  assert.equal(response.status, 200);
  response = await signedFetch(service.url, '/_tubepulse/gateway/ready', { operation: 'ready', requestId: replayId });
  assert.equal(response.status, 401);
  response = await signedFetch(service.url, '/_tubepulse/gateway/ready', {
    operation: 'ready',
    requestId: 'synthetic-expired-0001',
    timestamp: Date.now() - 61_000,
  });
  assert.equal(response.status, 401);
  response = await signedFetch(service.url, '/_tubepulse/gateway/ready', {
    operation: 'ready',
    requestId: 'synthetic-non-canary-0001',
    device: 'different-synthetic-device',
  });
  assert.equal(response.status, 403);
  response = await signedFetch(service.url, '/_tubepulse/admin/takeover', {
    operation: 'mutation',
    method: 'POST',
    requestId: 'synthetic-admin-path-0001',
  });
  assert.equal(response.status, 404);
  assert.equal(homeRuntime.notificationSends, 0);
  assert.equal(service.scheduler.status().state, 'standby');
});

test('an overlapping canonical mutation fails closed, then a clean pull automatically reconciles', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-gateway-overlap-'));
  const fingerprint = await gatewayTestHelpers.sha256Hex(DEVICE);
  const cloudflareStore = new MemoryNamespace();
  const homeStore = new MemoryNamespace();
  const markerKv = new MarkerKv();
  const events = [];
  cloudflareStore.values.set(`device:${DEVICE}:profile`, JSON.stringify({ platform: 'synthetic', lastSeenAt: 1 }));
  cloudflareStore.values.set(`device:${DEVICE}:feed`, JSON.stringify([{ channelId: 'existing-channel', videos: [] }]));

  const homeRuntime = new FakeRuntime(homeStore, createAppWorker(homeStore, 'home', events));
  const config = readConfig({
    TUBEPULSE_DATA_DIR: dataDir,
    TUBEPULSE_HOST: '127.0.0.1',
    TUBEPULSE_PORT: '0',
    TUBEPULSE_MODE: 'mirror',
    TUBEPULSE_ADMIN_TOKEN: ADMIN,
    TUBEPULSE_GATEWAY_ORIGIN_ENABLED: 'true',
    TUBEPULSE_HOME_GATEWAY_SECRET: SECRET,
    TUBEPULSE_HOME_CANARY_SHA256: fingerprint,
    TUBEPULSE_GATEWAY_READINESS_MAX_AGE_SECONDS: '300',
    TUBEPULSE_GATEWAY_RECONCILE_URL: 'https://api.synthetic.test/_tubepulse/gateway/reconcile',
    CLOUDFLARE_ACCOUNT_ID: 'synthetic-account',
    CLOUDFLARE_KV_NAMESPACE_ID: 'synthetic-namespace',
    CLOUDFLARE_API_TOKEN: 'synthetic-token',
  }, { quiet: true });

  let gateway;
  let env;
  const service = await createTubePulseService(config, {
    runtime: homeRuntime,
    timers: false,
    automaticSync: false,
    fetchImpl: async (input, init) => await gateway.fetch(new Request(input, init), env, {}),
  });
  const syncEngine = new ControlledCopySyncEngine(cloudflareStore, homeStore);
  service.syncEngine = syncEngine;
  const cloudflareWorker = createAppWorker(cloudflareStore, 'cloudflare', events);
  gateway = createGatewayWorker(cloudflareWorker, {
    fetch: async (...args) => await fetch(...args),
    logger: { info() {}, warn() {}, error() {} },
  });
  env = {
    TUBEPULSE_KV: markerKv,
    TUBEPULSE_HOME_GATEWAY_ENABLED: 'true',
    TUBEPULSE_HOME_ORIGIN: service.url,
    TUBEPULSE_HOME_GATEWAY_ALLOW_HTTP: 'true',
    TUBEPULSE_HOME_GATEWAY_SECRET: SECRET,
    TUBEPULSE_HOME_CANARY_SHA256: fingerprint,
    TUBEPULSE_HOME_GATEWAY_TIMEOUT_MS: '1000',
  };
  const request = (pathname, init = {}) => new Request(`https://api.synthetic.test${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${DEVICE}`, ...(init.headers || {}) },
  });
  t.after(async () => {
    await service.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  // Establish the initial exact mirror and current marker through the same
  // signed automatic receipt path used in production.
  await service.runAutomaticSync();
  const markerKey = gatewayTestHelpers.stateKey(fingerprint);
  assert.equal(JSON.parse(markerKv.values.get(markerKey)).status, 'current');
  let response = await gateway.fetch(request('/feed'), env, {});
  assert.equal((await response.json()).source, 'home');

  // Pause a pull after its maintenance lease is acquired. Canonical writes
  // still succeed, while Home refuses the overlapping shadow writes and the
  // Worker transitions stale exactly once.
  const pause = syncEngine.pauseNextPull();
  const pulling = service.runAutomaticSync();
  await pause.started;
  assert.deepEqual(await service.runAutomaticSync(), { deferred: true });
  assert.equal(service.automaticSyncPending, false, 'an overlapping timer tick must not create a pull loop');
  response = await gateway.fetch(request('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'synthetic' }),
  }), env, {});
  assert.equal(response.status, 200);
  response = await gateway.fetch(request('/subscribe-channel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId: 'new-channel' }),
  }), env, {});
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(markerKv.values.get(markerKey)).status, 'stale');
  assert.equal(JSON.parse(homeStore.values.get(`device:${DEVICE}:feed`)).length, 1);

  response = await gateway.fetch(request('/feed'), env, {});
  assert.equal((await response.json()).source, 'cloudflare', 'stale Home must never serve the overlapping read');
  assert.equal((JSON.parse(cloudflareStore.values.get(`device:${DEVICE}:feed`))).length, 2);

  pause.release();
  await pulling;
  assert.equal(service.lastAutomaticReconciliation.status, 'deferred');
  assert.equal(service.lastAutomaticReconciliation.reason, 'mutation-overlap');

  // The tainted pull schedules one fresh snapshot. Only that quiescent exact
  // pull may issue a signed receipt and restore Home routing.
  await waitFor(
    () => syncEngine.pullCount >= 3 && service.lastAutomaticReconciliation?.status === 'current',
    'automatic post-overlap reconciliation did not complete',
  );
  assert.equal(JSON.parse(markerKv.values.get(markerKey)).status, 'current');
  assert.equal((JSON.parse(homeStore.values.get(`device:${DEVICE}:feed`))).length, 2);
  response = await gateway.fetch(request('/feed'), env, {});
  const recovered = await response.json();
  assert.equal(recovered.source, 'home');
  assert.deepEqual(recovered.channels, JSON.parse(cloudflareStore.values.get(`device:${DEVICE}:feed`)));
  assert.equal(homeRuntime.notificationSends, 0);
  assert.equal(service.scheduler.status().state, 'standby');
});

test('a first-subscribe metadata timestamp race selects canonical data before automatic reconciliation', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-gateway-first-subscribe-'));
  const fingerprint = await gatewayTestHelpers.sha256Hex(DEVICE);
  const cloudflareStore = new MemoryNamespace();
  const homeStore = new MemoryNamespace();
  const markerKv = new MarkerKv();
  const events = [];
  cloudflareStore.values.set(`device:${DEVICE}:profile`, JSON.stringify({ platform: 'synthetic', lastSeenAt: 1 }));
  cloudflareStore.values.set(`device:${DEVICE}:feed`, JSON.stringify([{ channelId: 'existing-channel', videos: [] }]));

  const homeRuntime = new FakeRuntime(homeStore, createAppWorker(
    homeStore,
    'home',
    events,
    [],
    { now: () => 1_700_000_000_001 },
  ));
  const config = readConfig({
    TUBEPULSE_DATA_DIR: dataDir,
    TUBEPULSE_HOST: '127.0.0.1',
    TUBEPULSE_PORT: '0',
    TUBEPULSE_MODE: 'mirror',
    TUBEPULSE_ADMIN_TOKEN: ADMIN,
    TUBEPULSE_GATEWAY_ORIGIN_ENABLED: 'true',
    TUBEPULSE_HOME_GATEWAY_SECRET: SECRET,
    TUBEPULSE_HOME_CANARY_SHA256: fingerprint,
    TUBEPULSE_GATEWAY_READINESS_MAX_AGE_SECONDS: '300',
    TUBEPULSE_GATEWAY_RECONCILE_URL: 'https://api.synthetic.test/_tubepulse/gateway/reconcile',
    CLOUDFLARE_ACCOUNT_ID: 'synthetic-account',
    CLOUDFLARE_KV_NAMESPACE_ID: 'synthetic-namespace',
    CLOUDFLARE_API_TOKEN: 'synthetic-token',
  }, { quiet: true });

  let gateway;
  let env;
  const service = await createTubePulseService(config, {
    runtime: homeRuntime,
    timers: false,
    automaticSync: false,
    fetchImpl: async (input, init) => await gateway.fetch(new Request(input, init), env, {}),
  });
  const stateFile = new MemoryStateFile();
  service.syncEngine = new SyncEngine({
    local: homeStore,
    remote: cloudflareStore,
    stateFile,
    resolvePullConflict: resolveCanonicalGatewayPullConflict,
  });
  const cloudflareWorker = createAppWorker(
    cloudflareStore,
    'cloudflare',
    events,
    [],
    { now: () => 1_700_000_000_999 },
  );
  gateway = createGatewayWorker(cloudflareWorker, {
    fetch: async (...args) => await fetch(...args),
    logger: { info() {}, warn() {}, error() {} },
  });
  env = {
    TUBEPULSE_KV: markerKv,
    TUBEPULSE_HOME_GATEWAY_ENABLED: 'true',
    TUBEPULSE_HOME_ORIGIN: service.url,
    TUBEPULSE_HOME_GATEWAY_ALLOW_HTTP: 'true',
    TUBEPULSE_HOME_GATEWAY_SECRET: SECRET,
    TUBEPULSE_HOME_CANARY_SHA256: fingerprint,
    TUBEPULSE_HOME_GATEWAY_TIMEOUT_MS: '1000',
  };
  const request = (pathname, init = {}) => new Request(`https://api.synthetic.test${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${DEVICE}`, ...(init.headers || {}) },
  });
  t.after(async () => {
    await service.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await service.runAutomaticSync();
  const markerKey = gatewayTestHelpers.stateKey(fingerprint);
  assert.equal(JSON.parse(markerKv.values.get(markerKey)).status, 'current');

  const response = await gateway.fetch(request('/subscribe-channel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId: 'new-channel' }),
  }), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(events.slice(-2), [
    'cloudflare:POST:/subscribe-channel',
    'home:POST:/subscribe-channel',
  ]);
  const metaKey = 'channel:new-channel:meta';
  assert.notEqual(homeStore.values.get(metaKey), cloudflareStore.values.get(metaKey));

  const pull = await service.runAutomaticSync();
  const syncStatus = await service.syncEngine.status();
  assert.equal(pull.status, 'ok');
  assert.equal(pull.resolved, 1);
  assert.equal(pull.conflicts, 0);
  assert.equal(pull.pendingLocal, 0);
  assert.equal(syncStatus.conflictCount, 0);
  assert.equal(syncStatus.pendingCount, 0);
  assert.equal(homeStore.values.get(metaKey), cloudflareStore.values.get(metaKey));
  assert.equal(service.lastAutomaticReconciliation.status, 'current');
  assert.equal(JSON.parse(markerKv.values.get(markerKey)).status, 'current');

  const feed = await gateway.fetch(request('/feed'), env, {});
  assert.equal((await feed.json()).source, 'home');
  assert.equal(homeRuntime.notificationSends, 0);
  assert.equal(service.scheduler.status().state, 'standby');
});

test('automatic reconciliation remains blocked while a genuine conflict exists', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-gateway-conflict-'));
  const fingerprint = await gatewayTestHelpers.sha256Hex(DEVICE);
  const local = new MemoryNamespace();
  const runtime = new FakeRuntime(local, createAppWorker(local, 'home', []));
  const config = readConfig({
    TUBEPULSE_DATA_DIR: dataDir,
    TUBEPULSE_HOST: '127.0.0.1',
    TUBEPULSE_PORT: '0',
    TUBEPULSE_MODE: 'mirror',
    TUBEPULSE_ADMIN_TOKEN: ADMIN,
    TUBEPULSE_GATEWAY_ORIGIN_ENABLED: 'true',
    TUBEPULSE_HOME_GATEWAY_SECRET: SECRET,
    TUBEPULSE_HOME_CANARY_SHA256: fingerprint,
    TUBEPULSE_GATEWAY_RECONCILE_URL: 'https://api.synthetic.test/_tubepulse/gateway/reconcile',
    CLOUDFLARE_ACCOUNT_ID: 'synthetic-account',
    CLOUDFLARE_KV_NAMESPACE_ID: 'synthetic-namespace',
    CLOUDFLARE_API_TOKEN: 'synthetic-token',
  }, { quiet: true });
  let reconcileCalls = 0;
  const service = await createTubePulseService(config, {
    runtime,
    timers: false,
    automaticSync: false,
    fetchImpl: async () => {
      reconcileCalls++;
      return Response.json({ ok: true, state: 'current' });
    },
  });
  service.syncEngine = new ConflictSyncEngine();
  t.after(async () => {
    await service.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await service.runAutomaticSync();
  assert.equal(reconcileCalls, 0);
  assert.deepEqual(service.lastAutomaticReconciliation, {
    at: service.lastAutomaticReconciliation.at,
    status: 'blocked',
    reason: 'parity-not-proven',
  });
});
