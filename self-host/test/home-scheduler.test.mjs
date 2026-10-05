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
  mergeCachedCommunityPostForPersistence,
  shouldRefreshCachedCommunityPost,
} from '../../worker/tubepulse-cron/shared.mjs';
import { fallbackChannelsForMinute, pacificQuotaWindow, normalizeRssHealthState } from '../src/home-rss-policy.mjs';
import { AuthorityClient } from '../src/authority-client.mjs';
import { createAuthorityWorker } from '../../worker/tubepulse-api/authority.mjs';
import { pollSingleCommunityChannel } from '../../worker/tubepulse-posts/index.js';

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
    rssChannelTimeoutMs: 500,
    rssCircuitInitialCooldownMinutes: 15,
    rssCircuitMaximumCooldownMinutes: 60,
    rssRecoverySuccessesRequired: 2,
    channelTimeoutMs: 500,
    retryCount: 1,
    retryBackoffMs: 1,
    leaseTtlMs: 10_000,
    postsCadenceMinutes: 60,
    postsConcurrency: 3,
    postsMaxResponseBytes: 2 * 1024 * 1024,
    youtubeDailyQuotaUnits: 10_000,
    youtubeQuotaReserveUnits: 1_000,
    youtubeApiFallback: { enabled: false, configured: false, dailyCap: null },
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

function remoteProbe(outcome, classification = outcome === 'success' ? 'valid-feed' : 'http-404', status = outcome === 'success' ? 200 : 404) {
  return { ok: true, outcome, probes: ['official', 'active'].map((label) => ({
    label, status, validXml: outcome === 'success', classification,
  })) };
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

test('regular ticks stagger one exact no-retry RSS cycle and partial failure cannot open the fleet circuit', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { channels, entries } = canonicalChannels(9);
  const namespace = new MemoryNamespace();
  const remote = new MemoryAdapter(entries);
  const visited = [];
  let remoteProbes = 0;
  let clock = Date.UTC(2026, 9, 5, 12, 0);
  const runner = new HomeSchedulerRunner({
    config: config(dataDir), runtime: new FakeRuntime(namespace), remote, now: () => clock,
    authorityClient: { async probeRss() { remoteProbes++; return { outcome: 'failure', probes: [] }; } },
    rssPoller: async (_env, _ctx, channelId) => {
      visited.push(channelId);
      if (channelId === channels[0]) {
        const error = new Error('synthetic 404');
        error.category = 'http-404';
        throw error;
      }
    },
    postPoller: async () => {}, auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  const results = [];
  for (let minute = 0; minute < 5; minute++) {
    clock = Date.UTC(2026, 9, 5, 12, minute);
    results.push(await runner.runTick(clock));
  }
  assert.equal(visited.length, channels.length);
  assert.deepEqual([...new Set(visited)].sort(), channels);
  assert.ok(visited.every((channelId) => visited.filter((entry) => entry === channelId).length === 1));
  assert.ok(results.every((result) => result.sweep.retryCount === 0 && result.sweep.concurrency === 1));
  const state = await runner.status();
  assert.equal(state.rssHealth.sourceMode, 'rss');
  assert.equal(state.rssHealth.circuit.open, false);
  assert.equal(remoteProbes, 0);
});

test('staggered cycle progress survives restart without polling a completed cohort twice', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { entries } = canonicalChannels(5);
  const namespace = new MemoryNamespace();
  const remote = new MemoryAdapter(entries);
  const visited = [];
  const scheduled = Date.UTC(2026, 9, 5, 12, 0);
  const makeRunner = () => new HomeSchedulerRunner({
    config: config(dataDir), runtime: new FakeRuntime(namespace), remote, now: () => scheduled,
    rssPoller: async (_env, _ctx, channelId) => { visited.push(channelId); },
    postPoller: async () => {}, auxRunner: async () => {},
  });
  const first = makeRunner();
  await first.start();
  await first.runTick(scheduled);
  await first.close();
  const second = makeRunner();
  await second.start();
  t.after(() => second.close());
  await second.runTick(scheduled);
  assert.equal(visited.length, 1);
  const state = await second.status();
  assert.equal(state.rssHealth.currentCycle.results.filter(Boolean).length, 1);
});

test('all-home 404 plus independent success enters home-egress backoff without API fallback', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { channels, entries } = canonicalChannels(5);
  entries[`channel:${channels[0]}:recent`] = JSON.stringify([{ videoId: 'last-good' }]);
  const namespace = new MemoryNamespace();
  let clock = Date.UTC(2026, 9, 5, 12, 0);
  let apiCalls = 0;
  let probeCalls = 0;
  let postCalls = 0;
  let auxCalls = 0;
  const runner = new HomeSchedulerRunner({
    config: config(dataDir, {
      rssCircuitInitialCooldownMinutes: 15,
      workerBindings: {
        TUBEPULSE_ENABLE_COMMUNITY_POSTS: 'true', TUBEPULSE_NOTIFICATION_MODE: 'shadow',
        FIREBASE_SERVICE_ACCOUNT: '{"project_id":"test"}', YOUTUBE_API_KEY: 'configured',
      },
      youtubeApiFallback: { enabled: true, configured: true, dailyCap: null },
    }),
    runtime: new FakeRuntime(namespace), remote: new MemoryAdapter(entries), now: () => clock,
    authorityClient: { async probeRss() {
      probeCalls++;
      return remoteProbe('success');
    } },
    rssPoller: async () => { const error = new Error('404'); error.category = 'http-404'; throw error; },
    youtubeApiFetcher: async () => { apiCalls++; throw new Error('must not use API'); },
    postPoller: async () => { postCalls++; }, auxRunner: async () => { auxCalls++; },
  });
  await runner.start();
  t.after(() => runner.close());
  for (let minute = 0; minute < 5; minute++) {
    clock = Date.UTC(2026, 9, 5, 12, minute);
    await runner.runTick(clock);
  }
  let state = await runner.status();
  assert.equal(state.rssHealth.sourceMode, 'home-egress-throttled');
  assert.equal(state.rssHealth.circuit.open, true);
  assert.equal(state.rssHealth.circuit.reason, 'full-fleet-http-404');
  assert.equal(probeCalls, 1);
  assert.equal(JSON.stringify(state).includes(channels[0]), false, 'scheduler status must not expose channel identities');
  clock = Date.UTC(2026, 9, 5, 12, 5);
  await runner.runTick(clock);
  state = await runner.status();
  assert.equal(apiCalls, 0);
  assert.equal(postCalls, channels.length, 'hourly posts remain due during the RSS outage');
  assert.equal(auxCalls, 6, 'aux remains due every minute during the RSS outage');
  assert.equal(state.lastError, null);
  assert.deepEqual(JSON.parse(namespace.values.get(`channel:${channels[0]}:recent`)), [{ videoId: 'last-good' }]);
});

test('all-home 404 plus independent failure enables staggered API fallback within quota', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { channels, entries } = canonicalChannels(5);
  const namespace = new MemoryNamespace();
  let clock = Date.UTC(2026, 9, 5, 12, 0);
  const apiChannels = [];
  const runner = new HomeSchedulerRunner({
    config: config(dataDir, {
      rssCircuitInitialCooldownMinutes: 60,
      rssCircuitMaximumCooldownMinutes: 60,
      workerBindings: {
        TUBEPULSE_ENABLE_COMMUNITY_POSTS: 'true', TUBEPULSE_NOTIFICATION_MODE: 'shadow',
        FIREBASE_SERVICE_ACCOUNT: '{"project_id":"test"}', YOUTUBE_API_KEY: 'configured',
      },
      youtubeApiFallback: { enabled: true, configured: true, dailyCap: null },
    }),
    runtime: new FakeRuntime(namespace), remote: new MemoryAdapter(entries), now: () => clock,
    authorityClient: { async probeRss() {
      return remoteProbe('failure');
    } },
    rssPoller: async () => { const error = new Error('404'); error.category = 'http-404'; throw error; },
    youtubeApiFetcher: async (channelId) => {
      apiChannels.push(channelId);
      return {
        channelName: 'Synthetic',
        uploads: [{
          videoId: `video-${channelId}`, title: 'Existing upload', published: '2026-10-01T00:00:00.000Z',
          thumbnail: null, link: 'https://example.test/video', channelTitle: 'Synthetic',
          views: null, likes: null, dislikes: null,
        }],
      };
    },
    postPoller: async () => {}, auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  for (let minute = 0; minute < 5; minute++) {
    clock = Date.UTC(2026, 9, 5, 12, minute);
    await runner.runTick(clock);
  }
  let state = await runner.status();
  assert.equal(state.rssHealth.sourceMode, 'rss-probe-confirming');
  assert.equal(apiChannels.length, 0, 'opening the circuit must not immediately backfill');
  clock = Date.UTC(2026, 9, 5, 12, 5);
  await runner.runTick(clock);
  state = await runner.status();
  assert.equal(state.rssHealth.sourceMode, 'rss-global-down-api-fallback');
  const coverage = state.rssHealth.fallback.coverageMinutes;
  let fallbackAt = null;
  for (let minute = 5; minute < 60; minute++) {
    const candidate = Date.UTC(2026, 9, 5, 12, minute);
    if (fallbackChannelsForMinute(channels, candidate, coverage).length > 0) { fallbackAt = candidate; break; }
  }
  assert.ok(fallbackAt);
  clock = fallbackAt;
  const result = await runner.runTick(clock);
  state = await runner.status();
  assert.equal(apiChannels.length, 1);
  assert.equal(result.wouldNotify.total, 0);
  assert.equal(state.rssHealth.fallback.quotaUsed, 1);
  assert.equal(state.rssHealth.fallback.requests, 1);
  assert.equal(state.rssHealth.fallback.failures, 0);
  assert.ok(state.rssHealth.lastGoodApiAt);
});

test('85 Home 404s plus two signed Cloudflare network-failure rounds persist across restart and begin capped API work', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { channels, entries } = canonicalChannels(85);
  const namespace = new MemoryNamespace();
  let clock = Date.UTC(2026, 9, 5, 12, 0);
  let homeCalls = 0;
  let subrequests = 0;
  const apiPerMinute = new Map();
  const worker = createAuthorityWorker({ async fetch() { throw new Error('unexpected app route'); } }, {
    rssProbeFetch: async (_url, init) => {
      assert.equal(init.redirect, 'manual');
      subrequests++;
      throw new Error('independent network rejection');
    },
  });
  const runnerConfig = config(dataDir, {
    workerBindings: { YOUTUBE_API_KEY: 'configured', TUBEPULSE_ENABLE_COMMUNITY_POSTS: 'false', TUBEPULSE_NOTIFICATION_MODE: 'shadow' },
    youtubeApiFallback: { enabled: true, configured: true, dailyCap: null },
  });
  const authorityClient = new AuthorityClient({
    baseUrl: runnerConfig.authority.apiUrl, secret: runnerConfig.authority.secret,
    fetchImpl: async (url, init) => await worker.fetch(new Request(url, init), {
      TUBEPULSE_HOME_AUTHORITY_ENABLED: 'true', TUBEPULSE_HOME_AUTHORITY_TRANSPORT: 'https',
      TUBEPULSE_HOME_AUTHORITY_ORIGIN: 'https://home.example.test',
      TUBEPULSE_HOME_AUTHORITY_SECRET: runnerConfig.authority.secret,
      TUBEPULSE_AUTHORITY_COORDINATOR: { get() { throw new Error('probe must not touch coordinator'); } },
    }, {}),
  });
  const dependencies = {
    config: runnerConfig, runtime: new FakeRuntime(namespace), remote: new MemoryAdapter(entries), now: () => clock, authorityClient,
    rssPoller: async () => { homeCalls++; throw Object.assign(new Error('404'), { category: 'http-404' }); },
    youtubeApiFetcher: async () => {
      const minute = Math.floor(clock / 60_000);
      apiPerMinute.set(minute, (apiPerMinute.get(minute) || 0) + 1);
      return { channelName: 'Synthetic', uploads: [] };
    }, postPoller: async () => {}, auxRunner: async () => {},
  };
  let runner = new HomeSchedulerRunner(dependencies);
  await runner.start();
  t.after(() => runner.close());
  for (let minute = 0; minute < 5; minute++) {
    clock = Date.UTC(2026, 9, 5, 12, minute);
    await runner.runTick(clock);
    if (minute < 4) assert.equal(subrequests, 0, 'partial cycle must not probe');
  }
  const first = await runner.status();
  assert.equal(homeCalls, 85);
  assert.equal(subrequests, 2);
  assert.equal(first.rssHealth.sourceMode, 'rss-probe-confirming');
  assert.equal(first.rssHealth.independentProbe.unavailableStreak, 1);
  assert.equal(first.rssHealth.fallback.requests, 0);
  await runner.close();
  runner = new HomeSchedulerRunner(dependencies);
  await runner.start();
  assert.equal((await runner.status()).rssHealth.independentProbe.unavailableStreak, 1);
  clock += 60_000;
  await runner.runTick(clock);
  const second = await runner.status();
  assert.equal(homeCalls, 85, 'remote confirmation avoids an extra Home fetch');
  assert.equal(subrequests, 4);
  assert.equal(second.rssHealth.sourceMode, 'rss-global-down-api-fallback');
  assert.equal(second.rssHealth.independentProbe.unavailableStreak, 2);
  assert.equal(Date.parse(second.rssHealth.independentProbe.lastUnavailableAt) - Date.parse(first.rssHealth.independentProbe.lastUnavailableAt), 60_000);
  assert.ok(second.rssHealth.fallback.requests >= 1);
  for (let minute = 6; minute < 12; minute++) {
    clock = Date.UTC(2026, 9, 5, 12, minute);
    await runner.runTick(clock);
  }
  const final = await runner.status();
  assert.ok([...apiPerMinute.values()].every((count) => count >= 1 && count <= 2));
  assert.equal(final.rssHealth.fallback.requests, [...apiPerMinute.values()].reduce((sum, value) => sum + value, 0));
  assert.equal(final.rssHealth.fallback.quotaUnitsUsed, final.rssHealth.fallback.requests);
  assert.equal(final.rssHealth.fallback.quotaLimit, 6960);
  assert.equal(final.rssHealth.fallback.projectedDailyRequests, 2040);
  assert.ok(Date.parse(final.rssHealth.circuit.until) > clock, 'bounded recovery is armed');
});

test('confirmation rejects same-minute repetitions, cancels for any valid feed or ambiguity, and needs budget', async (t) => {
  const dataDir = await temporaryDirectory(t);
  let clock = Date.UTC(2026, 9, 5, 12, 0);
  const runner = new HomeSchedulerRunner({ config: config(dataDir, {
    workerBindings: { YOUTUBE_API_KEY: 'configured' }, youtubeApiFallback: { enabled: true, dailyCap: 1 },
  }), now: () => clock });
  const health = normalizeRssHealthState(null, clock);
  const failed = remoteProbe('failure', 'network', null);
  runner.applyIndependentRssProbe(health, failed, 85);
  clock += 59_999;
  runner.applyIndependentRssProbe(health, failed, 85);
  assert.equal(health.independentProbe.unavailableStreak, 1);
  assert.equal(health.sourceMode, 'rss-probe-confirming');
  const success = remoteProbe('failure');
  success.outcome = 'success';
  success.probes[1] = { label: 'active', status: 200, validXml: true, classification: 'valid-feed' };
  clock++;
  runner.applyIndependentRssProbe(health, success, 85);
  assert.equal(health.sourceMode, 'home-egress-throttled');
  assert.equal(health.independentProbe.unavailableStreak, 0);
  runner.applyIndependentRssProbe(health, failed, 85);
  clock += 60_000;
  runner.applyIndependentRssProbe(health, { outcome: 'inconclusive', probes: [] }, 85);
  assert.equal(health.sourceMode, 'rss-probe-inconclusive');
  assert.equal(health.independentProbe.unavailableStreak, 0);
  runner.applyIndependentRssProbe(health, failed, 85);
  clock += 60_000;
  health.fallback.requests = 1;
  health.fallback.quotaUnitsUsed = health.fallback.quotaUsed = 1;
  runner.applyIndependentRssProbe(health, failed, 85);
  assert.equal(health.independentProbe.unavailableStreak, 2);
  assert.equal(health.sourceMode, 'stale-cache', 'exhausted budget prevents activation');
});

test('each API reservation enforces both exact 10000 boundaries before calls without overshooting by one', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { channels } = canonicalChannels(85);
  const clock = Date.UTC(2026, 9, 5, 12, 2); // Two selected channels.
  let apiCalls = 0;
  const runner = new HomeSchedulerRunner({ config: config(dataDir, {
    workerBindings: { YOUTUBE_API_KEY: 'configured' }, youtubeApiFallback: { enabled: true },
  }), now: () => clock, youtubeApiFetcher: async () => {
    apiCalls++;
    const reserved = (await runner.stateFile.read()).rssHealth.fallback;
    assert.equal(reserved.requests, 10000);
    assert.equal(reserved.quotaUnitsUsed, 10000);
    return { uploads: [] };
  } });
  runner.fallbackPlan = () => ({ dailyCap: 10000, requestLimit: 10000, quotaUnitLimit: 10000, coverageMinutes: 60 });
  for (const [requests, units, expectedCalls] of [[10000, 9999, 0], [9999, 10000, 0], [9999, 9999, 1]]) {
    const health = normalizeRssHealthState(null, clock);
    Object.assign(health.fallback, { requests, quotaUsed: units, quotaUnitsUsed: units });
    const before = apiCalls;
    await runner.runYoutubeFallback({ TUBEPULSE_KV: new MemoryNamespace() }, health, channels, clock);
    assert.equal(apiCalls - before, expectedCalls);
    assert.ok(health.fallback.requests <= 10000);
    assert.ok(health.fallback.quotaUnitsUsed <= 10000);
  }
});

test('independent probe outage fails safe with stale cache and no Data API request', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { entries } = canonicalChannels(5);
  let clock = Date.UTC(2026, 9, 5, 12, 0);
  let apiCalls = 0;
  const runner = new HomeSchedulerRunner({
    config: config(dataDir, {
      workerBindings: {
        TUBEPULSE_ENABLE_COMMUNITY_POSTS: 'true', TUBEPULSE_NOTIFICATION_MODE: 'shadow',
        FIREBASE_SERVICE_ACCOUNT: '{"project_id":"test"}', YOUTUBE_API_KEY: 'configured',
      },
      youtubeApiFallback: { enabled: true, configured: true, dailyCap: null },
    }),
    runtime: new FakeRuntime(), remote: new MemoryAdapter(entries), now: () => clock,
    authorityClient: { async probeRss() { throw new Error('unavailable'); } },
    rssPoller: async () => { const error = new Error('404'); error.category = 'http-404'; throw error; },
    youtubeApiFetcher: async () => { apiCalls++; }, postPoller: async () => {}, auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  for (let minute = 0; minute < 6; minute++) {
    clock = Date.UTC(2026, 9, 5, 12, minute);
    await runner.runTick(clock);
  }
  const state = await runner.status();
  assert.equal(state.rssHealth.sourceMode, 'rss-probe-inconclusive');
  assert.equal(apiCalls, 0);
});

test('confirmed global RSS failure remains stale-cache when the Data API key is absent', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { entries } = canonicalChannels(5);
  let clock = Date.UTC(2026, 9, 5, 12, 0);
  let apiCalls = 0;
  const runner = new HomeSchedulerRunner({
    config: config(dataDir, {
      youtubeApiFallback: { enabled: false, configured: false, dailyCap: null },
    }),
    runtime: new FakeRuntime(), remote: new MemoryAdapter(entries), now: () => clock,
    authorityClient: { async probeRss() {
      return remoteProbe('failure');
    } },
    rssPoller: async () => { const error = new Error('404'); error.category = 'http-404'; throw error; },
    youtubeApiFetcher: async () => { apiCalls++; }, postPoller: async () => {}, auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  for (let minute = 0; minute < 6; minute++) {
    clock = Date.UTC(2026, 9, 5, 12, minute);
    await runner.runTick(clock);
  }
  const state = await runner.status();
  assert.equal(state.rssHealth.sourceMode, 'stale-cache');
  assert.equal(state.rssHealth.circuit.open, true);
  assert.equal(state.rssHealth.independentProbe.outcome, 'failure');
  assert.equal(apiCalls, 0);
});

test('Data API fallback failure is bounded, quota-counted, and does not fail scheduler authority', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { channels, entries } = canonicalChannels(5);
  let clock = Date.UTC(2026, 9, 5, 12, 0);
  let apiCalls = 0;
  const runner = new HomeSchedulerRunner({
    config: config(dataDir, {
      workerBindings: {
        TUBEPULSE_ENABLE_COMMUNITY_POSTS: 'true', TUBEPULSE_NOTIFICATION_MODE: 'shadow',
        FIREBASE_SERVICE_ACCOUNT: '{"project_id":"test"}', YOUTUBE_API_KEY: 'configured',
      },
      youtubeApiFallback: { enabled: true, configured: true, dailyCap: null },
    }),
    runtime: new FakeRuntime(), remote: new MemoryAdapter(entries), now: () => clock,
    rssPoller: async () => {},
    youtubeApiFetcher: async () => {
      apiCalls++;
      const error = new Error('synthetic quota response');
      error.category = 'quota-or-forbidden';
      throw error;
    },
    postPoller: async () => {}, auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  const state = await runner.status();
  state.rssHealth.sourceMode = 'rss-global-down-api-fallback';
  state.rssHealth.circuit = {
    open: true, reason: 'full-fleet-http-404', outageClass: 'http-404',
    openedAt: new Date(clock).toISOString(), until: new Date(clock + 60 * 60_000).toISOString(),
    cooldownMinutes: 60, recoverySuccesses: 0,
  };
  await runner.stateFile.write(state);
  const coverage = runner.fallbackPlan(channels.length).coverageMinutes;
  for (let minute = 0; minute < coverage; minute++) {
    const candidate = Date.UTC(2026, 9, 5, 12, minute);
    if (fallbackChannelsForMinute(channels, candidate, coverage).length > 0) { clock = candidate; break; }
  }
  const result = await runner.runTick(clock);
  const after = await runner.status();
  assert.equal(apiCalls, 1);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.wouldNotify.total, 0);
  assert.equal(after.rssHealth.sourceMode, 'rss-global-down-api-fallback');
  assert.equal(after.rssHealth.fallback.quotaUsed, 1);
  assert.equal(after.rssHealth.fallback.failures, 1);
  assert.equal(after.rssHealth.fallback.lastError.category, 'quota-or-forbidden');
  assert.equal(after.lastError, null);
});

test('persisted fallback quota resets at Pacific midnight rather than UTC midnight', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const runner = new HomeSchedulerRunner({ config: config(dataDir) });
  const health = {
    fallback: {
      quotaDay: '2026-03-08', quotaUsed: 123, requests: 123, failures: 2,
      skipped: 4, lastError: { category: 'synthetic' },
    },
  };
  runner.refreshFallbackQuota(health, 5, Date.parse('2026-03-09T06:59:59.000Z'));
  assert.equal(health.fallback.quotaDay, '2026-03-08');
  assert.equal(health.fallback.quotaUsed, 123);
  runner.refreshFallbackQuota(health, 5, Date.parse('2026-03-09T07:00:00.000Z'));
  assert.equal(health.fallback.quotaDay, '2026-03-09');
  assert.equal(health.fallback.quotaUsed, 0);
  assert.equal(health.fallback.requests, 0);
  assert.equal(health.fallback.failures, 0);
  assert.equal(health.fallback.lastError, null);
});

test('persisted fallback sub-cap blocks requests instead of borrowing from the next Google quota day', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { channels } = canonicalChannels(5);
  let apiCalls = 0;
  let scheduledTime = Date.UTC(2026, 9, 5, 12, 0);
  const runner = new HomeSchedulerRunner({
    config: config(dataDir, {
      workerBindings: { YOUTUBE_API_KEY: 'configured' },
      youtubeApiFallback: { enabled: true, configured: true, dailyCap: 1 },
    }),
    youtubeApiFetcher: async () => { apiCalls++; },
    now: () => scheduledTime,
  });
  const coverage = runner.fallbackPlan(channels.length).coverageMinutes;
  const epochStart = Math.floor(Date.UTC(2026, 9, 5, 12, 0) / (coverage * 60_000)) * coverage * 60_000;
  scheduledTime = undefined;
  for (let minute = 0; minute < coverage; minute++) {
    const candidate = epochStart + minute * 60_000;
    if (fallbackChannelsForMinute(channels, candidate, coverage).length > 0) { scheduledTime = candidate; break; }
  }
  assert.ok(Number.isFinite(scheduledTime));
  const day = pacificQuotaWindow(scheduledTime).day;
  const health = {
    fallback: {
      quotaDay: day, quotaUsed: 1, requests: 1, failures: 0, skipped: 0,
      quotaLimit: 1, resetsAt: null, coverageMinutes: coverage, lastError: null,
    },
  };
  const result = await runner.runYoutubeFallback({}, health, channels, scheduledTime);
  assert.equal(result.outcome, 'quota-blocked');
  assert.equal(result.quotaBlocked, 1);
  assert.equal(apiCalls, 0);
  assert.equal(health.fallback.quotaUsed, 1);
});

test('failed home recovery probes exponentially back off and cap the persisted cooldown', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { entries } = canonicalChannels(5);
  let clock = Date.UTC(2026, 9, 5, 12, 0);
  let rssCalls = 0;
  const runner = new HomeSchedulerRunner({
    config: config(dataDir, {
      rssCircuitInitialCooldownMinutes: 1,
      rssCircuitMaximumCooldownMinutes: 4,
    }),
    runtime: new FakeRuntime(), remote: new MemoryAdapter(entries), now: () => clock,
    authorityClient: { async probeRss() {
      return remoteProbe('success');
    } },
    rssPoller: async () => {
      rssCalls++;
      const error = new Error('404');
      error.category = 'http-404';
      throw error;
    },
    postPoller: async () => {}, auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  for (let minute = 0; minute < 5; minute++) {
    clock = Date.UTC(2026, 9, 5, 12, minute);
    await runner.runTick(clock);
  }
  let state = await runner.status();
  assert.equal(state.rssHealth.circuit.cooldownMinutes, 1);
  assert.equal(Date.parse(state.rssHealth.circuit.until), Date.UTC(2026, 9, 5, 12, 5));

  clock = Date.parse(state.rssHealth.circuit.until);
  await runner.runTick(clock);
  state = await runner.status();
  assert.equal(state.rssHealth.circuit.cooldownMinutes, 2);
  assert.equal(Date.parse(state.rssHealth.circuit.until), Date.UTC(2026, 9, 5, 12, 7));

  clock = Date.parse(state.rssHealth.circuit.until);
  await runner.runTick(clock);
  state = await runner.status();
  assert.equal(state.rssHealth.circuit.cooldownMinutes, 4);
  assert.equal(Date.parse(state.rssHealth.circuit.until), Date.UTC(2026, 9, 5, 12, 11));

  clock = Date.parse(state.rssHealth.circuit.until);
  await runner.runTick(clock);
  state = await runner.status();
  assert.equal(state.rssHealth.circuit.cooldownMinutes, 4);
  assert.equal(Date.parse(state.rssHealth.circuit.until), Date.UTC(2026, 9, 5, 12, 15));
  assert.equal(state.rssHealth.sourceMode, 'home-egress-throttled');
  assert.equal(rssCalls, 8, 'five cycle requests plus one bounded home probe at each due time');
});

test('open RSS circuit persists and requires two consecutive valid home probes before resuming', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { entries } = canonicalChannels(5);
  const namespace = new MemoryNamespace();
  const remote = new MemoryAdapter(entries);
  let clock = Date.UTC(2026, 9, 5, 12, 0);
  let calls = 0;
  const options = {
    config: config(dataDir, { rssCircuitInitialCooldownMinutes: 1, rssCircuitMaximumCooldownMinutes: 4 }),
    runtime: new FakeRuntime(namespace), remote, now: () => clock,
    authorityClient: { async probeRss() {
      return remoteProbe('success');
    } },
    rssPoller: async () => {
      calls++;
      if (calls <= 5) { const error = new Error('404'); error.category = 'http-404'; throw error; }
    },
    postPoller: async () => {}, auxRunner: async () => {},
  };
  const first = new HomeSchedulerRunner(options);
  await first.start();
  for (let minute = 0; minute < 5; minute++) {
    clock = Date.UTC(2026, 9, 5, 12, minute);
    await first.runTick(clock);
  }
  let state = await first.status();
  assert.equal(state.rssHealth.circuit.open, true);
  const due = Date.parse(state.rssHealth.circuit.until);
  await first.close();

  const second = new HomeSchedulerRunner({ ...options, runtime: new FakeRuntime(namespace) });
  await second.start();
  t.after(() => second.close());
  clock = due - 1;
  await second.runTick(clock);
  assert.equal(calls, 5, 'restart before cooldown must not issue a probe');
  clock = due;
  await second.runTick(clock);
  state = await second.status();
  assert.equal(state.rssHealth.sourceMode, 'rss-recovering');
  assert.equal(state.rssHealth.circuit.open, true);
  assert.equal(state.rssHealth.circuit.recoverySuccesses, 1);
  clock = due + 60_000;
  await second.runTick(clock);
  state = await second.status();
  assert.equal(state.rssHealth.sourceMode, 'rss');
  assert.equal(state.rssHealth.circuit.open, false);
  assert.equal(state.lastError, null);
});

test('fleet RSS outage remains a recoverable source state and never marks active Home authority stale', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const { entries } = canonicalChannels(5);
  const remote = new MemoryAdapter(entries);
  const gate = new FakeAuthorityGate();
  const authorityClient = new FakeAuthorityClient(remote);
  let clock = Date.UTC(2026, 9, 5, 12, 0);
  const notificationCoordinator = {
    async stage() {},
    async flush() { return { queued: 0, sent: 0, failed: 0, suppressed: 0, barrier: 'passed' }; },
    async suppress() { throw new Error('nothing should be suppressed'); },
  };
  const runner = new HomeSchedulerRunner({
    config: config(dataDir, {
      mode: 'active', remoteWriteEnabled: true, notificationsEnabled: true,
      schedulesDisabled: true, notificationBarrier: { configured: true },
    }),
    runtime: new FakeRuntime(new MemoryNamespace(entries)), remote, now: () => clock,
    authorityGate: gate, authorityClient, notificationCoordinator,
    rssPoller: async () => { const error = new Error('404'); error.category = 'http-404'; throw error; },
    postPoller: async () => {}, auxRunner: async () => {},
  });
  await runner.start();
  t.after(() => runner.close());
  for (let minute = 0; minute < 5; minute++) {
    clock = Date.UTC(2026, 9, 5, 12, minute);
    await runner.runTick(clock);
  }
  const state = await runner.status();
  assert.equal(state.rssHealth.circuit.open, true);
  assert.equal(state.rssHealth.sourceMode, 'rss-probe-inconclusive');
  assert.equal(gate.stale, false);
  assert.equal((await gate.status()).replication.status, 'current');
  assert.equal(state.lastError, null);
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
    ...cachedPost[0], fetchedAt: '2026-10-04T11:00:00.000Z',
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

test('community post persistence throttles observation and engagement churn without delaying structure', () => {
  const cached = {
    id: 'post:Ugpost', activityId: 'Ugpost', postId: 'Ugpost',
    fetchedAt: '2026-10-04T10:05:00.000Z',
    publishedAt: '2026-10-03T10:00:00.000Z', publishedAtSource: 'estimated_from_relative',
    publishedText: '1 day ago', thumbnail: 'https://i.ytimg.com/abc/image.jpg?sqp=old&rs=old',
    text: 'same', likeCount: 100, likeText: '100 likes', viewCount: 1000, viewText: '1K views',
    kind: 'community', link: 'https://www.youtube.com/post/Ugpost', source: 'innertube',
  };
  const latest = (overrides = {}) => ({
    ...cached,
    fetchedAt: '2026-10-04T11:05:00.000Z',
    publishedText: '25 hours ago',
    thumbnail: 'https://i.ytimg.com/abc/image.jpg?sqp=new&rs=new',
    ...overrides,
  });

  assert.equal(
    mergeCachedCommunityPostForPersistence(latest({ likeCount: 124, likeText: '124 likes' }), [cached]),
    cached,
    'sub-threshold metrics, relative text and rotating delivery signatures are a true no-op',
  );
  const significant = mergeCachedCommunityPostForPersistence(
    latest({ likeCount: 126, likeText: '126 likes' }), [cached],
  );
  assert.equal(significant.likeCount, 126);
  assert.equal(significant.fetchedAt, '2026-10-04T11:05:00.000Z');
  assert.equal(significant.thumbnail, cached.thumbnail);

  assert.equal(
    mergeCachedCommunityPostForPersistence(latest({
      fetchedAt: '2026-10-04T10:55:00.000Z', likeCount: 500, likeText: '500 likes',
    }), [cached]),
    cached,
    'a same-hour spike cannot cause a second persistence write',
  );

  const forced = mergeCachedCommunityPostForPersistence(latest({
    fetchedAt: '2026-10-05T10:05:00.000Z', viewCount: 1100, viewText: '1.1K views',
  }), [cached]);
  assert.equal(forced.viewCount, 1100);
  assert.equal(forced.fetchedAt, '2026-10-05T10:05:00.000Z');

  const unknown = { ...cached, likeCount: null, likeText: null };
  const hydrated = mergeCachedCommunityPostForPersistence(latest({
    fetchedAt: cached.fetchedAt, likeCount: 0, likeText: '0 likes',
  }), [unknown]);
  assert.equal(hydrated.likeCount, 0, 'explicit zero hydrates an unknown metric');

  const structural = mergeCachedCommunityPostForPersistence(latest({ text: 'edited' }), [cached]);
  assert.equal(structural.text, 'edited');
  assert.notEqual(structural, cached);
  const newPost = latest({ id: 'post:Ugnew', activityId: 'Ugnew', postId: 'Ugnew', text: 'new' });
  assert.equal(mergeCachedCommunityPostForPersistence(newPost, [cached]), newPost);
});

test('eligible post comparison with only sub-threshold observation churn publishes zero writes', async () => {
  const channelId = 'UC0000000000000000000000';
  const postId = 'Ugpost';
  const now = Date.now();
  const cached = {
    id: `post:${postId}`, activityId: postId, postId,
    publishedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    publishedAtSource: 'estimated_from_relative', publishedText: '1 day ago',
    fetchedAt: new Date(now - 60_000).toISOString(),
    likeCount: 100, likeText: '100 likes', viewCount: 1000, viewText: '1K views',
    authorName: null, text: 'same',
    thumbnail: 'https://i.ytimg.com/abc/image.jpg?sqp=old&rs=old',
    kind: 'community', link: `https://www.youtube.com/post/${postId}`, source: 'innertube',
  };
  const namespace = new MemoryNamespace({
    [`channel:${channelId}:firstPollAt:posts`]: JSON.stringify('2026-10-01T00:00:00Z'),
    [`channel:${channelId}:recent:posts`]: JSON.stringify([cached]),
    [`channel:${channelId}:known:posts`]: JSON.stringify([`post:${postId}`]),
  });
  let writes = 0;
  const originalPut = namespace.put.bind(namespace);
  namespace.put = async (...args) => { writes++; return await originalPut(...args); };
  const payload = {
    contents: [{ backstagePostThreadRenderer: { post: { backstagePostRenderer: {
      postId,
      publishedTimeText: { simpleText: '1 day ago' },
      voteCount: { simpleText: '124 likes' },
      viewCount: { simpleText: '1.1K views' },
      contentText: { simpleText: 'same' },
      backstageAttachment: { image: { thumbnails: [{
        url: 'https://i.ytimg.com/abc/image.jpg?sqp=new&rs=new', width: 640, height: 360,
      }] } },
    } } } }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(payload);
  try {
    const result = await pollSingleCommunityChannel(
      { TUBEPULSE_KV: namespace }, { waitUntil() {} }, channelId, false,
    );
    assert.equal(result.outcome, 'unchanged');
    assert.equal(writes, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
