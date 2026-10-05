import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isCommunityPostsEnabled, parseCommunityPostChannelAllowlist } from '../../worker/tubepulse-posts/community-posts.mjs';
import { isCommunityPostsDebugEnabled, pollSingleCommunityChannel } from '../../worker/tubepulse-posts/index.js';
import { pollSingleRssChannel, processChannelUploads } from '../../worker/tubepulse-rss-0/index.js';
import { runAuxTick } from '../../worker/tubepulse-aux/index.js';
import { getKV, key, mergeRssUploadsIntoRecentVideos, putKVIfChanged, stableJson } from '../../worker/tubepulse-cron/shared.mjs';
import { isSyncExcluded } from './exclusions.mjs';
import { JsonStateFile } from './file-state.mjs';
import {
  CloudflareKvRestAdapter,
  LocalKvAdapter,
  recordSummary,
  snapshotAdapter,
  summariesEqual,
} from './kv-adapters.mjs';
import { TubePulseRuntime } from './runtime.mjs';
import { SyncEngine } from './sync-engine.mjs';
import { DurableNotificationIntentStore, ProductionNotificationCoordinator } from './home-scheduler-notifications.mjs';
import { AuthorityClient } from './authority-client.mjs';
import { createHomeAuthorityStateFile, HomeAuthorityGate } from './home-authority.mjs';
import {
  fallbackChannelsForMinute,
  fallbackQuotaPlan,
  normalizeRssHealthState,
  pacificQuotaWindow,
  rssCohortForMinute,
  rssNextMinuteSchedule,
  sameFleetOutage,
  validateIndependentRssProbe,
} from './home-rss-policy.mjs';
import { fetchUploadsPlaylist } from './youtube-api-fallback.mjs';
import {
  YouTubeDataApiClient,
  YouTubeDataApiError,
  chunked,
  fetchPlaylistReconciliation,
  normalizeStatistics,
  normalizeYoutubeDataApiState,
  selectDueMetricVideos,
  pruneMetricPollToVisibleVideos,
} from './youtube-data-api.mjs';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function iso(now = Date.now()) {
  return new Date(now).toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freshSchedulerState(mode = 'shadow') {
  return {
    schemaVersion: 1,
    mode,
    startedAt: null,
    stoppedAt: null,
    lease: null,
    currentSweep: null,
    lastSweep: null,
    lastMinuteJobs: null,
    lastNotificationDelivery: null,
    lastError: null,
    nextSweepAt: null,
    overlapSkips: 0,
    rssHealth: normalizeRssHealthState(null),
  };
}

export function createHomeSchedulerStateFile(dataDir, mode = 'shadow') {
  return new JsonStateFile(path.join(dataDir, 'home-scheduler-state.json'), freshSchedulerState(mode));
}

export function createHomeSchedulerSyncStateFile(dataDir) {
  return new JsonStateFile(path.join(dataDir, 'home-scheduler-sync-state.json'), {
    schemaVersion: 1,
    baseline: {},
    conflicts: {},
    lastPull: null,
    lastPush: null,
  });
}

export function publicHomeSchedulerState(state) {
  const youtube = state?.youtubeDataApi;
  const lastSweep = state?.lastSweep?.sourceMode === 'youtube-data-api'
    ? {
      ...state.lastSweep,
      reconcileResults: (state.lastSweep.reconcileResults || []).reduce((summary, entry) => {
        summary[entry.outcome || 'unknown'] = (summary[entry.outcome || 'unknown'] || 0) + 1;
        return summary;
      }, {}),
    }
    : state?.lastSweep;
  return {
    ...state,
    lastSweep,
    ...(youtube ? {
      youtubeDataApi: {
        sourceMode: youtube.sourceMode,
        statsMethod: youtube.statsMethod,
        quota: youtube.quota,
        channelStateCount: Object.keys(youtube.channels || {}).length,
        metricStateCount: Object.keys(youtube.metricPoll || {}).length,
        lastGoodAt: youtube.lastGoodAt || null,
        lastError: youtube.lastError || null,
        lastCycle: youtube.lastCycle || null,
      },
    } : {}),
  };
}

export function nextFiveMinuteBoundary(now = Date.now()) {
  return Math.floor(now / FIVE_MINUTES_MS) * FIVE_MINUTES_MS + FIVE_MINUTES_MS;
}

export class FileLease {
  constructor({ dataDir, ttlMs = 180_000, now = Date.now, owner = crypto.randomUUID() }) {
    this.path = path.join(dataDir, 'home-scheduler.lock');
    this.ttlMs = ttlMs;
    this.now = now;
    this.owner = owner;
    this.heartbeatTimer = null;
    this.acquired = false;
  }

  record() {
    const now = this.now();
    return { owner: this.owner, acquiredAt: iso(now), heartbeatAt: iso(now), expiresAt: iso(now + this.ttlMs) };
  }

  async writeExclusive(record) {
    const handle = await fs.open(this.path, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
  }

  async acquire() {
    if (this.acquired) return { owner: this.owner, path: this.path };
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    try {
      await this.writeExclusive(this.record());
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let existing;
      try {
        existing = JSON.parse(await fs.readFile(this.path, 'utf8'));
      } catch {
        throw new Error('Home scheduler lease exists but cannot be validated');
      }
      if (Date.parse(existing.expiresAt || '') > this.now()) {
        throw new Error('Another Home scheduler owns the active lease');
      }
      const stalePath = `${this.path}.stale-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`;
      await fs.rename(this.path, stalePath);
      await this.writeExclusive(this.record());
    }
    this.acquired = true;
    const interval = Math.max(1000, Math.floor(this.ttlMs / 3));
    this.heartbeatTimer = setInterval(() => this.heartbeat().catch(() => {}), interval);
    this.heartbeatTimer.unref?.();
    return { owner: this.owner, path: this.path };
  }

  async heartbeat() {
    if (!this.acquired) return;
    let existing;
    try {
      existing = JSON.parse(await fs.readFile(this.path, 'utf8'));
    } catch {
      throw new Error('Home scheduler lease disappeared during execution');
    }
    if (existing.owner !== this.owner) throw new Error('Home scheduler lease ownership changed');
    const now = this.now();
    const next = { ...existing, heartbeatAt: iso(now), expiresAt: iso(now + this.ttlMs) };
    // The exclusive file itself is the ownership primitive. Rewriting it in
    // place avoids Windows' non-replacing rename semantics and, importantly,
    // never creates a gap in which a second process could acquire the path.
    await fs.writeFile(this.path, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async release() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (!this.acquired) return;
    try {
      const existing = JSON.parse(await fs.readFile(this.path, 'utf8'));
      if (existing.owner === this.owner) await fs.unlink(this.path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    } finally {
      this.acquired = false;
    }
  }
}

export class WorkerKvFacade {
  constructor(adapter) {
    this.adapter = adapter;
  }

  async get(name, type = 'text') {
    const value = await this.adapter.get(name);
    if (value === null || value === undefined || type !== 'json') return value;
    try { return JSON.parse(value); } catch { return null; }
  }

  async put(name, value, options = {}) {
    let expiration = options.expiration;
    if (!Number.isFinite(expiration) && Number.isFinite(options.expirationTtl)) {
      expiration = Math.floor(Date.now() / 1000) + Number(options.expirationTtl);
    }
    await this.adapter.put(name, String(value), Number.isFinite(expiration) ? { expiration } : {});
  }

  async delete(name) {
    await this.adapter.delete(name);
  }
}

function stripMetrics(value) {
  if (Array.isArray(value)) return value.map(stripMetrics);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [name, child] of Object.entries(value)) {
    if (['views', 'likes', 'comments', 'dislikes', 'viewsLastCheckedHour', 'likesLastCheckedHour', 'commentsLastCheckedHour'].includes(name)) continue;
    result[name] = stripMetrics(child);
  }
  return result;
}

function stripCommunityPostMetrics(value) {
  if (Array.isArray(value)) return value.map(stripCommunityPostMetrics);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [name, child] of Object.entries(value)) {
    if (['likeCount', 'likeText', 'viewCount', 'viewText'].includes(name)) continue;
    result[name] = stripCommunityPostMetrics(child);
  }
  return result;
}

function stripCommunityPostObservationMetadata(value) {
  if (Array.isArray(value)) return value.map(stripCommunityPostObservationMetadata);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [name, child] of Object.entries(value)) {
    if (['likeCount', 'likeText', 'viewCount', 'viewText', 'fetchedAt'].includes(name)) continue;
    result[name] = stripCommunityPostObservationMetadata(child);
  }
  return result;
}

function communityPostMetrics(value) {
  if (Array.isArray(value)) return value.map(communityPostMetrics);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(['likeCount', 'likeText', 'viewCount', 'viewText']
    .filter((name) => Object.prototype.hasOwnProperty.call(value, name))
    .map((name) => [name, value[name]]));
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export function mutationKeyFamily(name) {
  if (name === 'channels:active') return 'channels-active';
  if (name === 'nag:active') return 'nag-active';
  if (name === 'upcoming:events:list') return 'upcoming-events';
  if (name === 'fcm:cache:token') return 'fcm-token-cache';
  if (/^upcoming:prewarn:/.test(name)) return 'prewarn-sent';
  if (/^upcoming:/.test(name)) return 'upcoming-legacy';
  if (/^channel:[^:]+:known:videos$/.test(name)) return 'channel-known-videos';
  if (/^channel:[^:]+:known:posts$/.test(name)) return 'channel-known-posts';
  if (/^channel:[^:]+:recent:posts$/.test(name)) return 'channel-recent-posts';
  if (/^channel:[^:]+:recent$/.test(name)) return 'channel-recent-videos';
  if (/^channel:[^:]+:meta$/.test(name)) return 'channel-meta';
  if (/^channel:[^:]+:firstPollAt:posts$/.test(name)) return 'channel-post-first-poll';
  if (/^channel:[^:]+:subscribers$/.test(name)) return 'channel-subscribers';
  if (/^device:[^:]+:state:/.test(name)) return 'device-state';
  if (/^device:[^:]+:/.test(name)) return 'device-record';
  return 'other';
}

export function mutationReason(name, previousValue, nextValue, operation = 'put') {
  if (operation === 'delete') return 'cleanup';
  const family = mutationKeyFamily(name);
  if (family === 'channel-recent-videos') {
    const previous = parseJson(previousValue);
    const next = parseJson(nextValue);
    if (previous && next && stableJson(stripMetrics(previous)) === stableJson(stripMetrics(next))) return 'metrics-only';
    return 'new-content-cache';
  }
  if (family === 'channel-recent-posts') {
    const previous = parseJson(previousValue);
    const next = parseJson(nextValue);
    if (previous && next) {
      if (stableJson(stripCommunityPostMetrics(previous)) === stableJson(stripCommunityPostMetrics(next))) {
        return 'post-metrics-only';
      }
      if (stableJson(stripCommunityPostObservationMetadata(previous))
        === stableJson(stripCommunityPostObservationMetadata(next))) {
        return stableJson(communityPostMetrics(previous)) === stableJson(communityPostMetrics(next))
          ? 'post-observation-metadata-only'
          : 'post-metrics-only';
      }
    }
    return 'community-content-cache';
  }
  if (family === 'channel-known-videos' || family === 'channel-known-posts') return 'dedupe-watermark';
  if (family === 'device-state' || family === 'nag-active' || family === 'upcoming-events' || family === 'prewarn-sent') {
    return 'notification-state';
  }
  if (family === 'fcm-token-cache') return 'token-cache';
  if (family === 'channel-meta') return 'channel-metadata';
  if (family === 'channel-post-first-poll') return 'first-run-suppression';
  return 'state';
}

export class MutationJournal {
  constructor() {
    this.events = [];
    // Exact key/value data remains private to the publication path. Public
    // summaries expose only truncated hashes and classifications.
    this.changes = new Map();
  }

  record({ key: name, operation, previousValue, nextValue, options = {} }) {
    this.events.push({
      keyHash: crypto.createHash('sha256').update(name).digest('hex').slice(0, 16),
      family: mutationKeyFamily(name),
      reason: mutationReason(name, previousValue, nextValue, operation),
      operation,
    });
    const existing = this.changes.get(name);
    const baseValue = existing ? existing.baseValue : previousValue;
    const unchanged = operation === 'delete'
      ? baseValue === null || baseValue === undefined
      : baseValue === nextValue;
    if (unchanged) this.changes.delete(name);
    else this.changes.set(name, { key: name, operation, baseValue, nextValue, options: { ...options } });
  }

  deltas({ exclude = () => false } = {}) {
    return [...this.changes.values()]
      .filter(({ key: name }) => !exclude(name))
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(({ key: name, operation, baseValue, nextValue, options }) => ({
        key: name,
        operation,
        baseHash: baseValue === null || baseValue === undefined ? null : crypto.createHash('sha256').update(baseValue).digest('hex'),
        nextHash: operation === 'put' ? crypto.createHash('sha256').update(nextValue).digest('hex') : null,
        ...(operation === 'put' ? { value: nextValue, options } : {}),
      }));
  }

  checkpoint() { this.changes.clear(); }

  summary() {
    const byFamily = {};
    const byReason = {};
    for (const event of this.events) {
      byFamily[event.family] = (byFamily[event.family] || 0) + 1;
      byReason[event.reason] = (byReason[event.reason] || 0) + 1;
    }
    return {
      localMutations: this.events.length,
      uniqueKeys: new Set(this.events.map((event) => event.keyHash)).size,
      byFamily,
      byReason,
    };
  }
}

export class RecordingKv {
  constructor(base, journal) {
    this.base = base;
    this.journal = journal;
  }

  async get(name, type = 'text') {
    return await this.base.get(name, type);
  }

  async put(name, value, options = {}) {
    const previousValue = await this.base.get(name, 'text');
    const nextValue = String(value);
    await this.base.put(name, nextValue, options);
    if (previousValue !== nextValue) {
      this.journal.record({ key: name, operation: 'put', previousValue, nextValue, options });
    }
  }

  async delete(name) {
    const previousValue = await this.base.get(name, 'text');
    await this.base.delete(name);
    if (previousValue !== null && previousValue !== undefined) {
      this.journal.record({ key: name, operation: 'delete', previousValue, nextValue: null });
    }
  }
}

export async function replaceLocalWithCanonical({ local, remote, stateFile, concurrency = 6, exclude = isSyncExcluded }) {
  const [localSnapshot, remoteSnapshot] = await Promise.all([
    snapshotAdapter(local, { concurrency, exclude }),
    snapshotAdapter(remote, { concurrency, exclude }),
  ]);
  const summary = {
    at: iso(),
    imported: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    pendingLocal: 0,
    conflicts: 0,
    excluded: localSnapshot.excluded + remoteSnapshot.excluded,
    status: 'ok',
    canonicalReset: true,
  };
  const allKeys = new Set([...localSnapshot.records.keys(), ...remoteSnapshot.records.keys()]);
  for (const name of [...allKeys].sort()) {
    const localRecord = localSnapshot.records.get(name) ?? null;
    const remoteRecord = remoteSnapshot.records.get(name) ?? null;
    if (summariesEqual(localRecord, remoteRecord)) {
      summary.unchanged++;
    } else if (remoteRecord) {
      await local.put(name, remoteRecord.value, { expiration: remoteRecord.expiration });
      if (localRecord) summary.updated++;
      else summary.imported++;
    } else {
      await local.delete(name);
      summary.deleted++;
    }
  }
  await stateFile.write({
    schemaVersion: 1,
    baseline: Object.fromEntries(
      [...remoteSnapshot.records.entries()].map(([name, record]) => [name, recordSummary(record)]),
    ),
    conflicts: {},
    lastPull: summary,
    lastPush: null,
  });
  return summary;
}

class WaitUntilContext {
  constructor() { this.promises = []; }
  waitUntil(promise) { this.promises.push(Promise.resolve(promise)); }
  async flush() { await Promise.allSettled(this.promises); }
}

class KeyedMutex {
  constructor() { this.tails = new Map(); }
  async run(name, operation) {
    const previous = this.tails.get(name) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(name, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    }
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await mapper(items[current], current);
    }
  }));
  return results;
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class ShadowPublicationStrategy {
  constructor({ local, remote, syncStateFile, concurrency }) {
    this.local = local;
    this.remote = remote;
    this.syncStateFile = syncStateFile;
    this.concurrency = concurrency;
    this.syncEngine = new SyncEngine({
      local,
      remote,
      stateFile: syncStateFile,
      concurrency,
      writeEnabled: false,
    });
    this.workerKv = new WorkerKvFacade(local);
    this.prepared = false;
  }

  async prepare() {
    if (!this.prepared) {
      const result = await replaceLocalWithCanonical({
        local: this.local,
        remote: this.remote,
        stateFile: this.syncStateFile,
        concurrency: this.concurrency,
      });
      this.prepared = true;
      return result;
    }
    // Keep locally simulated scheduler mutations so consecutive shadow sweeps
    // reveal steady-state churn. The ordinary three-way pull may still import
    // unrelated canonical app changes, but it never overwrites local dirty
    // state or writes Cloudflare.
    return await this.syncEngine.pull();
  }

  target() { return this.workerKv; }

  async finish() {
    const plan = await this.syncEngine.push({ apply: false });
    return {
      apply: false,
      predictedCanonicalWrites: plan.plannedPuts + plan.plannedDeletes,
      plannedPuts: plan.plannedPuts,
      plannedDeletes: plan.plannedDeletes,
      conflicts: plan.conflicts,
      pending: plan.pending,
    };
  }
}

function isAuthorityLocalOnlyKey(name) {
  return name === 'fcm:cache:token'
    || String(name).startsWith('gateway:canary:')
    || String(name).startsWith('handle:');
}

export class ActivePublicationStrategy {
  constructor({ local, gate, client, leaseTtlMs = 180_000 }) {
    this.local = local;
    this.gate = gate;
    this.client = client;
    this.leaseTtlMs = leaseTtlMs;
    this.workerKv = new WorkerKvFacade(local);
    this.leaseId = null;
    this.heartbeat = null;
    this.remoteLeaseId = null;
    this.totals = { batches: 0, writes: 0, authorityRequests: 0 };
  }
  async prepare() {
    if (this.leaseId) throw new Error('Local authority publication is already prepared');
    this.leaseId = `scheduler-${crypto.randomUUID()}`;
    await this.gate.acquire({ leaseId: this.leaseId, kind: 'scheduler' });
    this.heartbeat = setInterval(() => {
      this.gate.renew(this.leaseId).catch(() => {});
    }, Math.max(1000, Math.floor(this.leaseTtlMs / 3)));
    this.heartbeat.unref?.();
    return { status: 'local-first', periodicCanonicalPull: false };
  }
  target() { return this.workerKv; }
  stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
  startHeartbeat() {
    this.heartbeat = setInterval(() => {
      this.gate.renew(this.leaseId).catch(() => {});
    }, Math.max(1000, Math.floor(this.leaseTtlMs / 3)));
    this.heartbeat.unref?.();
  }
  async finish(journal, { final = true } = {}) {
    if (!this.leaseId) throw new Error('Local authority publication is not prepared');
    const deltas = journal.deltas({ exclude: isAuthorityLocalOnlyKey });
    let remoteLease = null;
    try {
      // Every active tick visits the coordinator even when this tick produced
      // no local changes. That gives a prior coalesced backup queue a chance
      // to drain immediately after the 00:00 UTC quota reset.
      if (!this.remoteLeaseId) {
        // Polling uses only the local lease. Before publication, release it,
        // acquire the global DO lease, then reacquire Home in the same global
        // -> local order used by API mutations. This avoids ABBA deadlock
        // without holding the global coordinator for a multi-minute sweep.
        const pollingLease = this.leaseId;
        this.stopHeartbeat();
        await this.gate.release(pollingLease);
        this.leaseId = null;
        remoteLease = await this.client.acquirePublication({ ttlMs: this.leaseTtlMs });
        this.remoteLeaseId = remoteLease.leaseId;
        this.leaseId = `scheduler-publish-${crypto.randomUUID()}`;
        await this.gate.acquire({ leaseId: this.leaseId, kind: 'scheduler' });
        this.startHeartbeat();
      }
      const commit = await this.client.commitPublication(this.remoteLeaseId, deltas, { retainLease: !final });
      if (commit?.deferred === true) {
        // The coordinator durably coalesces the backup queue. Its global
        // lease is already released; Home remains current/readable and app
        // mutations flush any overlapping queued key from reserved headroom.
        this.remoteLeaseId = null;
        remoteLease = null;
        await this.gate.verifyScheduler(this.leaseId, deltas, { release: false });
        journal.checkpoint();
        if (final) {
          await this.gate.release(this.leaseId);
          this.stopHeartbeat();
          this.leaseId = null;
        }
        this.totals.authorityRequests = this.client.operations.requests;
        return {
          apply: true,
          periodicCanonicalPull: false,
          canonicalBackupDeferred: true,
          predictedCanonicalWrites: deltas.length,
          appliedWrites: 0,
          queuedBackupWrites: Number(commit.queued || 0),
          conflicts: 0,
          pending: Number(commit.queued || 0),
          authorityRequests: this.client.operations.requests,
        };
      }
      {
        if (final) this.remoteLeaseId = null;
        remoteLease = null;
        await this.gate.verifyScheduler(this.leaseId, deltas, { release: false });
        this.totals.batches++;
        this.totals.writes += Number.isFinite(commit?.applied) ? Number(commit.applied) : deltas.length;
      }
      journal.checkpoint();
      if (final) {
        if (this.remoteLeaseId) {
          await this.client.releasePublication(this.remoteLeaseId);
          this.remoteLeaseId = null;
        }
        await this.gate.release(this.leaseId);
        this.stopHeartbeat();
        this.leaseId = null;
      }
      this.totals.authorityRequests = this.client.operations.requests;
      return {
        apply: true,
        periodicCanonicalPull: false,
        predictedCanonicalWrites: deltas.length,
        appliedWrites: Number.isFinite(commit?.applied) ? Number(commit.applied) : deltas.length,
        queuedBackupWrites: 0,
        conflicts: 0,
        pending: 0,
        authorityRequests: this.client.operations.requests,
      };
    } catch (error) {
      if (remoteLease) await this.client.releasePublication(remoteLease.leaseId).catch(() => {});
      if (this.remoteLeaseId) await this.client.releasePublication(this.remoteLeaseId).catch(() => {});
      this.remoteLeaseId = null;
      const leaseId = this.leaseId;
      this.stopHeartbeat();
      this.leaseId = null;
      if (leaseId) await this.gate.failLease(leaseId, 'canonical-publication-unconfirmed').catch(() => {});
      else await this.gate.markStale('canonical-publication-unconfirmed').catch(() => {});
      throw error;
    }
  }
  async abort(reason = 'scheduler-tick-failed') {
    if (!this.leaseId) return;
    const leaseId = this.leaseId;
    if (this.remoteLeaseId) await this.client.releasePublication(this.remoteLeaseId).catch(() => {});
    this.remoteLeaseId = null;
    this.stopHeartbeat();
    this.leaseId = null;
    await this.gate.failLease(leaseId, reason);
  }
}

export class HomeSchedulerRunner {
  constructor({
    config,
    runtime = null,
    remote = null,
    stateFile = null,
    syncStateFile = null,
    lease = null,
    now = Date.now,
    sleep = delay,
    rssPoller = pollSingleRssChannel,
    youtubeApiFetcher = fetchUploadsPlaylist,
    youtubeDataApiClient = null,
    postPoller = pollSingleCommunityChannel,
    auxRunner = runAuxTick,
    notificationCoordinator = null,
    authorityGate = null,
    authorityClient = null,
    recoverAuthority = null,
  }) {
    this.config = config;
    this.runtime = runtime || new TubePulseRuntime({
      dataDir: config.dataDir,
      repoRoot: config.repoRoot,
      workerBindings: config.workerBindings,
      quiet: config.quiet,
    });
    this.remote = remote || (config.sync.configured ? new CloudflareKvRestAdapter(config.sync) : null);
    this.stateFile = stateFile || createHomeSchedulerStateFile(config.dataDir, config.mode);
    this.syncStateFile = syncStateFile || createHomeSchedulerSyncStateFile(config.dataDir);
    this.lease = lease || new FileLease({ dataDir: config.dataDir, ttlMs: config.leaseTtlMs, now });
    this.now = now;
    this.sleep = sleep;
    this.rssPoller = rssPoller;
    this.youtubeApiFetcher = youtubeApiFetcher;
    this.youtubeDataApiClient = youtubeDataApiClient;
    this.postPoller = postPoller;
    this.auxRunner = auxRunner;
    this.notificationCoordinator = notificationCoordinator;
    this.authorityGate = authorityGate;
    this.authorityClient = authorityClient;
    this.recoverAuthority = recoverAuthority;
    this.publication = null;
    this.running = false;
    this.timer = null;
    this.activeTick = null;
    this.stopped = false;
    this.remoteConfirmationDueAt = null;
    this.kvMutationMutex = new KeyedMutex();
    this.overlapSkips = 0;
  }

  async start() {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    const lease = await this.lease.acquire();
    let authorityStatus = null;
    try {
      await this.runtime.start();
      const local = new LocalKvAdapter(await this.runtime.getLocalNamespace());
      if (this.config.mode === 'shadow') {
        this.publication = new ShadowPublicationStrategy({
          local,
          remote: this.remote,
          syncStateFile: this.syncStateFile,
          concurrency: this.config.sync.concurrency,
        });
      } else if (this.config.mode === 'active') {
        this.authorityGate ||= new HomeAuthorityGate({
          adapter: local,
          stateFile: createHomeAuthorityStateFile(this.config.dataDir),
          leaseTtlMs: this.config.leaseTtlMs,
          now: this.now,
        });
        await this.authorityGate.initialize();
        authorityStatus = await this.authorityGate.status();
        if (authorityStatus.replication?.status !== 'current') {
          throw new Error('Active mode requires a reconciled current Home authority');
        }
        this.authorityClient ||= new AuthorityClient({
          baseUrl: this.config.authority.apiUrl,
          secret: this.config.authority.secret,
          timeoutMs: this.config.authority.timeoutMs,
        });
        this.publication = new ActivePublicationStrategy({
          local,
          gate: this.authorityGate,
          client: this.authorityClient,
          leaseTtlMs: this.config.leaseTtlMs,
        });
        this.notificationCoordinator ||= new ProductionNotificationCoordinator(this.config.notificationBarrier, {
          intentStore: new DurableNotificationIntentStore(this.config.dataDir, { now: this.now }),
        });
        const active = await getKV(this.publication.target(), key.channelsActive()) || [];
        const quota = this.postQuota([...new Set(active)].length);
        if (!quota.withinBudget) {
          throw new Error(
            `Active post cadence requires ${quota.requiredWithReserve} daily quota units including reserve; configured budget is ${quota.configuredDailyUnits}`,
          );
        }
      }
      const state = await this.stateFile.read();
      state.rssHealth = normalizeRssHealthState(state.rssHealth, this.now());
      state.youtubeDataApi = normalizeYoutubeDataApiState(state.youtubeDataApi, this.now());
      this.remoteConfirmationDueAt = state.rssHealth.independentProbe.nextConfirmationAt;
      const reconciledAt = Date.parse(authorityStatus?.manifest?.reconciledAt || '');
      const sweepStartedAt = Date.parse(state.currentSweep?.startedAt || '');
      if (state.currentSweep?.status === 'running'
        && Number.isFinite(reconciledAt)
        && Number.isFinite(sweepStartedAt)
        && reconciledAt > sweepStartedAt) {
        state.currentSweep = {
          ...state.currentSweep,
          status: 'failed',
          failedAt: iso(this.now()),
          failureReason: 'authority-reconciled-after-sweep-start',
        };
      }
      this.overlapSkips = Number(state.overlapSkips || 0);
      state.mode = this.config.mode;
      state.startedAt = iso(this.now());
      state.stoppedAt = null;
      state.lease = { owner: lease.owner, state: 'held' };
      state.nextSweepAt = iso(nextFiveMinuteBoundary(this.now()));
      await this.stateFile.write(state);
      return this;
    } catch (error) {
      await this.runtime.close().catch(() => {});
      await this.lease.release();
      throw error;
    }
  }

  createEnvironment(target, notifications, notificationQueue = [], pendingNotifications = new Set()) {
    return {
      ...this.config.workerBindings,
      TUBEPULSE_KV: target,
      // Active Home captures notification intents through the existing
      // no-network shadow sentinel. Delivery happens only after canonical KV,
      // the Home mirror, and the production /feed path all prove visibility.
      TUBEPULSE_NOTIFICATION_MODE: this.config.mode === 'active' ? 'shadow' : this.config.mode,
      TUBEPULSE_NOTIFICATION_DEFERRED: this.config.mode === 'active',
      TUBEPULSE_DEFERRED_NOTIFICATION_PENDING: (deviceId, channelId) => (
        pendingNotifications.has(`${deviceId}|${channelId}`)
      ),
      TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER: async (intent) => {
        const { kind, deviceId, channelId } = intent || {};
        notifications.total++;
        notifications.byKind[kind] = (notifications.byKind[kind] || 0) + 1;
        if (this.config.mode === 'active') {
          if (!deviceId || !channelId || !intent.fcmToken || !intent.projectId
            || !intent.payload || !Array.isArray(intent.contentIds) || intent.contentIds.length === 0) {
            throw new Error('Deferred notification intent is incomplete');
          }
          notificationQueue.push(intent);
          pendingNotifications.add(`${deviceId}|${channelId}`);
        }
      },
      TUBEPULSE_KV_MUTATION_LOCK: (name, operation) => this.kvMutationMutex.run(name, operation),
    };
  }

  postQuota(channelCount) {
    const projectedDailyUnits = channelCount * (1440 / this.config.postsCadenceMinutes);
    const projectedFiveMinuteDailyUnits = channelCount * (1440 / 5);
    const requiredWithReserve = projectedDailyUnits + this.config.youtubeQuotaReserveUnits;
    return {
      unitCostPerChannelSweep: 1,
      projectedDailyUnits,
      projectedFiveMinuteDailyUnits,
      reserveUnits: this.config.youtubeQuotaReserveUnits,
      configuredDailyUnits: this.config.youtubeDailyQuotaUnits,
      requiredWithReserve,
      withinBudget: requiredWithReserve <= this.config.youtubeDailyQuotaUnits,
    };
  }

  async reserveYoutubeQuota(bucket, units, priority) {
    const state = await this.stateFile.read();
    const health = normalizeYoutubeDataApiState(state.youtubeDataApi, this.now());
    const configured = bucket === 'statistics'
      ? Number(this.config.youtubeStatisticsDailyQuotaUnits || 10_000)
      : Number(this.config.youtubeDailyQuotaUnits || 10_000);
    const reserve = bucket === 'statistics'
      ? Number(this.config.youtubeStatisticsReserveUnits ?? 1_000)
      : Number(this.config.youtubeQuotaReserveUnits ?? 1_000);
    const hardCap = Math.max(0, configured - reserve);
    if (health.quota[bucket].units + units > hardCap) {
      throw new YouTubeDataApiError(`YouTube ${bucket} quota safety cap reached`, {
        category: `${bucket}-quota-cap`, retryable: false,
      });
    }
    health.quota[bucket].units += units;
    health.quota[bucket].requests++;
    health.quota[bucket].lastPriority = priority;
    health.quota[bucket].lastRequestAt = iso(this.now());
    state.youtubeDataApi = health;
    await this.stateFile.write(state);
  }

  dataApiClient() {
    if (!this.youtubeDataApiClient) {
      this.youtubeDataApiClient = new YouTubeDataApiClient({
        apiKey: this.config.workerBindings?.YOUTUBE_API_KEY,
        timeoutMs: this.config.channelTimeoutMs,
        reserve: (bucket, units, priority) => this.reserveYoutubeQuota(bucket, units, priority),
      });
    }
    return this.youtubeDataApiClient;
  }

  async recordYoutubeApiFailure(bucket, error) {
    const state = await this.stateFile.read();
    const health = normalizeYoutubeDataApiState(state.youtubeDataApi, this.now());
    health.quota[bucket].failures++;
    health.lastError = {
      at: iso(this.now()),
      category: String(error?.category || error?.name || 'youtube-api-failed').slice(0, 60),
    };
    state.youtubeDataApi = health;
    await this.stateFile.write(state);
  }

  async applyStatistics(target, channelRecents, due, statistics) {
    const dueByChannel = new Map();
    for (const entry of due) {
      const metrics = statistics.get(entry.video.videoId);
      if (!metrics) continue;
      if (!dueByChannel.has(entry.channelId)) dueByChannel.set(entry.channelId, new Map());
      dueByChannel.get(entry.channelId).set(entry.video.videoId, metrics);
    }
    for (const [channelId, byVideo] of dueByChannel) {
      const recent = channelRecents.get(channelId) || [];
      const uploads = recent.map((video) => ({
        videoId: video.videoId,
        title: video.title,
        published: video.publishedAt,
        publishedAt: video.publishedAt,
        thumbnail: video.thumbnail,
        link: video.link || `https://www.youtube.com/watch?v=${video.videoId}`,
        type: video.type,
        views: byVideo.has(video.videoId) ? byVideo.get(video.videoId).views : video.views,
        likes: byVideo.has(video.videoId) ? byVideo.get(video.videoId).likes : video.likes,
        comments: byVideo.has(video.videoId) ? byVideo.get(video.videoId).comments : video.comments,
        dislikes: null,
      }));
      const merged = mergeRssUploadsIntoRecentVideos(recent, uploads, this.now());
      await putKVIfChanged(target, key.channelRecent(channelId), merged, recent);
      channelRecents.set(channelId, merged);
    }
  }

  async runYoutubeDataApiCycle(env, target, scheduledTime, { force = false } = {}) {
    const startedAt = this.now();
    if (!force && Math.floor(scheduledTime / MINUTE_MS) % 5 !== 0) {
      return { outcome: 'not-due', sourceMode: 'youtube-data-api', scheduledAt: iso(scheduledTime) };
    }
    const active = await getKV(target, key.channelsActive()) || [];
    const channels = [...new Set(active)].sort();
    const api = this.dataApiClient();
    const detectorItems = [];
    let detectorFailures = 0;
    for (const ids of chunked(channels, 50)) {
      try {
        const payload = await api.listChannels(ids);
        detectorItems.push(...(payload.items || []));
      } catch (error) {
        detectorFailures++;
        await this.recordYoutubeApiFailure('general', error);
      }
    }
    if (detectorFailures > 0) {
      return {
        outcome: detectorItems.length ? 'partial' : 'error', sourceMode: 'youtube-data-api',
        activeCount: active.length, uniqueActiveCount: channels.length,
        detectorRequests: Math.ceil(channels.length / 50), detectorFailures,
        reconciledCount: 0, statisticsRequests: 0,
      };
    }

    let state = await this.stateFile.read();
    let health = normalizeYoutubeDataApiState(state.youtubeDataApi, this.now());
    const returned = new Map(detectorItems.map((item) => [item.id, item]));
    const candidates = [];
    const safetyMs = Number(this.config.youtubeSafetyReconcileHours || 6) * 60 * 60 * 1000;
    for (const channelId of channels) {
      const item = returned.get(channelId);
      if (!item) continue;
      const previous = health.channels[channelId] || {};
      const videoCount = Number(item.statistics?.videoCount);
      const uploadsPlaylistId = item.contentDetails?.relatedPlaylists?.uploads || previous.uploadsPlaylistId || null;
      const baselineMissing = !Number.isFinite(Number(previous.videoCount));
      const changed = !baselineMissing && Number(previous.videoCount) !== videoCount;
      const lastReconciled = Date.parse(previous.lastReconciledAt || '');
      const safetyDue = !Number.isFinite(lastReconciled) || this.now() - lastReconciled >= safetyMs;
      health.channels[channelId] = {
        ...previous,
        uploadsPlaylistId,
        videoCount: Number.isFinite(videoCount) ? videoCount : previous.videoCount ?? null,
        etag: item.etag || null,
        channelViewCount: item.statistics?.viewCount ?? null,
        subscriberCount: item.statistics?.subscriberCount ?? null,
        hiddenSubscriberCount: Boolean(item.statistics?.hiddenSubscriberCount),
        lastDetectorAt: iso(this.now()),
      };
      if (uploadsPlaylistId && (baselineMissing || changed || safetyDue)) {
        candidates.push({ channelId, baselineMissing, changed, safetyDue, uploadsPlaylistId, lastReconciled });
      }
    }
    candidates.sort((left, right) => (
      Number(right.changed) - Number(left.changed)
      || Number(right.baselineMissing) - Number(left.baselineMissing)
      || (Number.isFinite(left.lastReconciled) ? left.lastReconciled : 0)
        - (Number.isFinite(right.lastReconciled) ? right.lastReconciled : 0)
      || left.channelId.localeCompare(right.channelId)
    ));
    state.youtubeDataApi = health;
    await this.stateFile.write(state);

    // A detector baseline alone cannot complete a source migration. Every
    // established channel must reconcile once against its durable watermark,
    // otherwise a baseline captured after an outage can hide missed uploads.
    const migrationPending = candidates.some((entry) => !Number.isFinite(entry.lastReconciled));
    const reconcileLimit = migrationPending
      ? Number(this.config.youtubeMaxMigrationReconciliationsPerCycle || 100)
      : Number(this.config.youtubeMaxReconciliationsPerCycle || 5);
    const selected = candidates.slice(0, reconcileLimit);
    const reconcileResults = [];
    for (const candidate of selected) {
      try {
        const known = await getKV(target, key.channelKnownVideos(candidate.channelId));
        const result = await fetchPlaylistReconciliation({
          api,
          playlistId: candidate.uploadsPlaylistId,
          knownIds: known?.ids || [],
          maximumPages: Number(this.config.youtubeMaxPlaylistPages || 3),
        });
        const ctx = new WaitUntilContext();
        const processed = await processChannelUploads(env, ctx, candidate.channelId, {
          channelName: result.uploads[0]?.channelTitle || null,
          uploads: result.uploads,
        }, { now: this.now(), logPrefix: 'YouTube API' });
        await ctx.flush();
        state = await this.stateFile.read();
        health = normalizeYoutubeDataApiState(state.youtubeDataApi, this.now());
        health.channels[candidate.channelId] = {
          ...health.channels[candidate.channelId],
          lastReconciledAt: iso(this.now()),
          lastReconcileOutcome: processed?.outcome || 'ok',
          lastPageCount: result.pageCount,
          paginationBoundReached: result.truncatedWithoutOverlap,
        };
        state.youtubeDataApi = health;
        await this.stateFile.write(state);
        reconcileResults.push({ channelId: candidate.channelId, outcome: 'ok', pageCount: result.pageCount, processed: processed?.outcome });
      } catch (error) {
        await this.recordYoutubeApiFailure('general', error);
        reconcileResults.push({
          channelId: candidate.channelId, outcome: 'error',
          errorCategory: String(error?.category || error?.name || 'reconcile-failed').slice(0, 60),
        });
      }
    }

    const channelRecents = new Map();
    for (const channelId of channels) channelRecents.set(channelId, await getKV(target, key.channelRecent(channelId)) || []);
    state = await this.stateFile.read();
    health = normalizeYoutubeDataApiState(state.youtubeDataApi, this.now());
    const newestOnly = health.statsMethod === 'videos.list';
    const due = selectDueMetricVideos(channelRecents, health.metricPoll, scheduledTime, { newestOnly });
    let statsMethod = health.statsMethod;
    let statisticsRequests = 0;
    const allStatistics = new Map();
    for (const entries of chunked(due, 50)) {
      try {
        let payload;
        try {
          payload = await api.batchGetStats(entries.map((entry) => entry.video.videoId), statsMethod);
        } catch (error) {
          if (statsMethod === 'batchGetStats' && ['not-found', 'http-400'].includes(error?.category)) {
            await this.recordYoutubeApiFailure('statistics', error);
            statsMethod = 'videos.list';
            payload = await api.batchGetStats(entries.map((entry) => entry.video.videoId), 'videos.list');
          } else throw error;
        }
        statisticsRequests++;
        for (const [videoId, metrics] of normalizeStatistics(payload)) allStatistics.set(videoId, metrics);
      } catch (error) {
        await this.recordYoutubeApiFailure(statsMethod === 'batchGetStats' ? 'statistics' : 'general', error);
        break;
      }
    }
    await this.applyStatistics(target, channelRecents, due, allStatistics);
    state = await this.stateFile.read();
    health = normalizeYoutubeDataApiState(state.youtubeDataApi, this.now());
    health.statsMethod = statsMethod;
    for (const entry of due) {
      const metrics = allStatistics.get(entry.video.videoId);
      if (!metrics) continue;
      const signature = stableJson(metrics);
      const previous = health.metricPoll[entry.video.videoId] || {};
      health.metricPoll[entry.video.videoId] = {
        lastPolledAt: iso(scheduledTime),
        lastObserved: signature,
        staticStreak: previous.lastObserved === signature ? Number(previous.staticStreak || 0) + 1 : 0,
      };
    }
    health.metricPoll = pruneMetricPollToVisibleVideos(health.metricPoll, channelRecents);
    health.lastGoodAt = iso(this.now());
    health.lastError = null;
    health.lastCycle = {
      scheduledAt: iso(scheduledTime), finishedAt: iso(this.now()), detectorRequests: Math.ceil(channels.length / 50),
      activeCount: active.length, uniqueActiveCount: channels.length,
      changedCount: candidates.filter((entry) => entry.changed).length,
      reconciliationDueCount: candidates.length, reconciledCount: reconcileResults.filter((entry) => entry.outcome === 'ok').length,
      reconciliationDeferredCount: Math.max(0, candidates.length - selected.length),
      statisticsVideoCount: allStatistics.size, statisticsRequests,
    };
    state.youtubeDataApi = health;
    await this.stateFile.write(state);
    return {
      id: `youtube-${Math.floor(scheduledTime / FIVE_MINUTES_MS)}`,
      outcome: reconcileResults.some((entry) => entry.outcome === 'error') ? 'partial' : 'ok',
      sourceMode: 'youtube-data-api', startedAt: iso(startedAt), finishedAt: iso(this.now()),
      durationMs: this.now() - startedAt, activeCount: active.length, uniqueActiveCount: channels.length,
      detectorRequests: Math.ceil(channels.length / 50), detectorFailures: 0,
      changedCount: candidates.filter((entry) => entry.changed).length,
      reconciliationDueCount: candidates.length, reconciledCount: reconcileResults.filter((entry) => entry.outcome === 'ok').length,
      reconciliationDeferredCount: Math.max(0, candidates.length - selected.length),
      reconcileResults, statisticsVideoCount: allStatistics.size, statisticsRequests, statsMethod: health.statsMethod,
    };
  }

  async pollChannelWithRetry(env, ctx, channelId) {
    const errors = [];
    for (let attempt = 0; attempt <= this.config.retryCount; attempt++) {
      try {
        await withTimeout(
          Promise.resolve(this.rssPoller(env, ctx, channelId, { failOnFetchError: true })),
          this.config.channelTimeoutMs,
          `RSS channel ${channelId}`,
        );
        return { channelId, outcome: 'ok', attempts: attempt + 1 };
      } catch (error) {
        errors.push(error?.message || String(error));
        if (attempt < this.config.retryCount) {
          await this.sleep(this.config.retryBackoffMs * (2 ** attempt));
        }
      }
    }
    return { channelId, outcome: 'error', attempts: errors.length, errorCategory: 'poll-failed' };
  }

  async pollRssChannelOnce(env, channelId) {
    const ctx = new WaitUntilContext();
    const timeoutMs = this.config.rssChannelTimeoutMs ?? this.config.channelTimeoutMs;
    try {
      const result = await withTimeout(
        Promise.resolve(this.rssPoller(env, ctx, channelId, {
          failOnFetchError: true,
          timeoutMs,
          quiet: this.config.quiet,
        })),
        timeoutMs,
        'RSS channel request',
      );
      await ctx.flush();
      return { outcome: 'ok', attempts: 1, pollOutcome: result?.outcome || 'ok' };
    } catch (error) {
      await ctx.flush();
      return {
        outcome: 'error',
        attempts: 1,
        errorCategory: String(error?.category || (String(error?.message || '').includes('timed out') ? 'timeout' : 'poll-failed')),
      };
    }
  }

  async independentRssProbe(activeChannelId) {
    if (!this.authorityClient?.probeRss) {
      return { outcome: 'inconclusive', probes: [], errorCategory: 'authority-client-unavailable' };
    }
    try {
      const result = await this.authorityClient.probeRss(activeChannelId);
      return validateIndependentRssProbe(result, activeChannelId);
    } catch (error) {
      return {
        outcome: 'inconclusive',
        probes: [],
        errorCategory: String(error?.operation || error?.name || 'probe-unavailable').slice(0, 40),
      };
    }
  }

  fallbackPlan(channelCount) {
    return fallbackQuotaPlan({
      channelCount,
      dailyQuotaUnits: this.config.youtubeDailyQuotaUnits,
      reserveUnits: this.config.youtubeQuotaReserveUnits,
      postsCadenceMinutes: this.config.postsCadenceMinutes,
      explicitDailyCap: this.config.youtubeApiFallback?.dailyCap ?? null,
    });
  }

  refreshFallbackQuota(health, channelCount, nowMs) {
    const window = pacificQuotaWindow(nowMs);
    if (health.fallback.quotaDay !== window.day) {
      health.fallback.quotaDay = window.day;
      health.fallback.quotaUsed = 0;
      health.fallback.quotaUnitsUsed = 0;
      health.fallback.requests = 0;
      health.fallback.failures = 0;
      health.fallback.skipped = 0;
      health.fallback.lastError = null;
    }
    const plan = this.fallbackPlan(channelCount);
    health.fallback.quotaUnitsUsed = Math.max(Number(health.fallback.quotaUnitsUsed || 0), Number(health.fallback.quotaUsed || 0));
    health.fallback.quotaUsed = health.fallback.quotaUnitsUsed;
    health.fallback.requests = Number(health.fallback.requests ?? health.fallback.quotaUnitsUsed);
    health.fallback.quotaLimit = plan.dailyCap;
    health.fallback.quotaUnitLimit = plan.quotaUnitLimit;
    health.fallback.requestLimit = plan.requestLimit;
    health.fallback.projectedDailyRequests = plan.projectedDailyRequests;
    health.fallback.reserveUnits = plan.reserveUnits;
    health.fallback.postsProjection = plan.postsProjection;
    health.fallback.resetsAt = window.resetsAt;
    health.fallback.coverageMinutes = plan.coverageMinutes;
    return plan;
  }

  resetIndependentRssConfirmation(health) {
    this.remoteConfirmationDueAt = null;
    Object.assign(health.independentProbe, {
      unavailableStreak: 0, firstUnavailableAt: null, lastUnavailableAt: null,
      nextConfirmationAt: null, confirmedAt: null, confirmationPending: false,
    });
  }

  applyIndependentRssProbe(health, probe, channelCount) {
    const nowMs = this.now();
    const previous = health.independentProbe;
    const lastUnavailableMs = Date.parse(previous.lastUnavailableAt || '');
    health.independentProbe = {
      ...previous, lastAt: iso(nowMs), outcome: probe.outcome,
      official: probe.probes.find((entry) => entry.label === 'official') || null,
      active: probe.probes.find((entry) => entry.label === 'active') || null,
      errorCategory: probe.errorCategory || null,
    };
    if (probe.outcome !== 'failure') {
      this.resetIndependentRssConfirmation(health);
      health.sourceMode = probe.outcome === 'success' ? 'home-egress-throttled' : 'rss-probe-inconclusive';
      return;
    }
    const streak = Number(previous.unavailableStreak || 0);
    // A repeated call within the minute can never manufacture confirmation.
    const spaced = Number.isFinite(lastUnavailableMs) && nowMs - lastUnavailableMs >= MINUTE_MS;
    const nextStreak = streak > 0 ? (spaced ? Math.min(2, streak + 1) : streak) : 1;
    Object.assign(health.independentProbe, {
      unavailableStreak: nextStreak,
      firstUnavailableAt: previous.firstUnavailableAt || iso(nowMs),
      lastUnavailableAt: streak > 0 && !spaced ? previous.lastUnavailableAt : iso(nowMs),
      nextConfirmationAt: nextStreak < 2 ? iso((streak > 0 && !spaced ? lastUnavailableMs : nowMs) + MINUTE_MS) : null,
      confirmedAt: nextStreak >= 2 ? previous.confirmedAt || iso(nowMs) : null,
      confirmationPending: nextStreak < 2,
    });
    this.remoteConfirmationDueAt = health.independentProbe.nextConfirmationAt;
    if (nextStreak < 2) {
      health.sourceMode = 'rss-probe-confirming';
      return;
    }
    const plan = this.refreshFallbackQuota(health, channelCount, nowMs);
    const fallbackAvailable = this.config.youtubeApiFallback?.enabled
      && this.config.workerBindings?.YOUTUBE_API_KEY
      && health.fallback.requests < plan.requestLimit
      && health.fallback.quotaUnitsUsed < plan.quotaUnitLimit;
    health.sourceMode = fallbackAvailable ? 'rss-global-down-api-fallback' : 'stale-cache';
  }

  async openRssCircuit(health, channels, outageClass, scheduledTime) {
    const nowMs = this.now();
    const probe = await this.independentRssProbe(channels[0]);
    this.refreshFallbackQuota(health, channels.length, nowMs);
    const cooldownMinutes = Math.min(
      this.config.rssCircuitInitialCooldownMinutes ?? 15,
      this.config.rssCircuitMaximumCooldownMinutes ?? 60,
    );
    this.resetIndependentRssConfirmation(health);
    this.applyIndependentRssProbe(health, probe, channels.length);
    health.circuit = {
      open: true,
      reason: `full-fleet-${outageClass}`,
      outageClass,
      openedAt: iso(nowMs),
      until: iso(nowMs + cooldownMinutes * MINUTE_MS),
      cooldownMinutes,
      recoverySuccesses: 0,
      confirmedCycleAt: iso(scheduledTime),
    };
  }

  async runYoutubeFallback(env, health, channels, scheduledTime) {
    const plan = this.refreshFallbackQuota(health, channels.length, this.now());
    if (!this.config.youtubeApiFallback?.enabled || !this.config.workerBindings?.YOUTUBE_API_KEY) {
      return { outcome: 'not-configured', requestCount: 0, coverageMinutes: plan.coverageMinutes };
    }
    if (!plan.coverageMinutes || plan.dailyCap <= 0) {
      health.fallback.skipped++;
      return { outcome: 'quota-unavailable', requestCount: 0, coverageMinutes: plan.coverageMinutes };
    }
    const selected = fallbackChannelsForMinute(channels, scheduledTime, plan.coverageMinutes);
    if (selected.length === 0) return { outcome: 'not-due', requestCount: 0, coverageMinutes: plan.coverageMinutes };
    let successes = 0;
    let failures = 0;
    let quotaBlocked = 0;
    for (const channelId of selected) {
      // Check both persisted budgets before every individual call, including
      // when the selected cohort contains two channels.
      const currentPlan = this.refreshFallbackQuota(health, channels.length, this.now());
      if (!Number.isFinite(health.fallback.requests) || !Number.isFinite(health.fallback.quotaUnitsUsed)
        || health.fallback.requests + 1 > currentPlan.requestLimit
        || health.fallback.quotaUnitsUsed + 1 > currentPlan.quotaUnitLimit) {
        health.fallback.skipped++;
        quotaBlocked++;
        continue;
      }
      // playlistItems.list consumes one quota unit whether the request
      // succeeds or returns an API error, so reserve the unit first.
      health.fallback.quotaUnitsUsed++;
      health.fallback.quotaUsed = health.fallback.quotaUnitsUsed;
      health.fallback.requests++;
      const reservedState = await this.stateFile.read();
      reservedState.rssHealth = health;
      await this.stateFile.write(reservedState);
      try {
        const source = await this.youtubeApiFetcher(channelId, {
          apiKey: this.config.workerBindings.YOUTUBE_API_KEY,
          timeoutMs: this.config.channelTimeoutMs,
        });
        const ctx = new WaitUntilContext();
        await withTimeout(
          processChannelUploads(env, ctx, channelId, source, { now: this.now() }),
          this.config.channelTimeoutMs,
          'YouTube API fallback processing',
        );
        await ctx.flush();
        successes++;
        health.lastGoodApiAt = iso(this.now());
        health.fallback.lastError = null;
      } catch (error) {
        failures++;
        health.fallback.failures++;
        health.fallback.lastError = {
          at: iso(this.now()),
          category: String(error?.category || error?.name || 'fallback-failed').slice(0, 40),
        };
      }
    }
    return {
      outcome: quotaBlocked ? 'quota-blocked' : failures ? (successes ? 'partial' : 'error') : 'ok',
      requestCount: successes + failures,
      successCount: successes,
      failureCount: failures,
      quotaBlocked,
      coverageMinutes: plan.coverageMinutes,
    };
  }

  async runOpenCircuitTick(env, channels, scheduledTime, health) {
    const normalPlan = rssCohortForMinute(channels, scheduledTime);
    health.skippedCount += normalPlan.channels.length;
    const confirmationDueAt = Date.parse(health.independentProbe.nextConfirmationAt || '');
    if (health.independentProbe.confirmationPending && Number.isFinite(confirmationDueAt)
      && this.now() >= confirmationDueAt && channels.length > 0) {
      const probe = await this.independentRssProbe(normalPlan.order[0]);
      this.applyIndependentRssProbe(health, probe, channels.length);
      if (!health.independentProbe.confirmationPending) {
        health.circuit.until = iso(this.now() + health.circuit.cooldownMinutes * MINUTE_MS);
      }
      const fallback = health.sourceMode === 'rss-global-down-api-fallback'
        ? await this.runYoutubeFallback(env, health, channels, scheduledTime) : null;
      return { sourceMode: health.sourceMode, outcome: 'remote-confirmation', homeProbe: 'not-due', fallback };
    }
    const dueAt = Date.parse(health.circuit.until || '');
    if (Number.isFinite(dueAt) && this.now() >= dueAt && channels.length > 0) {
      const probeChannel = normalPlan.order[0];
      const homeProbe = await this.pollRssChannelOnce(env, probeChannel);
      health.requestCount++;
      health.attemptCount++;
      if (homeProbe.outcome === 'ok') {
        this.resetIndependentRssConfirmation(health);
        health.lastGoodRssAt = iso(this.now());
        health.circuit.recoverySuccesses = Number(health.circuit.recoverySuccesses || 0) + 1;
        health.sourceMode = 'rss-recovering';
        if (health.circuit.recoverySuccesses >= (this.config.rssRecoverySuccessesRequired ?? 2)) {
          health.sourceMode = 'rss';
          health.circuit = {
            open: false,
            reason: null,
            outageClass: null,
            openedAt: null,
            until: null,
            cooldownMinutes: this.config.rssCircuitInitialCooldownMinutes ?? 15,
            recoverySuccesses: 0,
          };
          health.currentCycle = null;
          return { sourceMode: 'rss', outcome: 'recovered', homeProbe: 'success', fallback: null };
        }
        health.circuit.until = iso(this.now() + MINUTE_MS);
        return { sourceMode: health.sourceMode, outcome: 'recovering', homeProbe: 'success', fallback: null };
      }

      health.circuit.recoverySuccesses = 0;
      health.circuit.outageClass = homeProbe.errorCategory;
      const probe = await this.independentRssProbe(probeChannel);
      this.applyIndependentRssProbe(health, probe, channels.length);
      const cooldown = Math.min(
        Math.max(this.config.rssCircuitInitialCooldownMinutes ?? 15, Number(health.circuit.cooldownMinutes || 15) * 2),
        this.config.rssCircuitMaximumCooldownMinutes ?? 60,
      );
      health.circuit.cooldownMinutes = cooldown;
      health.circuit.until = iso(this.now() + cooldown * MINUTE_MS);
      return { sourceMode: health.sourceMode, outcome: 'probe-failed', homeProbe: homeProbe.errorCategory, fallback: null };
    }

    const fallback = health.sourceMode === 'rss-global-down-api-fallback'
      ? await this.runYoutubeFallback(env, health, channels, scheduledTime)
      : null;
    return { sourceMode: health.sourceMode, outcome: 'backoff', homeProbe: 'not-due', fallback };
  }

  async runRssCohort(env, target, scheduledTime) {
    const active = await getKV(target, key.channelsActive()) || [];
    const channels = [...new Set(active)].sort();
    const state = await this.stateFile.read();
    const health = normalizeRssHealthState(state.rssHealth, this.now());
    const startedAt = this.now();
    if (health.circuit.open) {
      const circuit = await this.runOpenCircuitTick(env, channels, scheduledTime, health);
      state.rssHealth = health;
      state.currentSweep = null;
      await this.stateFile.write(state);
      return {
        scheduledAt: iso(scheduledTime),
        finishedAt: iso(this.now()),
        durationMs: this.now() - startedAt,
        activeCount: active.length,
        uniqueActiveCount: channels.length,
        duplicateActiveEntries: active.length - channels.length,
        coveredCount: circuit.homeProbe === 'success' ? 1 : 0,
        successCount: circuit.homeProbe === 'success' ? 1 : 0,
        failureCount: circuit.outcome === 'probe-failed' ? 1 : 0,
        retryCount: 0,
        concurrency: 1,
        sourceMode: health.sourceMode,
        circuit,
      };
    }

    const plan = rssCohortForMinute(channels, scheduledTime);
    const planHash = crypto.createHash('sha256').update(stableJson(plan.order)).digest('hex');
    if (health.currentCycle?.cycle !== plan.cycle || health.currentCycle?.planHash !== planHash) {
      health.currentCycle = {
        cycle: plan.cycle,
        planHash,
        channelCount: channels.length,
        startedAt: iso(this.now()),
        results: Array(channels.length).fill(null),
      };
    }
    const cycle = health.currentCycle;
    if (!Array.isArray(cycle.results) || cycle.results.length !== channels.length) {
      cycle.results = Array(channels.length).fill(null);
    }
    state.currentSweep = {
      id: `${plan.cycle}-${plan.slot}`,
      status: 'running',
      scheduledAt: iso(scheduledTime),
      startedAt: iso(startedAt),
      cycle: plan.cycle,
      cohort: plan.slot,
      channelCount: plan.channels.length,
      completedCount: 0,
    };
    state.rssHealth = health;
    await this.stateFile.write(state);

    const results = [];
    // RSS rollback mode is intentionally sequential so a fleet-wide failure
    // cannot become a concentrated boundary burst.
    for (const channelId of plan.channels) {
      const orderIndex = plan.order.indexOf(channelId);
      if (cycle.results[orderIndex]) {
        results.push({ ...cycle.results[orderIndex], resumed: true });
        continue;
      }
      const result = await this.pollRssChannelOnce(env, channelId);
      health.requestCount++;
      health.attemptCount++;
      if (result.outcome === 'ok') health.lastGoodRssAt = iso(this.now());
      const stored = result.outcome === 'ok'
        ? { outcome: 'ok', attempts: 1 }
        : { outcome: 'error', attempts: 1, errorCategory: result.errorCategory };
      cycle.results[orderIndex] = stored;
      results.push(stored);
      const progress = await this.stateFile.read();
      progress.rssHealth = health;
      progress.currentSweep = {
        ...progress.currentSweep,
        completedCount: Number(progress.currentSweep?.completedCount || 0) + 1,
      };
      await this.stateFile.write(progress);
    }

    let circuitOpened = false;
    const completed = cycle.results.filter(Boolean);
    if (completed.length === channels.length && channels.length > 0) {
      const outageClass = sameFleetOutage(completed, channels.length);
      if (outageClass) {
        await this.openRssCircuit(health, channels, outageClass, scheduledTime);
        circuitOpened = true;
      } else {
        health.sourceMode = 'rss';
      }
    }
    const finalState = await this.stateFile.read();
    finalState.rssHealth = health;
    await this.stateFile.write(finalState);
    return {
      id: `${plan.cycle}-${plan.slot}`,
      scheduledAt: iso(scheduledTime),
      startedAt: iso(startedAt),
      finishedAt: iso(this.now()),
      durationMs: this.now() - startedAt,
      activeCount: active.length,
      uniqueActiveCount: channels.length,
      duplicateActiveEntries: active.length - channels.length,
      cohort: plan.slot,
      cohortCount: 5,
      coveredCount: results.length,
      successCount: results.filter((entry) => entry.outcome === 'ok').length,
      failureCount: results.filter((entry) => entry.outcome === 'error').length,
      retryCount: 0,
      concurrency: 1,
      sourceMode: health.sourceMode,
      circuitOpened,
      failureCategories: [...new Set(results.filter((entry) => entry.errorCategory).map((entry) => entry.errorCategory))],
    };
  }

  async pollPostWithRetry(env, ctx, channelId) {
    const errors = [];
    for (let attempt = 0; attempt <= this.config.retryCount; attempt++) {
      try {
        await withTimeout(
          Promise.resolve(this.postPoller(
            env,
            ctx,
            channelId,
            isCommunityPostsDebugEnabled(env),
            {
              failOnFetchError: true,
              maxResponseBytes: this.config.postsMaxResponseBytes,
            },
          )),
          this.config.channelTimeoutMs,
          `community posts channel ${channelId}`,
        );
        return { channelId, outcome: 'ok', attempts: attempt + 1 };
      } catch (error) {
        errors.push(error?.message || String(error));
        if (attempt < this.config.retryCount) {
          await this.sleep(this.config.retryBackoffMs * (2 ** attempt));
        }
      }
    }
    return { channelId, outcome: 'error', attempts: errors.length, errorCategory: 'post-poll-failed' };
  }

  async runRssSweep(env, target, scheduledTime) {
    const active = await getKV(target, key.channelsActive()) || [];
    const channels = [...new Set(active)].sort();
    const previousState = await this.stateFile.read();
    const resumable = previousState.currentSweep?.status === 'running'
      && stableJson(previousState.currentSweep.channels) === stableJson(channels);
    const completedBefore = new Set(resumable ? previousState.currentSweep.completedChannels || [] : []);
    const remaining = channels.filter((channelId) => !completedBefore.has(channelId));
    const startedAt = this.now();
    const currentSweep = {
      id: resumable ? previousState.currentSweep.id : crypto.randomUUID(),
      status: 'running',
      scheduledAt: iso(scheduledTime),
      startedAt: resumable ? previousState.currentSweep.startedAt : iso(startedAt),
      resumed: resumable,
      channels,
      completedChannels: [...completedBefore],
    };
    previousState.currentSweep = currentSweep;
    await this.stateFile.write(previousState);

    let completionWrite = Promise.resolve();
    const results = await mapLimit(remaining, this.config.concurrency, async (channelId) => {
      const ctx = new WaitUntilContext();
      const result = await this.pollChannelWithRetry(env, ctx, channelId);
      await ctx.flush();
      completionWrite = completionWrite.then(async () => {
        const state = await this.stateFile.read();
        if (!state.currentSweep.completedChannels.includes(channelId)) {
          state.currentSweep.completedChannels.push(channelId);
          await this.stateFile.write(state);
        }
      });
      await completionWrite;
      return result;
    });
    const allResults = [
      ...[...completedBefore].map((channelId) => ({ channelId, outcome: 'resumed-complete', attempts: 0 })),
      ...results,
    ];
    return {
      id: currentSweep.id,
      scheduledAt: currentSweep.scheduledAt,
      startedAt: currentSweep.startedAt,
      finishedAt: iso(this.now()),
      durationMs: this.now() - startedAt,
      activeCount: active.length,
      uniqueActiveCount: channels.length,
      duplicateActiveEntries: active.length - channels.length,
      coveredCount: allResults.length,
      successCount: allResults.filter((entry) => entry.outcome !== 'error').length,
      failureCount: allResults.filter((entry) => entry.outcome === 'error').length,
      retryCount: allResults.reduce((sum, entry) => sum + Math.max(0, entry.attempts - 1), 0),
      concurrency: this.config.concurrency,
      failures: allResults.filter((entry) => entry.outcome === 'error').map(({ channelId, errorCategory, attempts }) => ({
        channelId,
        errorCategory,
        attempts,
      })),
    };
  }

  async runMinuteJobs(env, target, scheduledTime, { forcePosts = false } = {}) {
    const ctx = new WaitUntilContext();
    const result = { scheduledAt: iso(scheduledTime), posts: { outcome: 'disabled' }, aux: { outcome: 'pending' } };
    if (isCommunityPostsEnabled(env)) {
      const active = await getKV(target, key.channelsActive()) || [];
      const allowlist = parseCommunityPostChannelAllowlist(env);
      const eligible = [...new Set(active.filter((channelId) => allowlist.size === 0 || allowlist.has(channelId)))].sort();
      const minuteSlot = Math.floor(scheduledTime / MINUTE_MS);
      const quota = this.postQuota(eligible.length);
      if (eligible.length === 0) {
        result.posts = { outcome: 'no-eligible-channel' };
      } else if (!forcePosts && minuteSlot % this.config.postsCadenceMinutes !== 0) {
        result.posts = { outcome: 'not-due', cadenceMinutes: this.config.postsCadenceMinutes, channelCount: eligible.length, quota };
      } else if (this.config.mode === 'active' && !quota.withinBudget) {
        result.posts = { outcome: 'quota-blocked', cadenceMinutes: this.config.postsCadenceMinutes, channelCount: eligible.length, quota };
      } else {
        const postResults = await mapLimit(eligible, this.config.postsConcurrency, async (channelId) => {
          return await this.pollPostWithRetry(env, ctx, channelId);
        });
        result.posts = {
          outcome: postResults.some((entry) => entry.outcome === 'error') ? 'partial' : 'ok',
          cadenceMinutes: this.config.postsCadenceMinutes,
          channelCount: eligible.length,
          coveredCount: postResults.length,
          successCount: postResults.filter((entry) => entry.outcome === 'ok').length,
          failureCount: postResults.filter((entry) => entry.outcome === 'error').length,
          retryCount: postResults.reduce((sum, entry) => sum + Math.max(0, entry.attempts - 1), 0),
          failures: postResults.filter((entry) => entry.outcome === 'error'),
          concurrency: this.config.postsConcurrency,
          quota,
        };
      }
    }
    try {
      await this.auxRunner(env, ctx, scheduledTime);
      result.aux = { outcome: 'ok' };
    } catch {
      result.aux = { outcome: 'error', errorCategory: 'aux-run-failed' };
    }
    await ctx.flush();
    return result;
  }

  async runTick(scheduledTime = this.now(), { forceSweep = false, forcePosts = forceSweep } = {}) {
    if (this.config.mode === 'standby') return { outcome: 'standby' };
    if (this.running) {
      this.overlapSkips++;
      const state = await this.stateFile.read();
      state.overlapSkips = Math.max(Number(state.overlapSkips || 0) + 1, this.overlapSkips);
      await this.stateFile.write(state);
      return { outcome: 'overlap-skipped' };
    }
    this.running = true;
    const journal = new MutationJournal();
    const notifications = { total: 0, byKind: {} };
    const notificationQueue = [];
    const pendingNotifications = new Set();
    try {
      // Minute ticks keep posts/aux work aligned. Video detection itself is
      // batched and runs only on aligned five-minute boundaries.
      const shouldPrepare = true;
      const seed = shouldPrepare ? await this.publication.prepare() : null;
      const target = new RecordingKv(this.publication.target(), journal);
      const env = this.createEnvironment(target, notifications, notificationQueue, pendingNotifications);
      const sweep = this.config.videoSourceMode === 'youtube-api'
        ? await this.runYoutubeDataApiCycle(env, target, scheduledTime, { force: forceSweep })
        : forceSweep
          ? await this.runRssSweep(env, target, scheduledTime)
          : await this.runRssCohort(env, target, scheduledTime);
      const minuteJobs = await this.runMinuteJobs(env, target, scheduledTime, { forcePosts });
      let publication;
      let notificationPublication = null;
      let notificationDelivery;
      if (this.config.mode === 'active') {
        await this.notificationCoordinator.stage(notificationQueue);
        // The content/state batch must be canonical before the public feed
        // visibility barrier and FCM delivery. Delivery callbacks may create a
        // small second state batch (for example lastNagAt); it is published
        // before releasing the shared Home lease.
        publication = await this.publication.finish(journal, { final: false });
        notificationDelivery = publication.canonicalBackupDeferred
          ? await this.notificationCoordinator.suppress(notificationQueue, 'canonical-backup-deferred')
          : await this.notificationCoordinator.flush(notificationQueue, env);
        notificationPublication = await this.publication.finish(journal, { final: true });
      } else {
        notificationDelivery = {
          queued: notifications.total,
          sent: 0,
          failed: 0,
          suppressed: notifications.total,
          barrier: 'shadow',
        };
        publication = await this.publication.finish(journal);
      }
      const mutationSummary = journal.summary();
      const state = await this.stateFile.read();
      state.overlapSkips = Math.max(Number(state.overlapSkips || 0), this.overlapSkips);
      if (sweep) {
        state.currentSweep = null;
        state.lastSweep = {
          ...sweep,
          seed,
          mutations: mutationSummary,
          publication,
          wouldNotify: notifications,
          notificationDelivery,
          notificationPublication,
        };
      }
      state.lastMinuteJobs = minuteJobs;
      state.lastNotificationDelivery = notificationDelivery;
      state.nextSweepAt = iso(nextFiveMinuteBoundary(this.now()));
      await this.stateFile.write(state);
      return {
        outcome: 'ok', sweep, minuteJobs, seed, mutations: mutationSummary,
        publication, notificationPublication, wouldNotify: notifications, notificationDelivery,
      };
    } catch (error) {
      if (this.config.mode === 'active') await this.publication?.abort('scheduler-tick-failed').catch(() => {});
      throw error;
    } finally {
      this.running = false;
    }
  }

  async handleScheduledTickError(error, scheduledTime) {
    const state = await this.stateFile.read();
    const failedAt = iso(this.now());
    const message = String(error?.message || error || 'Unknown scheduler tick error').slice(0, 300);
    if (state.currentSweep?.status === 'running') {
      state.currentSweep = { ...state.currentSweep, status: 'failed', failedAt };
    }
    state.lastError = { at: failedAt, scheduledAt: iso(scheduledTime), message, recovery: 'pending' };
    state.nextSweepAt = iso(nextFiveMinuteBoundary(this.now()));
    await this.stateFile.write(state);
    console.error(`TubePulse Home scheduled tick failed: ${message}`);
    if (!this.recoverAuthority) return;
    try {
      const recovery = await this.recoverAuthority(error);
      const recoveredState = await this.stateFile.read();
      recoveredState.lastError = {
        ...recoveredState.lastError,
        recovery: recovery?.reconciled ? 'reconciled' : 'already-current',
        recoveredAt: iso(this.now()),
      };
      await this.stateFile.write(recoveredState);
    } catch (recoveryError) {
      const recoveryState = await this.stateFile.read();
      recoveryState.lastError = {
        ...recoveryState.lastError,
        recovery: 'failed',
        recoveryMessage: String(recoveryError?.message || recoveryError).slice(0, 300),
      };
      await this.stateFile.write(recoveryState);
      console.error(`TubePulse Home authority recovery failed: ${recoveryState.lastError.recoveryMessage}`);
    }
  }

  armNextMinute() {
    if (this.stopped || this.config.mode === 'standby') return;
    const now = this.now();
    const { scheduledTime: next, runAt } = rssNextMinuteSchedule(now, this.remoteConfirmationDueAt);
    this.timer = setTimeout(() => {
      const activeTick = this.runTick(next)
        .catch((error) => this.handleScheduledTickError(error, next))
        .catch((error) => {
          // Error reporting must never become an unhandled timer rejection.
          console.error(`TubePulse Home scheduled error handler failed: ${String(error?.message || error).slice(0, 300)}`);
        });
      this.activeTick = activeTick;
      void activeTick.finally(() => {
        if (this.activeTick === activeTick) this.activeTick = null;
        this.armNextMinute();
      });
    }, Math.max(1, runAt - now));
  }

  async run() {
    this.armNextMinute();
  }

  async status() {
    return await this.stateFile.read();
  }

  async close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let failure = null;
    try {
      if (this.activeTick) await this.activeTick;
      const state = await this.stateFile.read();
      state.stoppedAt = iso(this.now());
      if (state.lease) state.lease.state = 'released';
      await this.stateFile.write(state);
    } catch (error) {
      failure = error;
    }
    // Release the process lease before disposing workerd. Miniflare disposal
    // can be slow during container shutdown, but no timer or tick remains at
    // this point, so retaining the lock only delays a safe restart.
    try { await this.lease.release(); } catch (error) { failure ||= error; }
    try { await this.runtime.close(); } catch (error) { failure ||= error; }
    if (failure) throw failure;
  }
}

export async function createHomeSchedulerRunner(config, dependencies = {}) {
  const runner = new HomeSchedulerRunner({ config, ...dependencies });
  await runner.start();
  return runner;
}
