import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signAuthorityRequest } from '../src/home-authority.mjs';
import { UnifiedHomeAuthorityService } from '../src/home-authority-service.mjs';
import { contentHash } from '../src/kv-adapters.mjs';
import { appWorker } from '../../worker/tubepulse-api/index.js';

const SECRET = 'synthetic-unified-service-secret-longer-than-32-characters';

class MemoryNamespace {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); }
  async get(name, type = 'text') {
    const value = this.values.has(name) ? this.values.get(name) : null;
    return type === 'json' && value !== null ? JSON.parse(value) : value;
  }
  async put(name, value) { this.values.set(name, String(value)); }
  async delete(name) { this.values.delete(name); }
  async list() { return { keys: [...this.values.keys()].sort().map((name) => ({ name })), list_complete: true }; }
}

class FakeRuntime {
  constructor(namespace, { realApi = false } = {}) { this.namespace = namespace; this.started = false; this.realApi = realApi; }
  async start() { this.started = true; return this; }
  async getLocalNamespace() { return this.namespace; }
  async dispatchFetch(url, init) {
    if (this.realApi) {
      return await appWorker.fetch(new Request(url, init), {
        TUBEPULSE_KV: this.namespace,
        TUBEPULSE_ENABLE_COMMUNITY_POSTS: 'false',
      }, { waitUntil() {}, passThroughOnException() {} });
    }
    return Response.json({ channels: [], authorization: init.headers.Authorization ? 'present' : 'missing' });
  }
  async close() { this.started = false; }
}

class FakeRunner {
  constructor() { this.started = false; }
  async start() { this.started = true; }
  async run() { throw new Error('standby must not arm scheduler'); }
  async status() { return { mode: 'standby', lease: { state: 'held' } }; }
  async close() { this.started = false; }
}

class FailingRunner extends FakeRunner {
  async start() { throw new Error('synthetic scheduler startup failure'); }
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-unified-service-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function config(dataDir) {
  return {
    mode: 'standby', dataDir, leaseTtlMs: 60_000,
    authority: { enabled: true, secret: SECRET, apiUrl: 'https://api.example.test', timeoutMs: 1000 },
    repoRoot: path.resolve('..'), workerBindings: {}, quiet: true,
    postsCadenceMinutes: 60, notificationsEnabled: false, remoteWriteEnabled: false,
  };
}

function signed(pathname, operation, payload) {
  const body = JSON.stringify(payload);
  const authorization = 'Bearer synthetic-device';
  return {
    body,
    headers: {
      ...signAuthorityRequest({ secret: SECRET, operation, target: pathname, authorization, body }),
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
  };
}

test('unified service exposes only status and signed authority ingress over the scheduler store', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const namespace = new MemoryNamespace({ setting: 'old' });
  const runner = new FakeRunner();
  const service = new UnifiedHomeAuthorityService(config(dataDir), {
    runtime: new FakeRuntime(namespace), runner,
    client: { status: async () => ({ ok: true, replication: { status: 'current' }, pendingBackupKeys: 0, backend: { selected: 'd1', ready: true } }) },
    host: '127.0.0.1', port: 0,
  });
  await service.start();
  t.after(() => service.close());
  const address = service.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  let response = await fetch(`${base}/_tubepulse/status`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.configuration.publicAppRoutes, false);
  assert.equal(status.configuration.periodicCanonicalPull, false);
  response = await fetch(`${base}/_tubepulse/monitoring`);
  assert.equal(response.status, 200);
  const monitoring = await response.json();
  assert.equal(monitoring.privacy, 'aggregate-only');
  assert.equal(Object.hasOwn(monitoring, 'deviceId'), false);
  response = await fetch(`${base}/_tubepulse/monitoring`, { method: 'POST' });
  assert.equal(response.status, 405);
  response = await fetch(`${base}/feed`);
  assert.equal(response.status, 404);

  const manifest = { hash: contentHash('synthetic'), recordCount: 1 };
  await service.gate.reconcile({ manifestHash: manifest.hash, recordCount: manifest.recordCount });
  const readHeaders = signAuthorityRequest({
    secret: SECRET,
    operation: 'authority-feed',
    method: 'GET',
    target: '/_tubepulse/authority/feed',
    authorization: 'Bearer synthetic-device',
    body: '',
  });
  response = await fetch(`${base}/_tubepulse/authority/feed`, {
    headers: { ...readHeaders, Authorization: 'Bearer synthetic-device' },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).authorization, 'present');
  const leaseId = 'service-api-lease-00001';
  let request = signed('/_tubepulse/authority/preflight', 'authority-preflight', {
    leaseId, method: 'POST', path: '/settings',
  });
  response = await fetch(`${base}/_tubepulse/authority/preflight`, { method: 'POST', ...request });
  assert.equal(response.status, 200);
  request = signed('/_tubepulse/authority/commit', 'authority-commit', {
    leaseId,
    deltas: [{ key: 'setting', operation: 'put', value: 'new', options: {}, baseHash: contentHash('old'), nextHash: contentHash('new') }],
  });
  response = await fetch(`${base}/_tubepulse/authority/commit`, { method: 'POST', ...request });
  assert.equal(response.status, 200);
  assert.equal(namespace.values.get('setting'), 'new');
  assert.equal(runner.started, true);
});

test('unified service closes an already-started runtime when scheduler startup fails', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const runtime = new FakeRuntime(new MemoryNamespace());
  const service = new UnifiedHomeAuthorityService(config(dataDir), {
    runtime,
    runner: new FailingRunner(),
    host: '127.0.0.1',
    port: 0,
  });
  await assert.rejects(() => service.start(), /synthetic scheduler startup failure/);
  assert.equal(runtime.started, false);
  assert.equal(service.server, null);
});

test('signed Home mutation runs real /seen semantics locally and the next Home feed stays seen', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const device = 'synthetic-device';
  const channelId = 'UCseen000000000000000000';
  const videoId = 'video-unwatched';
  const stateKey = `device:${device}:state:${channelId}`;
  const namespace = new MemoryNamespace({
    [`device:${device}:profile`]: JSON.stringify({
      platform: 'android', appVersion: '4.1.0', createdAt: 123, lastSeenAt: 1,
      futureProfileField: { preserved: true },
    }),
    [`device:${device}:channels`]: JSON.stringify([channelId]),
    [`device:${device}:settings`]: JSON.stringify({ includeCommunityPosts: false }),
    [`channel:${channelId}:meta`]: JSON.stringify({ name: 'Seen test' }),
    [`channel:${channelId}:recent`]: JSON.stringify([{ videoId, title: 'Test', link: 'https://example.test/video' }]),
    [stateKey]: JSON.stringify({ unwatched: [videoId], lastNagAt: 123, nagCount: 2 }),
    'nag:active': JSON.stringify([`${device}|${channelId}`]),
  });
  const service = new UnifiedHomeAuthorityService(config(dataDir), {
    runtime: new FakeRuntime(namespace, { realApi: true }),
    runner: new FakeRunner(), host: '127.0.0.1', port: 0,
  });
  await service.start();
  t.after(() => service.close());
  await service.gate.reconcile({ manifestHash: contentHash('seen-test'), recordCount: namespace.values.size });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const mutationBody = JSON.stringify({ channelId, videoIds: [videoId] });
  const leaseId = 'home-seen-mutation-00001';
  const mutation = signed('/_tubepulse/authority/mutation', 'authority-mutation', {
    leaseId,
    method: 'POST',
    path: '/seen',
    body: mutationBody,
    headers: { 'content-type': 'application/json' },
  });
  let response = await fetch(`${base}/_tubepulse/authority/mutation`, { method: 'POST', ...mutation });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.response.status, 200);
  assert.equal(result.deltas.some((delta) => delta.key === stateKey), true);
  assert.equal(result.deltas.some((delta) => delta.key === `device:${device}:profile`), true);
  assert.deepEqual(JSON.parse(namespace.values.get(stateKey)), { unwatched: [], lastNagAt: null, nagCount: 0 });
  const touchedProfile = JSON.parse(namespace.values.get(`device:${device}:profile`));
  assert.equal(touchedProfile.lastSeenAt > 1, true);
  assert.deepEqual(touchedProfile.futureProfileField, { preserved: true });
  assert.equal(touchedProfile.appVersion, '4.1.0');

  namespace.values.set(`device:${device}:profile`, JSON.stringify({ ...touchedProfile, lastSeenAt: 1 }));
  const invalid = signed('/_tubepulse/authority/mutation', 'authority-mutation', {
    leaseId: 'home-seen-invalid-00001',
    method: 'POST',
    path: '/seen',
    body: JSON.stringify({ videoIds: [videoId] }),
    headers: { 'content-type': 'application/json' },
  });
  response = await fetch(`${base}/_tubepulse/authority/mutation`, { method: 'POST', ...invalid });
  assert.equal(response.status, 200);
  const rejected = await response.json();
  assert.equal(rejected.response.status, 400);
  assert.deepEqual(rejected.deltas, []);
  assert.equal(JSON.parse(namespace.values.get(`device:${device}:profile`)).lastSeenAt, 1);
  assert.equal((await service.gate.status()).lease, null);

  const authorization = `Bearer ${device}`;
  const feedHeaders = signAuthorityRequest({
    secret: SECRET,
    operation: 'authority-feed',
    method: 'GET',
    target: '/_tubepulse/authority/feed',
    authorization,
    body: '',
  });
  response = await fetch(`${base}/_tubepulse/authority/feed`, {
    headers: { ...feedHeaders, Authorization: authorization },
  });
  assert.equal(response.status, 200);
  const feed = await response.json();
  assert.equal(feed.channels[0].videos[0].unwatched, false);
  assert.equal(feed.channels[0].unwatchedCount, 0);
});

test('an activity-touch failure cannot fail an otherwise successful Home mutation', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const device = 'synthetic-device';
  const profileKey = `device:${device}:profile`;
  const settingsKey = `device:${device}:settings`;
  const namespace = new MemoryNamespace({ [profileKey]: '{invalid-json' });
  const service = new UnifiedHomeAuthorityService(config(dataDir), {
    runtime: new FakeRuntime(namespace, { realApi: true }),
    runner: new FakeRunner(), host: '127.0.0.1', port: 0,
  });
  await service.start();
  t.after(() => service.close());
  await service.gate.reconcile({ manifestHash: contentHash('touch-failure-test'), recordCount: namespace.values.size });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const mutation = signed('/_tubepulse/authority/mutation', 'authority-mutation', {
    leaseId: 'home-touch-failure-0001',
    method: 'POST',
    path: '/settings',
    body: JSON.stringify({ settings: { mode: 'normal' } }),
    headers: { 'content-type': 'application/json' },
  });
  const response = await fetch(`${base}/_tubepulse/authority/mutation`, { method: 'POST', ...mutation });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.response.status, 200);
  assert.equal(result.deltas.some((delta) => delta.key === settingsKey), true);
  assert.equal(result.deltas.some((delta) => delta.key === profileKey), false);
  assert.equal(namespace.values.get(profileKey), '{invalid-json');
  assert.deepEqual(JSON.parse(namespace.values.get(settingsKey)), { mode: 'normal' });
});

test('the signed read-follow-up route refreshes a stale profile once without changing other fields', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const device = 'synthetic-device';
  const profileKey = `device:${device}:profile`;
  const namespace = new MemoryNamespace({
    [profileKey]: JSON.stringify({
      fcmToken: 'synthetic-token', platform: 'android', appVersion: '4.1.0',
      createdAt: 123, lastSeenAt: 1, futureProfileField: 'preserved',
    }),
  });
  const service = new UnifiedHomeAuthorityService(config(dataDir), {
    runtime: new FakeRuntime(namespace, { realApi: true }),
    runner: new FakeRunner(), host: '127.0.0.1', port: 0,
  });
  await service.start();
  t.after(() => service.close());
  await service.gate.reconcile({ manifestHash: contentHash('read-touch-test'), recordCount: namespace.values.size });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const activityRequest = (leaseId) => signed('/_tubepulse/authority/mutation', 'authority-mutation', {
    leaseId,
    method: 'POST',
    path: '/_tubepulse/activity-touch',
    body: '{}',
    headers: { 'content-type': 'application/json' },
  });

  let request = activityRequest('home-read-touch-000001');
  let response = await fetch(`${base}/_tubepulse/authority/mutation`, { method: 'POST', ...request });
  assert.equal(response.status, 200);
  let result = await response.json();
  assert.equal(result.response.status, 200);
  assert.equal(result.deltas.length, 1);
  assert.equal(result.deltas[0].key, profileKey);
  let profile = JSON.parse(namespace.values.get(profileKey));
  assert.equal(profile.lastSeenAt > 1, true);
  assert.equal(profile.futureProfileField, 'preserved');
  assert.equal(profile.fcmToken, 'synthetic-token');

  request = activityRequest('home-read-touch-000002');
  response = await fetch(`${base}/_tubepulse/authority/mutation`, { method: 'POST', ...request });
  assert.equal(response.status, 200);
  result = await response.json();
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.deltas, []);
  profile = JSON.parse(namespace.values.get(profileKey));
  assert.equal(profile.futureProfileField, 'preserved');
});
