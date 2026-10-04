import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isCommunityPostsEnabled, parseCommunityPostChannelAllowlist } from '../../worker/tubepulse-posts/community-posts.mjs';
import { isCommunityPostsDebugEnabled, pollSingleCommunityChannel } from '../../worker/tubepulse-posts/index.js';
import { pollSingleRssChannel } from '../../worker/tubepulse-rss-0/index.js';
import { runAuxTick } from '../../worker/tubepulse-aux/index.js';
import { getKV, key, stableJson } from '../../worker/tubepulse-cron/shared.mjs';
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
    if (['views', 'likes', 'dislikes', 'viewsLastCheckedHour', 'likesLastCheckedHour'].includes(name)) continue;
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
        return 'post-observation-metadata-only';
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
      const isSweepBoundary = forceSweep || Math.floor(scheduledTime / MINUTE_MS) % 5 === 0;
      const shouldPrepare = this.config.mode === 'active' || isSweepBoundary;
      const seed = shouldPrepare ? await this.publication.prepare() : null;
      const target = new RecordingKv(this.publication.target(), journal);
      const env = this.createEnvironment(target, notifications, notificationQueue, pendingNotifications);
      const sweep = isSweepBoundary ? await this.runRssSweep(env, target, scheduledTime) : null;
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
    const next = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
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
    }, Math.max(1, next - now));
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
