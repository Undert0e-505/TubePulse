import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ActivePublicationStrategy,
  FileLease,
  HomeSchedulerRunner,
  MutationJournal,
  RecordingKv,
  WorkerKvFacade,
  createHomeSchedulerStateFile,
  mutationReason,
} from '../src/home-scheduler.mjs';
import {
  addToNagActive,
  getCachedFcmAccessToken,
  sendFCMPush,
  shouldRefreshCachedCommunityPost,
} from '../../worker/tubepulse-cron/shared.mjs';

class MemoryNamespace {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); }
  async get(name, type = 'text') {
    const value = this.values.has(name) ? this.values.get(name) : null;
    if (value === null || type !== 'json') return value;
    return JSON.parse(value);
  }
  async put(name, value) { this.values.set(name, String(value)); }
  async delete(name) { this.values.delete(name); }
  async list() {
    return { keys: [...this.values.keys()].sort().map((name) => ({ name })), list_complete: true };
  }
}

class MemoryAdapter {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
    this.writes = [];
  }
  async listKeys() { return [...this.values.keys()].sort().map((name) => ({ name })); }
  async get(name) { return this.values.has(name) ? this.values.get(name) : null; }
  async put(name, value) { this.writes.push({ operation: 'put', name }); this.values.set(name, String(value)); }
  async delete(name) { this.writes.push({ operation: 'delete', name }); this.values.delete(name); }
}

class FakeRuntime {
  constructor(namespace = new MemoryNamespace()) { this.namespace = namespace; this.started = false; }
  async start() { this.started = true; }
  async getLocalNamespace() { return this.namespace; }
  async close() { this.started = false; }
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-home-scheduler-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function config(dataDir, overrides = {}) {
  return {
    mode: 'shadow',
    dataDir,
    sync: { configured: true, accountId: 'a', namespaceId: 'n', apiToken: 't', concurrency: 4 },
    remoteWriteEnabled: false,
    notificationsEnabled: false,
    schedulesDisabled: false,
    concurrency: 5,
    channelTimeoutMs: 500,
    retryCount: 1,
    retryBackoffMs: 1,
    leaseTtlMs: 10_000,
    postsCadenceMinutes: 60,
    postsConcurrency: 3,
    postsMaxResponseBytes: 2 * 1024 * 1024,
    youtubeDailyQuotaUnits: 10_000,
    youtubeQuotaReserveUnits: 1_000,
    allowFiveMinutePosts: false,
    authority: {
      enabled: true,
      apiUrl: 'https://api.example.test',
      secret: 'synthetic-authority-secret-with-more-than-32-characters',
      timeoutMs: 1000,
    },
    workerBindings: {
      TUBEPULSE_ENABLE_COMMUNITY_POSTS: 'true',
      TUBEPULSE_NOTIFICATION_MODE: 'shadow',
      FIREBASE_SERVICE_ACCOUNT: '{"project_id":"test"}',
    },
    repoRoot: path.resolve('.'),
    quiet: true,
    ...overrides,
  };
}

class FakeAuthorityGate {
  constructor() { this.lease = null; this.stale = false; }
  async initialize() {}
  async status() { return { replication: { status: this.stale ? 'stale' : 'current' } }; }
  async acquire({ leaseId }) { if (this.stale || this.lease) throw new Error('authority unavailable'); this.lease = leaseId; }
  async renew() {}
  async verifyScheduler(leaseId) { assert.equal(this.lease, leaseId); }
  async release(leaseId) { assert.equal(this.lease, leaseId); this.lease = null; }
  async failLease(leaseId) { if (this.lease === leaseId) this.lease = null; this.stale = true; }
  async markStale() { this.stale = true; }
}

class FakeAuthorityClient {
  constructor(remote) { this.remote = remote; this.operations = { requests: 0, failures: 0 }; this.lease = null; }
  async acquirePublication() { this.operations.requests++; this.lease = `remote-${crypto.randomUUID()}`; return { leaseId: this.lease }; }
  async commitPublication(leaseId, deltas, { retainLease = false } = {}) {
    this.operations.requests++;
    assert.equal(leaseId, this.lease);
    for (const delta of deltas) {
      if (delta.operation === 'delete') await this.remote.delete(delta.key);
      else await this.remote.put(delta.key, delta.value);
    }
    if (!retainLease) this.lease = null;
  }
  async releasePublication() { this.operations.requests++; this.lease = null; }
}

function canonicalChannels(count) {
  const channels = Array.from({ length: count }, (_, index) => `UC${String(index).padStart(22, '0')}`);
  const entries = { 'channels:active': JSON.stringify(channels) };
  for (const channelId of channels) {
    entries[`channel:${channelId}:known:videos`] = JSON.stringify({
      ids: [`video-${channelId}`],
      highWatermarkAt: '2026-10-01T00:00:00.000Z',
      highWatermarkIds: [`video-${channelId}`],
      seededAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
  }
  return { channels, entries };
}

test('one shadow sweep covers all 82 channels once with bounded concurrency and no remote writes', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { channels, entries } = canonicalChannels(82);
  const remote = new MemoryAdapter(entries);
  let inFlight = 0;
  let maxInFlight = 0;
  const visited = [];
  const runner = new HomeSchedulerRunner({
    config: config(dataDir),
    runtime: new FakeRuntime(),
    remote,
    rssPoller: async (env, _ctx, channelId) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      visited.push(channelId);
      await new Promise((resolve) => setTimeout(resolve, 1));
      await env.TUBEPULSE_KV.put(`channel:${channelId}:recent`, JSON.stringify([{ videoId: `video-${channelId}` }]));
      inFlight--;
    },
    postPoller: async () => {},
    auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  const result = await runner.runTick(Date.UTC(2026, 9, 4, 12, 0), { forceSweep: true });
  assert.equal(result.sweep.uniqueActiveCount, 82);
  assert.equal(result.sweep.coveredCount, 82);
  assert.deepEqual([...new Set(visited)].sort(), channels);
  assert.ok(maxInFlight <= 5);
  assert.equal(remote.writes.length, 0);
  assert.equal(result.wouldNotify.total, 0);
  assert.equal(result.publication.apply, false);
  assert.equal(result.publication.predictedCanonicalWrites, 82);
});

test('consecutive shadow sweeps preserve local simulated state for steady-state write evidence', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { entries } = canonicalChannels(2);
  const runner = new HomeSchedulerRunner({
    config: config(dataDir), runtime: new FakeRuntime(), remote: new MemoryAdapter(entries),
    rssPoller: async (env, _ctx, channelId) => {
      await env.TUBEPULSE_KV.put(`channel:${channelId}:recent`, JSON.stringify([{ videoId: `video-${channelId}` }]));
    },
    postPoller: async () => {}, auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  const first = await runner.runTick(Date.UTC(2026, 9, 4, 12, 0), { forceSweep: true, forcePosts: false });
  const second = await runner.runTick(Date.UTC(2026, 9, 4, 12, 5), { forceSweep: true, forcePosts: false });
  assert.equal(first.mutations.localMutations, 2);
  assert.equal(first.seed.canonicalReset, true);
  assert.equal(second.seed.pendingLocal, 2);
  assert.equal(second.mutations.localMutations, 0);
  assert.equal(second.wouldNotify.total, 0);
});

test('RSS retry succeeds without losing deterministic coverage', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { channels, entries } = canonicalChannels(3);
  const attempts = new Map();
  const runner = new HomeSchedulerRunner({
    config: config(dataDir, { concurrency: 2 }),
    runtime: new FakeRuntime(),
    remote: new MemoryAdapter(entries),
    rssPoller: async (_env, _ctx, channelId) => {
      const count = (attempts.get(channelId) || 0) + 1;
      attempts.set(channelId, count);
      if (channelId === channels[1] && count === 1) throw new Error('transient');
    },
    postPoller: async () => {},
    auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  const result = await runner.runTick(Date.UTC(2026, 9, 4, 12, 0), { forceSweep: true });
  assert.equal(result.sweep.coveredCount, 3);
  assert.equal(result.sweep.failureCount, 0);
  assert.equal(result.sweep.retryCount, 1);
});

test('channel timeout is bounded and reported without aborting coverage', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { entries } = canonicalChannels(2);
  const runner = new HomeSchedulerRunner({
    config: config(dataDir, { channelTimeoutMs: 5, retryCount: 0 }),
    runtime: new FakeRuntime(), remote: new MemoryAdapter(entries),
    rssPoller: async (_env, _ctx, channelId) => {
      if (channelId.endsWith('1')) await new Promise((resolve) => setTimeout(resolve, 30));
    },
    postPoller: async () => {}, auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  const result = await runner.runTick(Date.UTC(2026, 9, 4, 12, 0), { forceSweep: true });
  assert.equal(result.sweep.coveredCount, 2);
  assert.equal(result.sweep.failureCount, 1);
  assert.equal(result.sweep.failures[0].errorCategory, 'poll-failed');
});

test('overlapping tick is skipped and counted', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { entries } = canonicalChannels(1);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const runner = new HomeSchedulerRunner({
    config: config(dataDir), runtime: new FakeRuntime(), remote: new MemoryAdapter(entries),
    rssPoller: async () => blocked, postPoller: async () => {}, auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  const first = runner.runTick(Date.UTC(2026, 9, 4, 12, 0), { forceSweep: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await runner.runTick(Date.UTC(2026, 9, 4, 12, 1));
  assert.equal(second.outcome, 'overlap-skipped');
  release();
  await first;
  assert.equal((await runner.status()).overlapSkips, 1);
});

test('restart resumes only channels not durably completed', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { channels, entries } = canonicalChannels(10);
  const stateFile = createHomeSchedulerStateFile(dataDir, 'shadow');
  await stateFile.write({
    schemaVersion: 1,
    mode: 'shadow', startedAt: null, stoppedAt: null, lease: null,
    currentSweep: {
      id: 'interrupted', status: 'running', scheduledAt: '2026-10-04T12:00:00.000Z',
      startedAt: '2026-10-04T12:00:00.000Z', channels, completedChannels: channels.slice(0, 4),
    },
    lastSweep: null, lastMinuteJobs: null, nextSweepAt: null, overlapSkips: 0,
  });
  const visited = [];
  const runner = new HomeSchedulerRunner({
    config: config(dataDir), runtime: new FakeRuntime(), remote: new MemoryAdapter(entries), stateFile,
    rssPoller: async (_env, _ctx, channelId) => visited.push(channelId),
    postPoller: async () => {}, auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  const result = await runner.runTick(Date.UTC(2026, 9, 4, 12, 0), { forceSweep: true });
  assert.deepEqual(visited.sort(), channels.slice(4).sort());
  assert.equal(result.sweep.coveredCount, 10);
});

test('file lease excludes a concurrent runner and recovers an expired owner', async (t) => {
  const dataDir = await temporaryDirectory(t);
  let now = Date.UTC(2026, 9, 4, 12, 0);
  const first = new FileLease({ dataDir, ttlMs: 1_000, now: () => now, owner: 'first' });
  const second = new FileLease({ dataDir, ttlMs: 1_000, now: () => now, owner: 'second' });
  await first.acquire();
  await assert.rejects(() => second.acquire(), /owns the active lease/);
  now += 2_000;
  await second.acquire();
  await second.release();
});

test('file lease acquisition is idempotent for the owning runner', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const first = new FileLease({ dataDir, ttlMs: 10_000, owner: 'first' });
  const second = new FileLease({ dataDir, ttlMs: 10_000, owner: 'second' });
  const original = await first.acquire();
  const repeated = await first.acquire();
  assert.deepEqual(repeated, original);
  await assert.rejects(() => second.acquire(), /owns the active lease/);
  await first.release();
});

test('scheduled tick failure is recorded, recovered, and contained by the timer', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const scheduledNow = Date.UTC(2026, 9, 4, 12, 0, 59, 995);
  let recovered = 0;
  let resolveRecovery;
  const recoveryFinished = new Promise((resolve) => { resolveRecovery = resolve; });
  const runner = new HomeSchedulerRunner({
    config: config(dataDir),
    runtime: new FakeRuntime(),
    remote: new MemoryAdapter(),
    now: () => scheduledNow,
    recoverAuthority: async () => {
      recovered++;
      runner.stopped = true;
      resolveRecovery();
      return { reconciled: true };
    },
  });
  runner.runTick = async () => { throw new Error('synthetic publication rejection'); };
  const state = await runner.stateFile.read();
  state.currentSweep = {
    id: 'failed-sweep', status: 'running', channels: ['UCtest'], completedChannels: ['UCtest'],
  };
  await runner.stateFile.write(state);
  runner.armNextMinute();
  await Promise.race([
    recoveryFinished,
    new Promise((_, reject) => setTimeout(() => reject(new Error('scheduled recovery timed out')), 500)),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const failed = await runner.stateFile.read();
  assert.equal(recovered, 1);
  assert.equal(failed.currentSweep.status, 'failed');
  assert.equal(failed.lastError.message, 'synthetic publication rejection');
  assert.equal(failed.lastError.recovery, 'reconciled');
  assert.equal(runner.stopped, true);
});

test('active startup does not resume a sweep whose local state was replaced by reconciliation', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { entries } = canonicalChannels(1);
  const stateFile = createHomeSchedulerStateFile(dataDir, 'active');
  const state = await stateFile.read();
  state.currentSweep = {
    id: 'interrupted-before-reconcile',
    status: 'running',
    startedAt: '2026-10-04T20:05:00.000Z',
    channels: ['UC0000000000000000000000'],
    completedChannels: ['UC0000000000000000000000'],
  };
  await stateFile.write(state);
  const gate = new FakeAuthorityGate();
  gate.status = async () => ({
    replication: { status: 'current' },
    manifest: { reconciledAt: '2026-10-04T20:31:30.000Z' },
  });
  const runner = new HomeSchedulerRunner({
    config: config(dataDir, {
      mode: 'active', remoteWriteEnabled: true, notificationsEnabled: true,
      schedulesDisabled: true, notificationBarrier: { configured: true },
    }),
    runtime: new FakeRuntime(new MemoryNamespace(entries)),
    stateFile,
    authorityGate: gate,
    authorityClient: new FakeAuthorityClient(new MemoryAdapter(entries)),
    notificationCoordinator: { async stage() {}, async flush() {}, async suppress() {} },
    rssPoller: async () => {}, postPoller: async () => {}, auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  const started = await stateFile.read();
  assert.equal(started.currentSweep.status, 'failed');
  assert.equal(started.currentSweep.failureReason, 'authority-reconciled-after-sweep-start');
});

test('standby performs no polling, mutation, notification, or remote write', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const remote = new MemoryAdapter(canonicalChannels(2).entries);
  let calls = 0;
  const runner = new HomeSchedulerRunner({
    config: config(dataDir, { mode: 'standby', sync: { configured: false, concurrency: 4 } }),
    runtime: new FakeRuntime(), remote: null,
    rssPoller: async () => { calls++; }, postPoller: async () => { calls++; }, auxRunner: async () => { calls++; },
  });
  await runner.start();
  t.after(() => runner.close());
  assert.deepEqual(await runner.runTick(), { outcome: 'standby' });
  assert.equal(calls, 0);
  assert.equal(remote.writes.length, 0);
});

test('minute job sweeps every post channel at the configured cadence and runs bounded aux each minute', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { entries } = canonicalChannels(6);
  const posts = [];
  let aux = 0;
  const runner = new HomeSchedulerRunner({
    config: config(dataDir), runtime: new FakeRuntime(), remote: new MemoryAdapter(entries),
    rssPoller: async () => {},
    postPoller: async (_env, _ctx, channelId) => posts.push(channelId),
    auxRunner: async () => { aux++; },
  });
  await runner.start();
  t.after(() => runner.close());
  await runner.runTick(Date.UTC(2026, 9, 4, 12, 0), { forceSweep: true });
  assert.equal(posts.length, 6);
  assert.equal(aux, 1);
  await runner.runTick(Date.UTC(2026, 9, 4, 12, 1));
  assert.equal(posts.length, 6, 'posts must not be repolled before the next configured boundary');
  assert.equal(aux, 2, 'aux remains due every minute');
});

test('post quota projection guards active cadence and reports five-minute cost', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { entries } = canonicalChannels(82);
  const shadow = new HomeSchedulerRunner({
    config: config(dataDir), runtime: new FakeRuntime(), remote: new MemoryAdapter(entries),
    rssPoller: async () => {}, postPoller: async () => {}, auxRunner: async () => {},
  });
  await shadow.start();
  const result = await shadow.runTick(Date.UTC(2026, 9, 4, 12, 0), { forceSweep: true });
  assert.equal(result.minuteJobs.posts.coveredCount, 82);
  assert.equal(result.minuteJobs.posts.quota.projectedDailyUnits, 1_968);
  assert.equal(result.minuteJobs.posts.quota.projectedFiveMinuteDailyUnits, 23_616);
  assert.equal(result.minuteJobs.posts.quota.requiredWithReserve, 2_968);
  assert.equal(result.minuteJobs.posts.quota.withinBudget, true);
  await shadow.close();

  const activeData = await temporaryDirectory(t);
  const activeConfig = config(activeData, {
    mode: 'active', remoteWriteEnabled: true, notificationsEnabled: true, schedulesDisabled: true,
    postsCadenceMinutes: 5, youtubeDailyQuotaUnits: 10_000,
  });
  const active = new HomeSchedulerRunner({
    config: activeConfig, runtime: new FakeRuntime(new MemoryNamespace(entries)), remote: new MemoryAdapter(entries),
    authorityGate: new FakeAuthorityGate(), authorityClient: new FakeAuthorityClient(new MemoryAdapter(entries)),
    rssPoller: async () => {}, postPoller: async () => {}, auxRunner: async () => {},
  });
  await assert.rejects(() => active.start(), /requires 24616 daily quota units/);
});

test('post sweep applies bounded retry and the local response-size ceiling', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { channels, entries } = canonicalChannels(2);
  const attempts = new Map();
  const observedLimits = [];
  const runner = new HomeSchedulerRunner({
    config: config(dataDir), runtime: new FakeRuntime(), remote: new MemoryAdapter(entries),
    rssPoller: async () => {},
    postPoller: async (_env, _ctx, channelId, _debug, options) => {
      observedLimits.push(options.maxResponseBytes);
      const count = (attempts.get(channelId) || 0) + 1;
      attempts.set(channelId, count);
      if (channelId === channels[0] && count === 1) throw new Error('transient');
    },
    auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  const result = await runner.runTick(Date.UTC(2026, 9, 4, 12, 0), { forceSweep: true });
  assert.equal(result.minuteJobs.posts.outcome, 'ok');
  assert.equal(result.minuteJobs.posts.retryCount, 1);
  assert.deepEqual([...new Set(observedLimits)], [2 * 1024 * 1024]);
});

test('predicted write accounting separates metric-only churn and redacts key identities', async () => {
  const namespace = new MemoryNamespace({
    'channel:UCprivate:recent': JSON.stringify([{ videoId: 'a', views: '10', likes: '1', viewsLastCheckedHour: 1 }]),
  });
  const journal = new MutationJournal();
  const kv = new RecordingKv(new WorkerKvFacade({
    get: (name) => namespace.get(name),
    put: (name, value) => namespace.put(name, value),
    delete: (name) => namespace.delete(name),
  }), journal);
  await kv.put('channel:UCprivate:recent', JSON.stringify([{ videoId: 'a', views: '20', likes: '1', viewsLastCheckedHour: 2 }]));
  const summary = journal.summary();
  assert.equal(summary.byReason['metrics-only'], 1);
  assert.equal(journal.events[0].keyHash.length, 16);
  assert.equal(Object.hasOwn(journal.events[0], 'key'), false);
  assert.equal(mutationReason('channel:UCx:known:videos', '[]', '["a"]'), 'dedupe-watermark');
  const cachedPost = [{
    activityId: 'Ugpost', text: 'same', fetchedAt: '2026-10-04T10:00:00.000Z',
    likeCount: 1, likeText: '1 like', viewCount: 10, viewText: '10 views',
  }];
  const metricRefresh = [{
    ...cachedPost[0], likeCount: 2, likeText: '2 likes', viewCount: 11, viewText: '11 views',
  }];
  const observationRefresh = [{
    ...metricRefresh[0], fetchedAt: '2026-10-04T11:00:00.000Z',
  }];
  assert.equal(
    mutationReason('channel:UCx:recent:posts', JSON.stringify(cachedPost), JSON.stringify(metricRefresh)),
    'post-metrics-only',
  );
  assert.equal(
    mutationReason('channel:UCx:recent:posts', JSON.stringify(cachedPost), JSON.stringify(observationRefresh)),
    'post-observation-metadata-only',
  );
  assert.equal(
    mutationReason(
      'channel:UCx:recent:posts',
      JSON.stringify(cachedPost),
      JSON.stringify([{ ...metricRefresh[0], text: 'changed' }]),
    ),
    'community-content-cache',
  );
});

test('community post cache ignores only rotating YouTube thumbnail delivery parameters', () => {
  const cached = {
    activityId: 'Ugpost',
    fetchedAt: '2026-10-04T10:00:00.000Z',
    publishedAt: '2026-10-03T10:00:00.000Z',
    publishedAtSource: 'estimated_from_relative',
    thumbnail: 'https://i.ytimg.com/abc/image.jpg?sqp=old&rs=old',
    text: 'same', publishedText: '1 day ago', likeCount: 1, likeText: '1 like',
    viewCount: null, viewText: null,
  };
  const rotatedDeliveryUrl = {
    ...cached,
    fetchedAt: '2026-10-04T11:00:00.000Z',
    thumbnail: 'https://i.ytimg.com/abc/image.jpg?rs=new&sqp=new',
  };
  assert.equal(shouldRefreshCachedCommunityPost(rotatedDeliveryUrl, [cached]), false);
  assert.equal(shouldRefreshCachedCommunityPost({
    ...rotatedDeliveryUrl,
    thumbnail: 'https://i.ytimg.com/abc/different.jpg?rs=new&sqp=new',
  }, [cached]), true);
  assert.equal(shouldRefreshCachedCommunityPost({
    ...rotatedDeliveryUrl,
    thumbnail: 'https://i.ytimg.com/abc/image.jpg?id=different&rs=new&sqp=new',
  }, [cached]), true);
  assert.equal(shouldRefreshCachedCommunityPost({
    ...rotatedDeliveryUrl,
    thumbnail: 'https://example.test/abc/image.jpg?rs=new&sqp=new',
  }, [{ ...cached, thumbnail: 'https://example.test/abc/image.jpg?rs=old&sqp=old' }]), true);
  assert.equal(shouldRefreshCachedCommunityPost({
    ...rotatedDeliveryUrl,
    publishedText: '2 days ago',
  }, [cached]), false, 'relative label churn is derived from a stable publishedAt');
  assert.equal(shouldRefreshCachedCommunityPost({
    ...rotatedDeliveryUrl,
    publishedAt: null,
    publishedText: '2 days ago',
  }, [{ ...cached, publishedAt: null }]), true, 'relative label remains authoritative without a timestamp');
});

test('shadow notification path cannot mint a token or contact FCM', async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('network must not be reached'); };
  try {
    const accessToken = await getCachedFcmAccessToken({ TUBEPULSE_NOTIFICATION_MODE: 'shadow' });
    const result = await sendFCMPush(accessToken, 'project', 'device-token', { title: 'test', body: 'test' });
    assert.equal(result.shadow, true);
    assert.equal(result.sent, false);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('active scheduler publishes canonical state before handing deferred notifications to the visibility barrier', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { channels, entries } = canonicalChannels(1);
  const remote = new MemoryAdapter(entries);
  let delivered = 0;
  const coordinator = {
    async stage() {},
    async flush(intents) {
      assert.equal(intents.length, 1);
      assert.ok(authorityClient.lease, 'global publication lease must span visibility and FCM');
      assert.equal(
        JSON.parse(await remote.get(`channel:${channels[0]}:recent`))[0].videoId,
        'new-video',
        'canonical write must complete before notification delivery begins',
      );
      await intents[0].onResult({ sent: true, deadToken: false });
      delivered++;
      return { queued: 1, sent: 1, failed: 0, suppressed: 0, barrier: 'passed' };
    },
  };
  const authorityClient = new FakeAuthorityClient(remote);
  const runner = new HomeSchedulerRunner({
    config: config(dataDir, {
      mode: 'active',
      remoteWriteEnabled: true,
      notificationsEnabled: true,
      schedulesDisabled: true,
      notificationBarrier: { configured: true },
    }),
    runtime: new FakeRuntime(new MemoryNamespace(entries)),
    remote,
    authorityGate: new FakeAuthorityGate(),
    authorityClient,
    notificationCoordinator: coordinator,
    rssPoller: async (env, _ctx, channelId) => {
      await env.TUBEPULSE_KV.put(`channel:${channelId}:recent`, JSON.stringify([{ videoId: 'new-video' }]));
      await env.TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER({
        kind: 'video', channelId, deviceId: 'device', projectId: 'project', fcmToken: 'token',
        payload: { tag: 'video-new-video' }, contentIds: ['new-video'], requireUnwatched: true,
        onResult: async () => {},
      });
    },
    postPoller: async () => {},
    auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  const result = await runner.runTick(Date.UTC(2026, 9, 4, 12, 0), { forceSweep: true, forcePosts: false });
  assert.equal(delivered, 1);
  assert.equal(result.notificationDelivery.sent, 1);
  assert.equal(result.wouldNotify.total, 1);
});

test('deferred canonical backup suppresses FCM even though the Home feed is current', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { entries } = canonicalChannels(1);
  const remote = new MemoryAdapter(entries);
  const authorityClient = new FakeAuthorityClient(remote);
  let queued = 0;
  authorityClient.commitPublication = async () => {
    authorityClient.operations.requests++;
    authorityClient.lease = null;
    queued = Math.max(queued, 1);
    return { ok: true, deferred: true, queued };
  };
  let suppressCalls = 0;
  const coordinator = {
    async stage() {},
    async suppress(intents, reason) {
      suppressCalls++;
      assert.equal(intents.length, 1);
      assert.equal(reason, 'canonical-backup-deferred');
      return { queued: 1, sent: 0, failed: 0, suppressed: 1, barrier: 'suppressed', reason };
    },
    async flush() { throw new Error('FCM must not run while canonical backup is deferred'); },
  };
  const runner = new HomeSchedulerRunner({
    config: config(dataDir, {
      mode: 'active', remoteWriteEnabled: true, notificationsEnabled: true,
      schedulesDisabled: true, notificationBarrier: { configured: true },
    }),
    runtime: new FakeRuntime(new MemoryNamespace(entries)), remote,
    authorityGate: new FakeAuthorityGate(), authorityClient,
    notificationCoordinator: coordinator,
    rssPoller: async (env, _ctx, channelId) => {
      await env.TUBEPULSE_KV.put(`channel:${channelId}:recent`, JSON.stringify([{ videoId: 'new-video' }]));
      await env.TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER({
        kind: 'video', channelId, deviceId: 'device', projectId: 'project', fcmToken: 'token',
        payload: { tag: 'video-new-video' }, contentIds: ['new-video'], requireUnwatched: true,
        onResult: async () => {},
      });
    },
    postPoller: async () => {}, auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  const result = await runner.runTick(Date.UTC(2026, 9, 4, 12, 0), { forceSweep: true, forcePosts: false });
  assert.equal(result.publication.canonicalBackupDeferred, true);
  assert.equal(result.notificationDelivery.sent, 0);
  assert.equal(result.notificationDelivery.reason, 'canonical-backup-deferred');
  assert.equal(suppressCalls, 1);
});

test('simultaneous API mutation and scheduler publication use global-then-local order without deadlock', async () => {
  const events = [];
  const local = new MemoryAdapter({ alpha: 'one', profile: 'old' });
  const remote = new MemoryAdapter({ alpha: 'one', profile: 'old' });
  const gate = {
    lease: null,
    stale: false,
    async acquire({ leaseId }) {
      assert.equal(this.lease, null, 'local authority operations must not overlap');
      this.lease = leaseId;
      events.push(leaseId.startsWith('api-') ? 'api-local-acquire' : 'scheduler-local-acquire');
    },
    async release(leaseId) {
      assert.equal(this.lease, leaseId);
      events.push(leaseId.startsWith('api-') ? 'api-local-release' : 'scheduler-local-release');
      this.lease = null;
    },
    async renew() {},
    async verifyScheduler(leaseId) { assert.equal(this.lease, leaseId); events.push('scheduler-local-verify'); },
    async failLease(leaseId) { if (this.lease === leaseId) this.lease = null; this.stale = true; },
    async markStale() { this.stale = true; },
  };
  let globalOwner = null;
  const client = {
    operations: { requests: 0, failures: 0 },
    async acquirePublication() {
      events.push('scheduler-global-wait');
      // Deterministically run the already-arriving API mutation first. It
      // acquires global -> local after the scheduler released its polling
      // lease, commits a disjoint exact delta, then drains.
      globalOwner = 'api';
      events.push('api-global-acquire');
      await gate.acquire({ leaseId: 'api-overlap-lease-0001' });
      await local.put('profile', 'new');
      await remote.put('profile', 'new');
      await gate.release('api-overlap-lease-0001');
      events.push('api-global-release');
      globalOwner = 'scheduler';
      events.push('scheduler-global-acquire');
      return { leaseId: 'remote-scheduler-lease' };
    },
    async commitPublication(leaseId, deltas) {
      assert.equal(globalOwner, 'scheduler');
      assert.equal(leaseId, 'remote-scheduler-lease');
      events.push('scheduler-global-commit');
      for (const delta of deltas) await remote.put(delta.key, delta.value);
      globalOwner = null;
    },
    async releasePublication() { globalOwner = null; },
  };
  const strategy = new ActivePublicationStrategy({ local, gate, client, leaseTtlMs: 10_000 });
  await strategy.prepare();
  const journal = new MutationJournal();
  const target = new RecordingKv(strategy.target(), journal);
  await target.put('alpha', 'two');
  const result = await Promise.race([
    strategy.finish(journal, { final: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock')), 1_000)),
  ]);
  assert.equal(result.appliedWrites, 1);
  assert.equal(remote.values.get('alpha'), 'two');
  assert.equal(remote.values.get('profile'), 'new');
  assert.equal(gate.stale, false);
  assert.deepEqual(events, [
    'scheduler-local-acquire', 'scheduler-local-release', 'scheduler-global-wait',
    'api-global-acquire', 'api-local-acquire', 'api-local-release', 'api-global-release',
    'scheduler-global-acquire', 'scheduler-local-acquire', 'scheduler-global-commit',
    'scheduler-local-verify', 'scheduler-local-release',
  ]);
});

test('publication cap coalesces a durable backup queue and flushes it after quota recovery while Home stays readable', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const local = new MemoryAdapter({ alpha: 'one' });
  const remote = new MemoryAdapter({ alpha: 'one' });
  const gate = new FakeAuthorityGate();
  let capped = true;
  const client = new FakeAuthorityClient(remote);
  const originalCommit = client.commitPublication.bind(client);
  let pending = [];
  client.commitPublication = async (leaseId, deltas, options) => {
    if (capped) {
      pending = deltas;
      client.lease = null;
      return { ok: true, deferred: true, queued: pending.length };
    }
    const combined = [...pending, ...deltas];
    pending = [];
    await originalCommit(leaseId, combined, options);
    return { ok: true, deferred: false, applied: combined.length };
  };
  const strategy = new ActivePublicationStrategy({
    local, gate, client, leaseTtlMs: 10_000,
  });

  await strategy.prepare();
  let journal = new MutationJournal();
  let target = new RecordingKv(strategy.target(), journal);
  await target.put('alpha', 'two');
  let result = await strategy.finish(journal, { final: true });
  assert.equal(result.canonicalBackupDeferred, true);
  assert.equal(result.queuedBackupWrites, 1);
  assert.equal(local.values.get('alpha'), 'two');
  assert.equal(remote.values.get('alpha'), 'one');
  assert.equal(gate.stale, false);
  assert.equal(pending.length, 1);

  capped = false;
  await strategy.prepare();
  journal = new MutationJournal();
  result = await strategy.finish(journal, { final: true });
  assert.equal(result.appliedWrites, 1);
  assert.equal(remote.values.get('alpha'), 'two');
  assert.equal(pending.length, 0);
  assert.equal(gate.stale, false);
});

test('concurrent channel work serializes shared notification indexes', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { entries } = canonicalChannels(8);
  const runner = new HomeSchedulerRunner({
    config: config(dataDir, { concurrency: 8 }), runtime: new FakeRuntime(), remote: new MemoryAdapter(entries),
    rssPoller: async (env, _ctx, channelId) => {
      await addToNagActive(env, 'synthetic-device', channelId);
    },
    postPoller: async () => {}, auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  await runner.runTick(Date.UTC(2026, 9, 4, 12, 0), { forceSweep: true });
  const localNamespace = runner.runtime.namespace;
  const active = await localNamespace.get('nag:active', 'json');
  assert.equal(active.length, 8);
  assert.equal(new Set(active).size, 8);
});
