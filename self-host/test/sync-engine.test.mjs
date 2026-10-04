import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudflareKvError, contentHash } from '../src/kv-adapters.mjs';
import {
  resolveCanonicalChannelMetaPullConflict,
  resolveCanonicalGatewayPullConflict,
  resolveCanonicalProfilePullConflict,
  SyncEngine,
} from '../src/sync-engine.mjs';

class MemoryStateFile {
  constructor(value) {
    this.value = value || { schemaVersion: 1, baseline: {}, conflicts: {}, lastPull: null, lastPush: null };
  }
  async read() { return structuredClone(this.value); }
  async write(value) { this.value = structuredClone(value); }
}

class FakeAdapter {
  constructor(entries = {}) {
    this.records = new Map();
    for (const [key, record] of Object.entries(entries)) {
      this.records.set(key, typeof record === 'string' ? { value: record } : { ...record });
    }
    this.failPut = null;
    this.failDelete = null;
  }
  async listKeys() {
    return [...this.records].map(([name, record]) => ({ name, expiration: record.expiration }));
  }
  async get(key) { return this.records.get(key)?.value ?? null; }
  async put(key, value, options = {}) {
    if (this.failPut) throw this.failPut;
    this.records.set(key, { value, ...(Number.isFinite(options.expiration) ? { expiration: options.expiration } : {}) });
  }
  async delete(key) {
    if (this.failDelete) throw this.failDelete;
    this.records.delete(key);
  }
  value(key) { return this.records.get(key)?.value ?? null; }
  expiration(key) { return this.records.get(key)?.expiration; }
}

function createEngine(local, remote, stateFile = new MemoryStateFile(), options = {}) {
  return {
    stateFile,
    engine: new SyncEngine({ local, remote, stateFile, concurrency: 2, writeEnabled: true, ...options }),
  };
}

test('initial pull imports remote-only data and retains local-only data as pending', async () => {
  const local = new FakeAdapter({ local: 'mine' });
  const remote = new FakeAdapter({ remote: 'cloud' });
  const { engine, stateFile } = createEngine(local, remote);
  const result = await engine.pull();
  assert.equal(local.value('remote'), 'cloud');
  assert.equal(local.value('local'), 'mine');
  assert.equal(result.imported, 1);
  assert.equal(result.pendingLocal, 1);
  assert.equal(result.status, 'pending');
  assert.ok(stateFile.value.baseline.remote.hash);
  assert.equal(stateFile.value.baseline.local, undefined);
});

test('pull applies remote-only changes but never overwrites a locally dirty key', async () => {
  const local = new FakeAdapter();
  const remote = new FakeAdapter({ key: 'v1' });
  const { engine } = createEngine(local, remote);
  await engine.pull();
  await remote.put('key', 'v2');
  let result = await engine.pull();
  assert.equal(local.value('key'), 'v2');
  assert.equal(result.updated, 1);

  await local.put('key', 'local-v3');
  result = await engine.pull();
  assert.equal(local.value('key'), 'local-v3');
  assert.equal(result.pendingLocal, 1);
});

test('pull quarantines a true two-sided conflict and preserves local data', async () => {
  const local = new FakeAdapter();
  const remote = new FakeAdapter({ key: 'base' });
  const { engine, stateFile } = createEngine(local, remote);
  await engine.pull();
  await local.put('key', 'local');
  await remote.put('key', 'remote');
  const result = await engine.pull();
  assert.equal(result.conflicts, 1);
  assert.equal(result.status, 'conflict');
  assert.equal(local.value('key'), 'local');
  assert.equal(stateFile.value.conflicts.key.operation, 'pull');
  assert.ok(stateFile.value.conflicts.key.local.hash);
  assert.ok(stateFile.value.conflicts.key.remote.hash);
  assert.equal('value' in stateFile.value.conflicts.key.local, false);
});

test('gateway mirror resolves only a self-generated lastSeenAt profile conflict to canonical Cloudflare', async () => {
  const key = 'device:synthetic-canary:profile';
  const base = JSON.stringify({
    fcmToken: 'synthetic-token',
    platform: 'android',
    appVersion: '3.5.2',
    createdAt: 100,
    lastSeenAt: 100,
  });
  const local = new FakeAdapter();
  const remote = new FakeAdapter({ [key]: base });
  const { engine, stateFile } = createEngine(local, remote, undefined, {
    resolvePullConflict: resolveCanonicalProfilePullConflict,
  });
  await engine.pull();
  const localReplay = JSON.stringify({ ...JSON.parse(base), lastSeenAt: 201 });
  const canonical = JSON.stringify({ ...JSON.parse(base), lastSeenAt: 200 });
  await local.put(key, localReplay);
  await remote.put(key, canonical);

  const result = await engine.pull();
  assert.equal(result.status, 'ok');
  assert.equal(result.conflicts, 0);
  assert.equal(result.resolved, 1);
  assert.equal(local.value(key), canonical);
  assert.equal(stateFile.value.baseline[key].hash, contentHash(canonical));
  assert.equal(stateFile.value.conflicts[key], undefined);
});

test('gateway mirror preserves a genuine profile conflict', async () => {
  const key = 'device:synthetic-canary:profile';
  const base = JSON.stringify({ fcmToken: 'base-token', platform: 'android', createdAt: 100, lastSeenAt: 100 });
  const local = new FakeAdapter();
  const remote = new FakeAdapter({ [key]: base });
  const { engine, stateFile } = createEngine(local, remote, undefined, {
    resolvePullConflict: resolveCanonicalProfilePullConflict,
  });
  await engine.pull();
  const localChange = JSON.stringify({ ...JSON.parse(base), fcmToken: 'local-token', lastSeenAt: 201 });
  const remoteChange = JSON.stringify({ ...JSON.parse(base), fcmToken: 'canonical-token', lastSeenAt: 200 });
  await local.put(key, localChange);
  await remote.put(key, remoteChange);

  const result = await engine.pull();
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts, 1);
  assert.equal(result.resolved, 0);
  assert.equal(local.value(key), localChange);
  assert.equal(stateFile.value.conflicts[key].operation, 'pull');
});

test('gateway profile resolution never masks durable profile or non-profile divergence', () => {
  const key = 'device:synthetic-canary:profile';
  const base = {
    fcmToken: 'synthetic-token',
    platform: 'android',
    appVersion: '3.5.2',
    createdAt: 100,
    lastSeenAt: 200,
  };
  const record = (value) => ({ value: JSON.stringify(value) });
  const variants = [
    { ...base, fcmToken: 'rotated-token', lastSeenAt: 201 },
    { ...base, platform: 'ios', lastSeenAt: 201 },
    { ...base, appVersion: '3.5.3', lastSeenAt: 201 },
    { ...base, createdAt: 101, lastSeenAt: 201 },
    { ...base, notificationPermission: 'granted', lastSeenAt: 201 },
  ];

  for (const localProfile of variants) {
    assert.equal(resolveCanonicalProfilePullConflict({
      key,
      local: record(localProfile),
      remote: record(base),
    }), null);
  }

  assert.equal(resolveCanonicalProfilePullConflict({
    key: 'device:synthetic-canary:settings',
    local: record({ includeCommunityPosts: true }),
    remote: record({ includeCommunityPosts: false }),
  }), null);
  assert.equal(resolveCanonicalProfilePullConflict({
    key: 'device:synthetic-canary:channels',
    local: record(['channel-a', 'channel-b']),
    remote: record(['channel-a']),
  }), null);
});

test('gateway mirror resolves only an independently generated channel metadata addedAt', async () => {
  const key = 'channel:UCsynthetic:meta';
  const localValue = JSON.stringify({
    name: 'Synthetic channel',
    avatarUrl: 'https://example.invalid/avatar.jpg',
    lastVideoId: 'video-1',
    addedAt: 1_700_000_000_001,
  });
  const canonical = JSON.stringify({
    lastVideoId: 'video-1',
    name: 'Synthetic channel',
    addedAt: 1_700_000_000_999,
    avatarUrl: 'https://example.invalid/avatar.jpg',
  });
  const local = new FakeAdapter({ [key]: localValue });
  const remote = new FakeAdapter({ [key]: canonical });
  const { engine, stateFile } = createEngine(local, remote, undefined, {
    resolvePullConflict: resolveCanonicalGatewayPullConflict,
  });

  const result = await engine.pull();

  assert.equal(result.status, 'ok');
  assert.equal(result.conflicts, 0);
  assert.equal(result.resolved, 1);
  assert.equal(local.value(key), canonical);
  assert.equal(stateFile.value.baseline[key].hash, contentHash(canonical));
  assert.equal(stateFile.value.conflicts[key], undefined);
});

test('channel metadata resolution rejects every difference except a valid addedAt timestamp', () => {
  const key = 'channel:UCsynthetic:meta';
  const canonical = {
    name: 'Synthetic channel',
    avatarUrl: 'https://example.invalid/avatar.jpg',
    lastVideoId: 'video-1',
    addedAt: 1_700_000_000_999,
  };
  const localBase = { ...canonical, addedAt: 1_700_000_000_001 };
  const record = (value) => ({ value: JSON.stringify(value) });
  const divergent = [
    { ...localBase, name: 'Different name' },
    { ...localBase, avatarUrl: null },
    { ...localBase, lastVideoId: 'video-2' },
    { ...localBase, channelId: 'different-id' },
    { ...localBase, handle: '@different' },
    { ...localBase, extra: true },
    { ...localBase, addedAt: '2026-10-04T13:59:09.091Z' },
    { ...localBase, addedAt: 1.5 },
    { ...localBase, addedAt: Number.MAX_SAFE_INTEGER },
    ['not', 'metadata'],
    'not-metadata',
  ];

  for (const value of divergent) {
    assert.equal(resolveCanonicalChannelMetaPullConflict({
      key,
      local: record(value),
      remote: record(canonical),
    }), null);
  }

  for (const [localValue, remoteValue] of [
    [{ ...localBase, handle: '@local' }, { ...canonical, handle: '@canonical' }],
    [{ ...localBase, channelId: 'UC-local' }, { ...canonical, channelId: 'UC-remote' }],
    [{ ...localBase, type: 'local' }, { ...canonical, type: 'remote' }],
    [{ ...localBase, extension: false }, { ...canonical, extension: true }],
  ]) {
    assert.equal(resolveCanonicalChannelMetaPullConflict({
      key,
      local: record(localValue),
      remote: record(remoteValue),
    }), null);
  }

  const missingAddedAt = { ...localBase };
  delete missingAddedAt.addedAt;
  assert.equal(resolveCanonicalChannelMetaPullConflict({
    key,
    local: record(missingAddedAt),
    remote: record(canonical),
  }), null);
  assert.equal(resolveCanonicalChannelMetaPullConflict({
    key: 'channel:UCsynthetic:recent',
    local: record(localBase),
    remote: record(canonical),
  }), null);
  assert.equal(resolveCanonicalChannelMetaPullConflict({
    key: 'device:synthetic-canary:settings',
    local: record(localBase),
    remote: record(canonical),
  }), null);
  assert.equal(resolveCanonicalChannelMetaPullConflict({
    key,
    local: record(localBase),
    remote: record({ ...canonical, addedAt: 'not-a-timestamp' }),
  }), null);
  assert.equal(resolveCanonicalChannelMetaPullConflict({
    key,
    local: { value: '{malformed' },
    remote: record(canonical),
  }), null);

  for (const otherKey of [
    'device:synthetic-canary:settings',
    'device:synthetic-canary:channels',
    'channel:UCsynthetic:subscribers',
    'channel:UCsynthetic:recent',
    'channels:active',
  ]) {
    assert.equal(resolveCanonicalGatewayPullConflict({
      key: otherKey,
      local: record(localBase),
      remote: record(canonical),
    }), null);
  }
});

test('pull and push safely reconcile deletes', async () => {
  const local = new FakeAdapter();
  const remote = new FakeAdapter({ key: 'base' });
  const { engine } = createEngine(local, remote);
  await engine.pull();
  await remote.delete('key');
  const pulled = await engine.pull();
  assert.equal(pulled.deleted, 1);
  assert.equal(local.value('key'), null);

  await remote.put('other', 'base');
  await engine.pull();
  await local.delete('other');
  const dryRun = await engine.push();
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.plannedDeletes, 1);
  assert.equal(remote.value('other'), 'base');
  const applied = await engine.push({ apply: true });
  assert.equal(applied.appliedDeletes, 1);
  assert.equal(remote.value('other'), null);
});

test('push defaults to dry-run and apply guards against a changed remote', async () => {
  const local = new FakeAdapter();
  const remote = new FakeAdapter({ key: 'base' });
  const { engine, stateFile } = createEngine(local, remote);
  await engine.pull();
  await local.put('key', 'local');
  const dryRun = await engine.push();
  assert.equal(dryRun.plannedPuts, 1);
  assert.equal(dryRun.appliedPuts, 0);
  assert.equal(remote.value('key'), 'base');
  await remote.put('key', 'changed-after-dry-run');
  const applied = await engine.push({ apply: true });
  assert.equal(applied.conflicts, 1);
  assert.equal(applied.appliedPuts, 0);
  assert.equal(remote.value('key'), 'changed-after-dry-run');
  assert.equal(stateFile.value.conflicts.key.operation, 'push');
});

test('successful put preserves expiration in comparison and on remote write', async () => {
  const expiration = 2_000_000_000;
  const local = new FakeAdapter();
  const remote = new FakeAdapter({ key: { value: 'base', expiration } });
  const { engine } = createEngine(local, remote);
  await engine.pull();
  assert.equal(local.expiration('key'), expiration);
  await local.put('key', 'local-change', { expiration });
  const result = await engine.push({ apply: true });
  assert.equal(result.conflicts, 0);
  assert.equal(result.appliedPuts, 1);
  assert.equal(remote.value('key'), 'local-change');
  assert.equal(remote.expiration('key'), expiration);
});

test('a retryable 429 write leaves the local change pending', async () => {
  const local = new FakeAdapter();
  const remote = new FakeAdapter({ key: 'base' });
  const { engine, stateFile } = createEngine(local, remote);
  await engine.pull();
  await local.put('key', 'pending');
  remote.failPut = new CloudflareKvError('rate limited', { status: 429, operation: 'write', retryable: true });
  const result = await engine.push({ apply: true });
  assert.equal(result.status, 'partial');
  assert.equal(result.pending, 1);
  assert.equal(result.failures[0].retryable, true);
  assert.equal(remote.value('key'), 'base');
  assert.equal(stateFile.value.baseline.key.hash, contentHash('base'));
});

test('public sync status exposes counts but not conflict keys or raw failure bodies', async () => {
  const stateFile = new MemoryStateFile({
    schemaVersion: 1,
    baseline: {},
    conflicts: { 'device:sensitive-id:profile': { operation: 'push' } },
    lastPull: null,
    lastPush: {
      at: new Date().toISOString(),
      status: 'partial',
      pending: 1,
      failures: [{ key: 'device:sensitive-id:profile', message: 'raw upstream response' }],
    },
  });
  const { engine } = createEngine(new FakeAdapter(), new FakeAdapter(), stateFile);
  const status = await engine.status();
  const serialized = JSON.stringify(status);
  assert.equal(status.conflictCount, 1);
  assert.equal(status.pendingCount, 1);
  assert.equal(status.lastPush.failureCount, 1);
  assert.equal(serialized.includes('sensitive-id'), false);
  assert.equal(serialized.includes('raw upstream'), false);
});

test('sensitive and ephemeral keys are excluded by default', async () => {
  const local = new FakeAdapter();
  const remote = new FakeAdapter({
    'fcm:cache:token': 'secret-token',
    'fcm:lookup:registration-token': 'device-id',
    'channel:abc:websub': 'lease',
    [`gateway:canary:${'a'.repeat(64)}:state`]: '{"status":"stale"}',
    'channels:active': '[]',
  });
  const { engine, stateFile } = createEngine(local, remote);
  const result = await engine.pull();
  assert.equal(result.excluded, 4);
  assert.equal(local.value('fcm:cache:token'), null);
  assert.equal(local.value('channel:abc:websub'), null);
  assert.equal(local.value('fcm:lookup:registration-token'), null);
  assert.equal(local.value(`gateway:canary:${'a'.repeat(64)}:state`), null);
  assert.equal(local.value('channels:active'), '[]');
  assert.deepEqual(Object.keys(stateFile.value.baseline), ['channels:active']);
});
