const AUTHORITY_VERSION = '1';
const STATE_KEY = 'authority:state';
const LEASE_KEY = 'authority:lease';
const TX_KEY = 'authority:transaction';
const BASELINE_PREFIX = 'authority:baseline:';
const TX_DELTA_PREFIX = 'authority:transaction:delta:';
const PENDING_PREFIX = 'authority:pending:';
const QUOTA_KEY = 'authority:quota';
const MAX_DELTA_COUNT = 1000;
const MAX_DELTA_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_EXPORT_BYTES = 10 * 1024 * 1024;
const RECONCILIATION_LEASE_TTL_MS = 5 * 60 * 1000;

function isAuthorityCanonicalKey(key) {
  // OAuth access tokens are installation-local caches, not application
  // state. Gateway experiment markers are likewise outside the unified
  // authority. Everything used by app mutations or scheduled logic remains
  // in the canonical manifest.
  return key !== 'fcm:cache:token'
    && !String(key).startsWith('gateway:canary:')
    // Handle resolution is an opportunistic API cache, not scheduler or
    // device state. GET /resolve may refresh it outside the authority write
    // protocol, so deliberately exclude it from the reconciled baseline.
    && !String(key).startsWith('handle:');
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function bytes(value = '') {
  return new TextEncoder().encode(String(value));
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function authoritySha256(value) {
  return hex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? bytes(value) : value));
}

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function valueForType(value, type) {
  if (value === null || value === undefined) return null;
  const normalized = typeof type === 'object' ? type?.type : type;
  if (normalized === 'json') {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (normalized === 'arrayBuffer') return bytes(value).buffer;
  return value;
}

function validateDelta(delta) {
  if (!delta || typeof delta !== 'object') throw new Error('invalid-delta');
  const key = String(delta.key || '');
  if (!key || bytes(key).byteLength > 512) throw new Error('invalid-delta-key');
  if (!['put', 'delete'].includes(delta.operation)) throw new Error('invalid-delta-operation');
  if (delta.baseHash !== null && !/^[a-f0-9]{64}$/.test(String(delta.baseHash || ''))) {
    throw new Error('invalid-delta-base');
  }
  if (delta.operation === 'put') {
    if (typeof delta.value !== 'string' || bytes(delta.value).byteLength > 25 * 1024 * 1024) {
      throw new Error('invalid-delta-value');
    }
    if (!/^[a-f0-9]{64}$/.test(String(delta.nextHash || ''))) throw new Error('invalid-delta-next');
  } else if (delta.nextHash !== null) {
    throw new Error('invalid-delete-next');
  }
  const options = delta.options || {};
  if (options.expiration !== undefined && (!Number.isFinite(options.expiration) || options.expiration <= 0)) {
    throw new Error('invalid-delta-expiration');
  }
  if (options.expirationTtl !== undefined && (!Number.isFinite(options.expirationTtl) || options.expirationTtl < 60)) {
    throw new Error('invalid-delta-expiration-ttl');
  }
  return { ...delta, key, options };
}

export class BufferedKvNamespace {
  constructor(base) {
    this.base = base;
    this.original = new Map();
    this.overlay = new Map();
  }

  async loadOriginal(key) {
    if (!this.original.has(key)) this.original.set(key, await this.base.get(key, 'text'));
    return this.original.get(key);
  }

  async get(key, type = 'text') {
    const name = String(key);
    if (this.overlay.has(name)) {
      const entry = this.overlay.get(name);
      return valueForType(entry.operation === 'delete' ? null : entry.value, type);
    }
    return valueForType(await this.loadOriginal(name), type);
  }

  async put(key, value, options = {}) {
    const name = String(key);
    await this.loadOriginal(name);
    if (typeof value !== 'string') throw new Error('TubePulse authority accepts string KV values only');
    this.overlay.set(name, { operation: 'put', value, options: { ...options } });
  }

  async delete(key) {
    const name = String(key);
    await this.loadOriginal(name);
    this.overlay.set(name, { operation: 'delete', options: {} });
  }

  async list(options) {
    return await this.base.list(options);
  }

  async deltas() {
    const result = [];
    for (const [key, entry] of [...this.overlay.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const previous = this.original.get(key);
      if (entry.operation === 'put' && previous === entry.value) continue;
      if (entry.operation === 'delete' && (previous === null || previous === undefined)) continue;
      result.push({
        key,
        operation: entry.operation,
        baseHash: previous === null || previous === undefined ? null : await authoritySha256(previous),
        nextHash: entry.operation === 'put' ? await authoritySha256(entry.value) : null,
        ...(entry.operation === 'put' ? { value: entry.value, options: entry.options } : {}),
      });
    }
    return result;
  }

  stats() {
    return { keyReads: this.original.size };
  }
}

function baselineStorageKey(keyHash) {
  return `${BASELINE_PREFIX}${keyHash}`;
}

function deltaStorageKey(index) {
  return `${TX_DELTA_PREFIX}${String(index).padStart(4, '0')}`;
}

async function pendingStorageKey(key) {
  return `${PENDING_PREFIX}${await authoritySha256(key)}`;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

export class TubePulseAuthorityCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async readJson(request) {
    const raw = await request.text();
    if (bytes(raw).byteLength > MAX_DELTA_BODY_BYTES) throw new Error('body-too-large');
    return raw ? JSON.parse(raw) : {};
  }

  async replicationState() {
    return await this.state.storage.get(STATE_KEY) || {
      schemaVersion: 1,
      status: 'stale',
      reason: 'not-reconciled',
      changedAt: new Date().toISOString(),
      generation: 0,
      canonicalVersion: 0,
      seeded: false,
    };
  }

  quotaLimits() {
    const total = boundedInteger(this.env.TUBEPULSE_AUTHORITY_KV_WRITE_HARD_CAP, 950, 100, 999);
    const publication = boundedInteger(
      this.env.TUBEPULSE_AUTHORITY_KV_PUBLICATION_CAP,
      650,
      0,
      total,
    );
    return { total, publication, apiReserve: total - publication };
  }

  async quotaState() {
    const day = new Date().toISOString().slice(0, 10);
    const stored = await this.state.storage.get(QUOTA_KEY);
    if (stored?.day === day) return stored;
    const fresh = { day, kvWrites: 0, publicationWrites: 0, apiWrites: 0, kvReads: 0, kvLists: 0, doRequests: 0 };
    await this.state.storage.put(QUOTA_KEY, fresh);
    return fresh;
  }

  async updateQuota(changes) {
    const state = await this.quotaState();
    for (const [key, amount] of Object.entries(changes)) {
      state[key] = Number(state[key] || 0) + Number(amount || 0);
    }
    await this.state.storage.put(QUOTA_KEY, state);
    return state;
  }

  async reserveWrites(kind, count) {
    const quota = await this.quotaState();
    const limits = this.quotaLimits();
    const writes = Math.max(0, Number(count || 0));
    if (kind === 'publication' && quota.publicationWrites + writes > limits.publication) {
      return { ok: false, quota, limits, reason: 'publication-cap' };
    }
    if (quota.kvWrites + writes > limits.total) {
      return { ok: false, quota, limits, reason: 'hard-cap' };
    }
    quota.kvWrites += writes;
    if (kind === 'publication') quota.publicationWrites += writes;
    else quota.apiWrites += writes;
    await this.state.storage.put(QUOTA_KEY, quota);
    return { ok: true, quota, limits };
  }

  async setReplicationState(status, reason, extra = {}) {
    const current = await this.replicationState();
    if (current.status === status && current.reason === reason && !Object.keys(extra).length) return current;
    const next = {
      ...current,
      ...extra,
      schemaVersion: 1,
      status,
      reason,
      changedAt: new Date().toISOString(),
      generation: Number(current.generation || 0) + 1,
    };
    await this.state.storage.put(STATE_KEY, next);
    return next;
  }

  async currentLease() {
    const lease = await this.state.storage.get(LEASE_KEY);
    if (lease && Number(lease.expiresAt || 0) <= Date.now()) {
      await this.state.storage.delete(LEASE_KEY);
      return null;
    }
    return lease || null;
  }

  async acquire(payload) {
    const leaseId = String(payload.leaseId || '');
    const kind = String(payload.kind || '');
    const ttlMs = Math.max(5_000, Math.min(120_000, Number(payload.ttlMs || 30_000)));
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(leaseId) || !['api', 'publication', 'reconcile'].includes(kind)) {
      return json({ error: 'Invalid authority lease request' }, 400);
    }
    const existingLease = await this.currentLease();
    if (existingLease) {
      if (kind !== 'api' || existingLease.kind !== 'reconcile') {
        return json({ error: 'Authority lease busy' }, 409);
      }
      // An app mutation must remain canonical even if it arrives while Home
      // is installing a leased snapshot. Invalidate that snapshot before the
      // mutation is admitted; Home's later /activate then fails closed and a
      // fresh snapshot must include the mutation. The snapshot itself runs in
      // a DO concurrency barrier, so its KV read/baseline phase cannot overlap
      // this transition.
      await this.state.storage.delete(LEASE_KEY);
      await this.setReplicationState('stale', 'reconciliation-overlapped');
    }
    // A previous publication may have committed only a prefix of its batch.
    // Finish that exact journal before admitting another writer. A failed
    // recovery leaves the authority stale and unavailable; it must never be
    // skipped in favour of a newer mutation.
    if (await this.state.storage.get(TX_KEY)) {
      try { await this.recoverTransaction(); } catch {
        return json({ error: 'Authority recovery failed', state: 'stale' }, 503);
      }
    }
    const replication = await this.replicationState();
    if (kind === 'publication' && (replication.status !== 'current' || replication.seeded !== true)) {
      return json({ error: 'Home authority is stale', state: replication.status }, 409);
    }
    // If a local-first publication was deferred to preserve the daily backup
    // budget, make any keys this API mutation may read current in canonical
    // KV before the legacy handler executes. This consumes the reserved app
    // headroom and prevents a stale-CF /seen (or subscribe) delta from
    // overwriting newer Home state.
    if (kind === 'api') {
      const neededKeys = payload.flushAllPending === true
        ? (await this.allPending()).map(({ delta }) => delta.key)
        : Array.isArray(payload.neededKeys)
        ? [...new Set(payload.neededKeys.map(String))].filter((key) => key && bytes(key).byteLength <= 512).slice(0, 250)
        : [];
      const flushed = await this.flushPending(neededKeys, 'api');
      if (!flushed.ok) {
        return json({ error: 'Canonical mutation prerequisite is deferred', reason: flushed.reason }, 503);
      }
    }
    const pending = await this.state.storage.list({ prefix: PENDING_PREFIX });
    const lease = { leaseId, kind, acquiredAt: Date.now(), expiresAt: Date.now() + ttlMs };
    await this.state.storage.put(LEASE_KEY, lease);
    return json({
      ok: true,
      lease: { kind, expiresAt: lease.expiresAt },
      replication: replication.status,
      pendingBackupKeys: pending.size,
    });
  }

  async release(payload) {
    const lease = await this.currentLease();
    if (!lease || lease.leaseId !== String(payload.leaseId || '')) return json({ error: 'Invalid authority lease' }, 409);
    await this.state.storage.delete(LEASE_KEY);
    return json({ ok: true });
  }

  async markStale(payload) {
    const reason = String(payload.reason || 'replication-uncertain').slice(0, 80);
    const state = await this.setReplicationState('stale', reason, {
      ...(payload.clearSeeded === true ? { seeded: false, manifestHash: null, recordCount: 0 } : {}),
    });
    return json({ ok: true, state: state.status, changedAt: state.changedAt });
  }

  async baselineHash(key) {
    const keyHash = await authoritySha256(key);
    const entry = await this.state.storage.get(baselineStorageKey(keyHash));
    if (entry && entry.key !== key) throw new Error('baseline-key-collision');
    return entry?.hash ?? null;
  }

  async storeBaseline(key, hash) {
    const keyHash = await authoritySha256(key);
    const storageKey = baselineStorageKey(keyHash);
    if (hash === null) await this.state.storage.delete(storageKey);
    else await this.state.storage.put(storageKey, { key, hash });
  }

  async applyDelta(delta) {
    if (delta.operation === 'delete') await this.env.TUBEPULSE_KV.delete(delta.key);
    else await this.env.TUBEPULSE_KV.put(delta.key, delta.value, delta.options || {});
    await this.storeBaseline(delta.key, delta.nextHash);
  }

  async clearTransaction(transaction) {
    const keys = Array.from({ length: transaction.count }, (_, index) => deltaStorageKey(index));
    if (keys.length) await this.state.storage.delete(keys);
    if (transaction.pendingStorageKeys?.length) {
      await this.state.storage.delete(transaction.pendingStorageKeys);
    }
    await this.state.storage.delete(TX_KEY);
  }

  async pendingEntry(key) {
    const storageKey = await pendingStorageKey(key);
    const entry = await this.state.storage.get(storageKey);
    if (entry && entry.key !== key) throw new Error('pending-key-collision');
    return entry ? { storageKey, delta: entry.delta } : { storageKey, delta: null };
  }

  async allPending() {
    const stored = await this.state.storage.list({ prefix: PENDING_PREFIX });
    return [...stored.entries()].map(([storageKey, entry]) => ({ storageKey, delta: entry.delta }))
      .sort((left, right) => left.delta.key.localeCompare(right.delta.key));
  }

  mergePending(previous, incoming) {
    if (!previous) return incoming;
    if (previous.nextHash !== incoming.baseHash) throw new Error('pending-baseline-diverged');
    return { ...incoming, baseHash: previous.baseHash };
  }

  async storePending(entries) {
    for (const { storageKey, delta } of entries) {
      if (delta.nextHash === delta.baseHash) await this.state.storage.delete(storageKey);
      else await this.state.storage.put(storageKey, { key: delta.key, delta });
    }
  }

  async flushPending(keys, quotaKind = 'api') {
    const selected = [];
    for (const key of keys) {
      const entry = await this.pendingEntry(key);
      if (entry.delta) selected.push(entry);
    }
    if (!selected.length) return { ok: true, applied: 0 };
    for (const { delta } of selected) {
      if (await this.baselineHash(delta.key) !== delta.baseHash) {
        await this.setReplicationState('stale', 'canonical-backup-baseline-diverged');
        return { ok: false, reason: 'baseline-diverged' };
      }
    }
    const reserved = await this.reserveWrites(quotaKind, selected.length);
    if (!reserved.ok) return { ok: false, reason: reserved.reason };
    const transaction = {
      id: `pending-${crypto.randomUUID()}`,
      kind: quotaKind,
      count: selected.length,
      nextIndex: 0,
      createdAt: Date.now(),
      retainLease: false,
      quotaReserved: true,
      quotaDay: reserved.quota.day,
      pendingStorageKeys: selected.map(({ storageKey }) => storageKey),
    };
    await this.state.storage.put(TX_KEY, transaction);
    for (let index = 0; index < selected.length; index++) {
      await this.state.storage.put(deltaStorageKey(index), selected[index].delta);
    }
    try {
      await this.applyStoredTransaction(transaction);
      return { ok: true, applied: selected.length };
    } catch {
      await this.setReplicationState('stale', 'canonical-backup-recovery-failed');
      return { ok: false, reason: 'publication-failed' };
    }
  }

  async applyStoredTransaction(transaction) {
    if (!transaction.quotaReserved) {
      const reserved = await this.reserveWrites(transaction.kind, transaction.count);
      if (!reserved.ok) throw new Error(`quota-${reserved.reason}`);
      transaction.quotaReserved = true;
      transaction.quotaDay = reserved.quota.day;
      await this.state.storage.put(TX_KEY, transaction);
    }
    for (let index = transaction.nextIndex || 0; index < transaction.count; index++) {
      const delta = await this.state.storage.get(deltaStorageKey(index));
      if (!delta) throw new Error('transaction-delta-missing');
      await this.applyDelta(delta);
      transaction.nextIndex = index + 1;
      await this.state.storage.put(TX_KEY, transaction);
    }
    await this.clearTransaction(transaction);
    const replication = await this.replicationState();
    replication.canonicalVersion = Number(replication.canonicalVersion || 0) + 1;
    await this.state.storage.put(STATE_KEY, replication);
    if (!transaction.retainLease) await this.state.storage.delete(LEASE_KEY);
    return transaction;
  }

  async recoverTransaction() {
    const transaction = await this.state.storage.get(TX_KEY);
    if (!transaction) return null;
    try {
      await this.applyStoredTransaction(transaction);
      return { recovered: true, transactionId: transaction.id, count: transaction.count };
    } catch {
      await this.setReplicationState('stale', 'publication-recovery-failed');
      throw new Error('transaction-recovery-failed');
    }
  }

  async commit(payload) {
    const lease = await this.currentLease();
    const leaseId = String(payload.leaseId || '');
    if (!lease || lease.leaseId !== leaseId || !['api', 'publication'].includes(lease.kind)) {
      return json({ error: 'Invalid authority lease' }, 409);
    }
    const deltas = Array.isArray(payload.deltas) ? payload.deltas.map(validateDelta) : null;
    if (!deltas || deltas.length > MAX_DELTA_COUNT) return json({ error: 'Invalid authority delta batch' }, 400);
    const replication = await this.replicationState();
    if (replication.seeded !== true) return json({ error: 'Authority baseline is not seeded' }, 409);
    if (lease.kind === 'publication' && replication.status !== 'current') {
      return json({ error: 'Home authority is stale' }, 409);
    }
    if (await this.state.storage.get(TX_KEY)) return json({ error: 'Authority recovery is pending' }, 409);
    const observedReads = Math.max(0, Math.min(10_000, Number(payload.observedKvReads || 0)));
    if (Number.isFinite(observedReads) && observedReads > 0) await this.updateQuota({ kvReads: observedReads });

    let appliedDeltas = deltas;
    let pendingStorageKeys = [];
    if (lease.kind === 'publication') {
      const before = await this.allPending();
      const pending = new Map(before.map((entry) => [entry.delta.key, entry]));
      try {
        for (const delta of deltas) {
          const existing = pending.get(delta.key);
          const expected = existing?.delta.nextHash ?? await this.baselineHash(delta.key);
          if (expected !== delta.baseHash) throw new Error('pending-baseline-diverged');
          const storageKey = existing?.storageKey ?? await pendingStorageKey(delta.key);
          const merged = this.mergePending(existing?.delta || null, delta);
          if (merged.nextHash === merged.baseHash) pending.delete(delta.key);
          else pending.set(delta.key, { storageKey, delta: merged });
        }
      } catch {
        await this.setReplicationState('stale', 'canonical-baseline-diverged');
        await this.state.storage.delete(LEASE_KEY);
        return json({ error: 'Canonical baseline diverged', state: 'stale' }, 409);
      }
      appliedDeltas = [...pending.values()].map(({ delta }) => delta)
        .sort((left, right) => left.key.localeCompare(right.key));
      if (appliedDeltas.length > MAX_DELTA_COUNT) {
        await this.state.storage.delete(LEASE_KEY);
        return json({ error: 'Deferred publication queue is full' }, 507);
      }
      for (const delta of appliedDeltas) {
        if (await this.baselineHash(delta.key) !== delta.baseHash) {
          await this.setReplicationState('stale', 'canonical-backup-baseline-diverged');
          await this.state.storage.delete(LEASE_KEY);
          return json({ error: 'Canonical backup baseline diverged', state: 'stale' }, 409);
        }
      }

      const quota = await this.quotaState();
      const limits = this.quotaLimits();
      const overPublication = quota.publicationWrites + appliedDeltas.length > limits.publication;
      const overTotal = quota.kvWrites + appliedDeltas.length > limits.total;
      if (overPublication || overTotal) {
        const retained = new Set([...pending.values()].map(({ storageKey }) => storageKey));
        const removed = before.map(({ storageKey }) => storageKey).filter((key) => !retained.has(key));
        if (removed.length) await this.state.storage.delete(removed);
        await this.storePending([...pending.values()]);
        await this.state.storage.delete(LEASE_KEY);
        return json({
          ok: true,
          deferred: true,
          reason: overPublication ? 'publication-cap' : 'hard-cap',
          queued: appliedDeltas.length,
          quota: {
            day: quota.day,
            kvWrites: quota.kvWrites,
            publicationWrites: quota.publicationWrites,
            apiWrites: quota.apiWrites,
            limits,
          },
        });
      }
      pendingStorageKeys = [...new Set([
        ...before.map(({ storageKey }) => storageKey),
        ...[...pending.values()].map(({ storageKey }) => storageKey),
      ])];
    } else {
      for (const delta of deltas) {
        const pending = await this.pendingEntry(delta.key);
        if (pending.delta || await this.baselineHash(delta.key) !== delta.baseHash) {
          await this.state.storage.delete(LEASE_KEY);
          return json({ error: 'Canonical mutation baseline diverged' }, 409);
        }
      }
      const quota = await this.quotaState();
      const limits = this.quotaLimits();
      if (quota.kvWrites + deltas.length > limits.total) {
        await this.state.storage.delete(LEASE_KEY);
        return json({ error: 'Cloudflare KV app-write reserve exhausted', reason: 'hard-cap' }, 429);
      }
    }

    const transaction = {
      id: leaseId,
      kind: lease.kind,
      count: appliedDeltas.length,
      nextIndex: 0,
      createdAt: Date.now(),
      retainLease: lease.kind === 'publication' && payload.retainLease === true,
      quotaReserved: false,
      pendingStorageKeys,
    };
    await this.state.storage.put(TX_KEY, transaction);
    for (let index = 0; index < appliedDeltas.length; index++) {
      await this.state.storage.put(deltaStorageKey(index), appliedDeltas[index]);
    }
    try {
      await this.applyStoredTransaction(transaction);
      return json({
        ok: true,
        applied: appliedDeltas.length,
        incoming: deltas.length,
        deferred: false,
        transactionId: transaction.id,
      });
    } catch {
      await this.setReplicationState('stale', 'canonical-publication-failed');
      return json({ error: 'Canonical publication failed', state: 'stale' }, 503);
    }
  }

  async snapshotLocked(payload) {
    if (await this.currentLease()) return json({ error: 'Authority lease busy' }, 409);
    if (await this.state.storage.get(TX_KEY)) {
      try { await this.recoverTransaction(); } catch { return json({ error: 'Authority recovery failed' }, 503); }
    }
    if ((await this.state.storage.list({ prefix: PENDING_PREFIX })).size) {
      return json({ error: 'Canonical backup queue must drain before reconciliation' }, 409);
    }
    const leaseId = String(payload.leaseId || '');
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(leaseId)) return json({ error: 'Invalid reconciliation lease' }, 400);
    const lease = {
      leaseId,
      kind: 'reconcile',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + RECONCILIATION_LEASE_TTL_MS,
    };
    await this.state.storage.put(LEASE_KEY, lease);
    try {
      const old = await this.state.storage.list({ prefix: BASELINE_PREFIX });
      if (old.size) await this.state.storage.delete([...old.keys()]);
      const keys = [];
      let cursor;
      do {
        const page = await this.env.TUBEPULSE_KV.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
        keys.push(...page.keys
          .filter(({ name }) => isAuthorityCanonicalKey(name))
          .map(({ name, expiration }) => ({ key: name, expiration })));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      keys.sort((left, right) => left.key.localeCompare(right.key));
      const fetched = await mapLimit(keys, 16, async ({ key, expiration }) => {
        const value = await this.env.TUBEPULSE_KV.get(key, 'text');
        return value === null ? null : {
          key,
          value,
          hash: await authoritySha256(value),
          ...(Number.isFinite(expiration) ? { expiration } : {}),
        };
      });
      const records = fetched.filter(Boolean);
      await this.updateQuota({ kvReads: keys.length, kvLists: Math.max(1, Math.ceil(keys.length / 1000)) });
      const exportBytes = records.reduce(
        (total, record) => total + bytes(record.key).byteLength + bytes(record.value).byteLength + 128,
        0,
      );
      if (exportBytes > MAX_SNAPSHOT_EXPORT_BYTES) throw new Error('snapshot-export-too-large');
      for (const record of records) await this.storeBaseline(record.key, record.hash);
      const manifestHash = await authoritySha256(records.map(({ key, hash }) => `${key}\0${hash || ''}\n`).join(''));
      await this.setReplicationState('stale', 'reconciliation-awaiting-home', {
        seeded: true,
        manifestHash,
        recordCount: records.length,
      });
      // Hold the reconcile lease until Home presents this exact manifest to
      // /activate. This makes the one-time REST seed atomic with respect to
      // coordinated app mutations.
      return json({
        ok: true,
        leaseId,
        manifestHash,
        recordCount: records.length,
        ...(payload.includeValues === true ? {
          records: records.map(({ key, value, hash, expiration }) => ({
            key, value, hash, ...(Number.isFinite(expiration) ? { expiration } : {}),
          })),
        } : {}),
      });
    } catch {
      await this.setReplicationState('stale', 'canonical-snapshot-failed');
      const current = await this.currentLease();
      if (current?.leaseId === leaseId) await this.state.storage.delete(LEASE_KEY);
      return json({ error: 'Canonical snapshot failed' }, 503);
    }
  }

  async snapshot(payload) {
    // Durable Objects may interleave requests across awaited storage/KV calls.
    // Keep the one-time canonical read and baseline install indivisible; app
    // mutations arriving afterwards invalidate the held reconcile lease in
    // acquire(), so Home can never activate a mixed snapshot.
    if (typeof this.state.blockConcurrencyWhile === 'function') {
      return await this.state.blockConcurrencyWhile(() => this.snapshotLocked(payload));
    }
    return await this.snapshotLocked(payload);
  }

  async activate(payload) {
    const lease = await this.currentLease();
    if (!lease || lease.kind !== 'reconcile' || lease.leaseId !== String(payload.leaseId || '')) {
      return json({ error: 'Invalid reconciliation lease' }, 409);
    }
    const current = await this.replicationState();
    if (current.seeded !== true
      || current.manifestHash !== String(payload.manifestHash || '')
      || current.recordCount !== Number(payload.recordCount)) {
      return json({ error: 'Home manifest does not match canonical snapshot' }, 409);
    }
    const next = await this.setReplicationState('current', 'reconciled');
    await this.state.storage.delete(LEASE_KEY);
    return json({ ok: true, state: next.status, generation: next.generation });
  }

  async status() {
    const replication = await this.replicationState();
    const lease = await this.currentLease();
    const transaction = await this.state.storage.get(TX_KEY);
    const quota = await this.quotaState();
    const pending = await this.state.storage.list({ prefix: PENDING_PREFIX });
    const reset = new Date(`${quota.day}T00:00:00.000Z`);
    reset.setUTCDate(reset.getUTCDate() + 1);
    return json({
      ok: true,
      replication: {
        status: replication.status,
        reason: replication.reason,
        changedAt: replication.changedAt,
        generation: replication.generation,
        canonicalVersion: Number(replication.canonicalVersion || 0),
        seeded: replication.seeded === true,
        recordCount: replication.recordCount || 0,
      },
      lease: lease ? { kind: lease.kind, expiresAt: lease.expiresAt } : null,
      transaction: transaction ? { kind: transaction.kind, nextIndex: transaction.nextIndex, count: transaction.count } : null,
      pendingBackupKeys: pending.size,
      quota: { ...quota, limits: this.quotaLimits(), resetsAt: reset.toISOString() },
    });
  }

  async fetch(request) {
    try {
      await this.updateQuota({ doRequests: 1 });
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/status') return await this.status();
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const payload = await this.readJson(request);
      if (url.pathname === '/acquire') return await this.acquire(payload);
      if (url.pathname === '/release') return await this.release(payload);
      if (url.pathname === '/stale') return await this.markStale(payload);
      if (url.pathname === '/commit') return await this.commit(payload);
      if (url.pathname === '/snapshot') return await this.snapshot(payload);
      if (url.pathname === '/activate') return await this.activate(payload);
      if (url.pathname === '/recover') {
        const result = await this.recoverTransaction();
        return json({ ok: true, result });
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      const status = error?.message === 'body-too-large' ? 413 : 400;
      return json({ error: status === 413 ? 'Request too large' : 'Invalid authority request' }, status);
    }
  }
}

export function authorityFeatureEnabled(env) {
  return enabled(env?.TUBEPULSE_HOME_AUTHORITY_ENABLED);
}

export function authorityTrafficEnabled(env) {
  return enabled(env?.TUBEPULSE_HOME_AUTHORITY_TRAFFIC_ENABLED);
}

const AUTHORITY_MUTATIONS = new Set([
  'POST /register',
  'POST /subscribe-channel',
  'POST /unsubscribe',
  'POST /seen',
  'POST /bootstrap',
  'POST /settings',
  'POST /channel-override',
]);

const INTERNAL_AUTHORITY_ROUTES = new Map([
  ['GET /_tubepulse/authority/status', { operation: 'authority-status', coordinatorPath: '/status' }],
  ['POST /_tubepulse/authority/publication/acquire', { operation: 'authority-publication-acquire', coordinatorPath: '/acquire' }],
  ['POST /_tubepulse/authority/publication/commit', { operation: 'authority-publication-commit', coordinatorPath: '/commit' }],
  ['POST /_tubepulse/authority/publication/release', { operation: 'authority-publication-release', coordinatorPath: '/release' }],
  ['POST /_tubepulse/authority/reconcile/snapshot', { operation: 'authority-reconcile-snapshot', coordinatorPath: '/snapshot' }],
  ['POST /_tubepulse/authority/reconcile/activate', { operation: 'authority-reconcile-activate', coordinatorPath: '/activate' }],
  ['POST /_tubepulse/authority/reconcile/release', { operation: 'authority-reconcile-release', coordinatorPath: '/release' }],
  ['POST /_tubepulse/authority/stale', { operation: 'authority-stale', coordinatorPath: '/stale' }],
]);

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

async function authorityHmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    bytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, bytes(value)));
}

function authorityCanonical({ timestamp, requestId, operation, method, target, authorizationDigest, bodyDigest }) {
  return [
    'tubepulse-authority-v1',
    String(timestamp),
    requestId,
    operation,
    method.toUpperCase(),
    target,
    authorizationDigest,
    bodyDigest,
  ].join('\n');
}

function constantTimeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left || '') || !/^[a-f0-9]{64}$/.test(right || '')) return false;
  let difference = 0;
  for (let index = 0; index < 64; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function safeForwardHeaders(source) {
  const headers = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'content-length' || HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower.startsWith('x-tubepulse-authority-')) continue;
    headers.append(name, value);
  }
  return headers;
}

function readAuthorityConfig(env) {
  if (!authorityFeatureEnabled(env)) return { enabled: false };
  const trafficEnabled = authorityTrafficEnabled(env);
  const secret = String(env.TUBEPULSE_HOME_AUTHORITY_SECRET || '');
  const transport = String(env.TUBEPULSE_HOME_AUTHORITY_TRANSPORT || 'vpc').trim().toLowerCase();
  let origin;
  try { origin = new URL(String(env.TUBEPULSE_HOME_AUTHORITY_ORIGIN || '')); } catch {
    return { enabled: true, trafficEnabled, valid: false };
  }
  const vpc = transport === 'vpc' && typeof env.TUBEPULSE_HOME_VPC?.fetch === 'function';
  const https = transport === 'https' && origin.protocol === 'https:';
  if ((!vpc && !https) || secret.length < 32 || typeof env.TUBEPULSE_AUTHORITY_COORDINATOR?.get !== 'function') {
    return { enabled: true, trafficEnabled, valid: false };
  }
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    return { enabled: true, trafficEnabled, valid: false };
  }
  const requestedTimeout = Number(env.TUBEPULSE_HOME_AUTHORITY_TIMEOUT_MS || 5000);
  return {
    enabled: true,
    trafficEnabled,
    valid: true,
    secret,
    transport,
    origin: origin.origin,
    timeoutMs: Number.isFinite(requestedTimeout) ? Math.max(500, Math.min(15_000, requestedTimeout)) : 5000,
  };
}

function coordinatorStub(env) {
  const namespace = env.TUBEPULSE_AUTHORITY_COORDINATOR;
  const id = namespace.idFromName('tubepulse-production-authority');
  return namespace.get(id);
}

async function coordinatorRequest(env, pathname, body, method = 'POST') {
  const response = await coordinatorStub(env).fetch(`https://authority.internal${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.clone().json().catch(() => null) };
}

async function signedHeaders(config, { requestId, operation, method, target, authorization = '', body = '' }) {
  const timestamp = Date.now();
  const bodyDigest = await authoritySha256(body);
  const authorizationDigest = await authoritySha256(authorization);
  const signature = await authorityHmacHex(config.secret, authorityCanonical({
    timestamp, requestId, operation, method, target, authorizationDigest, bodyDigest,
  }));
  return {
    'X-TubePulse-Authority-Version': AUTHORITY_VERSION,
    'X-TubePulse-Authority-Timestamp': String(timestamp),
    'X-TubePulse-Authority-Request-Id': requestId,
    'X-TubePulse-Authority-Operation': operation,
    'X-TubePulse-Authority-Body-SHA256': bodyDigest,
    'X-TubePulse-Authority-Signature': signature,
  };
}

async function homeAuthorityRequest(config, env, {
  pathname, operation, body, authorization = '', method = 'POST',
}) {
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const requestId = crypto.randomUUID();
  const headers = new Headers(await signedHeaders(config, {
    requestId,
    operation,
    method,
    target: pathname,
    authorization,
    body: bodyText,
  }));
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (authorization) headers.set('Authorization', authorization);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const resource = `${config.origin}${pathname}`;
    const init = { method, headers, ...(body !== undefined ? { body: bodyText } : {}), signal: controller.signal };
    const response = config.transport === 'vpc'
      ? await env.TUBEPULSE_HOME_VPC.fetch(new Request(resource, init))
      : await fetch(resource, { ...init, redirect: 'error' });
    return { response, payload: await response.clone().json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

function authorityHeaderMap(headers) {
  const result = {};
  for (const [name, value] of headers) result[name.toLowerCase()] = value;
  return result;
}

async function verifyAuthorityRequest(config, request, bodyText, expectedOperation, replay) {
  const headers = authorityHeaderMap(request.headers);
  const timestamp = Number(headers['x-tubepulse-authority-timestamp']);
  const requestId = String(headers['x-tubepulse-authority-request-id'] || '');
  const operation = String(headers['x-tubepulse-authority-operation'] || '');
  const bodyDigest = String(headers['x-tubepulse-authority-body-sha256'] || '').toLowerCase();
  const signature = String(headers['x-tubepulse-authority-signature'] || '').toLowerCase();
  if (headers['x-tubepulse-authority-version'] !== AUTHORITY_VERSION
    || operation !== expectedOperation
    || !/^[a-zA-Z0-9_-]{16,128}$/.test(requestId)
    || !Number.isFinite(timestamp)
    || Math.abs(Date.now() - timestamp) > 60_000
    || !/^[a-f0-9]{64}$/.test(bodyDigest)
    || !/^[a-f0-9]{64}$/.test(signature)
    || replay.has(requestId)) return false;
  const actualBodyDigest = await authoritySha256(bodyText);
  if (!constantTimeHexEqual(bodyDigest, actualBodyDigest)) return false;
  const authorizationDigest = await authoritySha256(request.headers.get('Authorization') || '');
  const target = `${new URL(request.url).pathname}${new URL(request.url).search}`;
  const expected = await authorityHmacHex(config.secret, authorityCanonical({
    timestamp,
    requestId,
    operation,
    method: request.method,
    target,
    authorizationDigest,
    bodyDigest,
  }));
  if (!constantTimeHexEqual(signature, expected)) return false;
  replay.set(requestId, Date.now() + 60_000);
  for (const [id, expiresAt] of replay) if (expiresAt < Date.now()) replay.delete(id);
  return true;
}

class CapturingExecutionContext {
  constructor(base) { this.base = base; this.promises = []; }
  waitUntil(promise) { this.promises.push(Promise.resolve(promise)); }
  passThroughOnException() { this.base?.passThroughOnException?.(); }
  async flush() {
    const results = await Promise.allSettled(this.promises);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(
      failures.map((result) => result.reason),
      'One or more canonical mutation continuations failed',
    );
  }
}

async function acquireCoordinatorLease(env, leaseId, kind, timeoutMs, options = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await coordinatorRequest(env, '/acquire', {
      leaseId,
      kind,
      ttlMs: Math.max(30_000, timeoutMs * 3),
      ...options,
    });
    if (result.response.ok) return result;
    if (result.response.status !== 409) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return { response: new Response(null, { status: 409 }), payload: { error: 'Authority lease busy' } };
}

function mutationPrerequisites(route, deviceId, body) {
  const channelId = typeof body?.channelId === 'string' ? body.channelId : null;
  const device = (suffix) => `device:${deviceId}:${suffix}`;
  const channel = (suffix) => channelId ? `channel:${channelId}:${suffix}` : null;
  const commonDevice = [device('profile'), device('channels'), device('settings')];
  if (route === 'POST /register') return { flushAllPending: true, neededKeys: [] };
  if (route === 'POST /settings') return { neededKeys: [device('settings')] };
  if (route === 'POST /channel-override') {
    return { neededKeys: channelId ? [device(`override:${channelId}`)] : [] };
  }
  if (route === 'POST /seen') {
    return { neededKeys: channelId ? [device(`state:${channelId}`)] : [] };
  }
  if (['POST /subscribe-channel', 'POST /unsubscribe', 'POST /bootstrap'].includes(route)) {
    return {
      neededKeys: [
        ...commonDevice,
        channel('meta'), channel('recent'), channel('recent:posts'),
        channel('known:videos'), channel('known:posts'), channel('firstPollAt:posts'),
        channel('subscribers'), channel('websub'),
        channelId ? device(`state:${channelId}`) : null,
        channelId ? device(`override:${channelId}`) : null,
        'channels:active',
      ].filter(Boolean),
    };
  }
  return { neededKeys: [] };
}

async function coordinatorReadVersion(env) {
  try {
    const result = await coordinatorRequest(env, '/status', undefined, 'GET');
    if (!result.response.ok || result.payload?.transaction) return null;
    const version = Number(result.payload?.replication?.canonicalVersion);
    return Number.isSafeInteger(version) && version >= 0 ? version : null;
  } catch { return null; }
}

function withAuthorityRoute(response, route) {
  const headers = new Headers(response.headers);
  headers.set('X-TubePulse-Authority-Route', route);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function canonicalFeedWithVersionRetry(appWorker, request, env, ctx, timeoutMs, initialStatus = undefined) {
  const deadline = Date.now() + timeoutMs;
  let beforeResult = initialStatus;
  do {
    if (beforeResult === undefined) {
      try { beforeResult = await coordinatorRequest(env, '/status', undefined, 'GET'); }
      catch {
        // Coordinator outage also prevents every coordinated writer, so the
        // existing canonical KV snapshot cannot be changing through this
        // authority. Preserve read availability while mutations fail closed.
        return withAuthorityRoute(await appWorker.fetch(request, env, ctx), 'cloudflare');
      }
    }
    const before = !beforeResult.response.ok || beforeResult.payload?.transaction
      ? null
      : Number(beforeResult.payload?.replication?.canonicalVersion);
    if (!Number.isSafeInteger(before) || before < 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      beforeResult = undefined;
      continue;
    }
    const candidate = await appWorker.fetch(request, env, ctx);
    const after = await coordinatorReadVersion(env);
    if (after !== null && before === after) return withAuthorityRoute(candidate, 'cloudflare');
    beforeResult = undefined;
  } while (Date.now() < deadline);
  return json({ error: 'Canonical feed is temporarily unavailable' }, 503);
}

export function createAuthorityWorker(appWorker, options = {}) {
  const replay = new Map();
  const logger = options.logger || console;
  return {
    async fetch(request, env, ctx) {
      const config = readAuthorityConfig(env);
      if (!config.enabled) return await appWorker.fetch(request, env, ctx);
      const url = new URL(request.url);
      const route = `${request.method.toUpperCase()} ${url.pathname}`;
      if (!config.valid) {
        logger.warn?.('[TubePulse authority] invalid enabled configuration');
        if (INTERNAL_AUTHORITY_ROUTES.has(route)
          || (config.trafficEnabled && AUTHORITY_MUTATIONS.has(route))) {
          return json({ error: 'Home authority configuration is invalid' }, 503);
        }
        return await appWorker.fetch(request, env, ctx);
      }

      const internal = INTERNAL_AUTHORITY_ROUTES.get(route);
      if (internal) {
        const bodyText = request.method === 'GET' ? '' : await request.text();
        if (!(await verifyAuthorityRequest(config, request, bodyText, internal.operation, replay))) {
          return json({ error: 'Invalid authority authentication' }, 401);
        }
        let body;
        try { body = bodyText ? JSON.parse(bodyText) : undefined; } catch { return json({ error: 'Invalid authority request' }, 400); }
        const result = await coordinatorRequest(env, internal.coordinatorPath, body, request.method);
        return new Response(result.response.body, {
          status: result.response.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }

      // Configuration and traffic activation are separate, so production can
      // deploy the DO/private ingress, seed Home, and prove exact parity while
      // every app request remains on the pre-authority path. Only the explicit
      // traffic latch changes application behaviour.
      if (!config.trafficEnabled) return await appWorker.fetch(request, env, ctx);

      // Existing WebSub leases can continue to deliver briefly after the
      // local scheduler takes ownership. Acknowledge pushes without applying
      // writes or sending duplicate notifications. Verification handshakes
      // are answered by the legacy handler with persistence disabled.
      if (route === 'POST /websub') return new Response('OK', { status: 200 });
      if (route === 'GET /websub') {
        return await appWorker.fetch(request, { ...env, TUBEPULSE_DISABLE_WEBSUB: 'true' }, ctx);
      }

      if (route === 'GET /feed') {
        let status;
        try { status = await coordinatorRequest(env, '/status', undefined, 'GET'); } catch {
          return await canonicalFeedWithVersionRetry(appWorker, request, env, ctx, config.timeoutMs);
        }
        const homeCurrent = status.response.ok
          && !status.payload?.transaction
          && status.payload?.replication?.status === 'current';
        if (homeCurrent) {
          try {
            const home = await homeAuthorityRequest(config, env, {
              pathname: '/_tubepulse/authority/feed',
              operation: 'authority-feed',
              method: 'GET',
              authorization: request.headers.get('Authorization') || '',
            });
            if (home.response.ok && Array.isArray(home.payload?.channels)) {
              return withAuthorityRoute(home.response, 'home');
            }
            if ([400, 401, 403, 404].includes(home.response.status) && home.payload?.error) {
              return withAuthorityRoute(home.response, 'home');
            }
          } catch { /* bounded canonical fallback below */ }
        }
        return await canonicalFeedWithVersionRetry(appWorker, request, env, ctx, config.timeoutMs, status);
      }

      if (!AUTHORITY_MUTATIONS.has(route)) return await appWorker.fetch(request, env, ctx);
      const authorization = request.headers.get('Authorization') || '';
      if (!authorization.startsWith('Bearer ') || authorization.slice(7).trim() === '') {
        return await appWorker.fetch(request, env, ctx);
      }
      let bodyBuffer;
      try { bodyBuffer = await request.clone().arrayBuffer(); } catch { return json({ error: 'Invalid request body' }, 400); }
      if (bodyBuffer.byteLength > MAX_DELTA_BODY_BYTES) return json({ error: 'Request too large' }, 413);
      let parsedBody = null;
      try { parsedBody = JSON.parse(new TextDecoder().decode(bodyBuffer)); } catch { /* handler returns canonical 400 */ }
      const deviceId = authorization.slice(7).trim();
      const prerequisites = mutationPrerequisites(route, deviceId, parsedBody);

      const leaseId = crypto.randomUUID();
      let acquired;
      try {
        acquired = await acquireCoordinatorLease(env, leaseId, 'api', config.timeoutMs, prerequisites);
      } catch {
        // The DO is the only global ordering primitive. Continuing a write
        // while it is unreachable could let Home publish over an unseen app
        // mutation after the DO recovers, so this narrow failure is fail-closed.
        return json({ error: 'Canonical mutation coordinator unavailable' }, 503);
      }
      if (!acquired.response.ok) return json({ error: 'Canonical mutation coordinator unavailable' }, 503);

      const preflightBody = { leaseId, method: request.method, path: `${url.pathname}${url.search}` };
      let homeLease = false;
      try {
        const preflight = await homeAuthorityRequest(config, env, {
          pathname: '/_tubepulse/authority/preflight',
          operation: 'authority-preflight',
          body: preflightBody,
          authorization,
        });
        homeLease = preflight.response.ok && preflight.payload?.ok === true;
      } catch { /* canonical mutation still proceeds */ }
      if (!homeLease) {
        try {
          const stale = await coordinatorRequest(env, '/stale', { reason: 'home-preflight-unavailable' });
          if (!stale.response.ok || stale.payload?.state !== 'stale') throw new Error('stale-marker-rejected');
        } catch {
          // Without a durable stale transition, Home could resume publication
          // over this unseen mutation after a transient coordinator failure.
          await coordinatorRequest(env, '/release', { leaseId }).catch(() => {});
          return json({ error: 'Canonical mutation coordinator unavailable' }, 503);
        }
      }

      const bufferedKv = new BufferedKvNamespace(env.TUBEPULSE_KV);
      const capturedCtx = new CapturingExecutionContext(ctx);
      let response;
      try {
        response = await appWorker.fetch(request, {
          ...env,
          TUBEPULSE_KV: bufferedKv,
          TUBEPULSE_DISABLE_WEBSUB: 'true',
        }, capturedCtx);
        await capturedCtx.flush();
      } catch {
        await coordinatorRequest(env, '/release', { leaseId });
        if (homeLease) {
          await homeAuthorityRequest(config, env, {
            pathname: '/_tubepulse/authority/cancel', operation: 'authority-cancel', body: { leaseId }, authorization,
          }).catch(() => {});
        }
        return json({ error: 'Internal server error' }, 500);
      }

      // A semantic error is authoritative, but buffered side effects are not.
      // In particular, never turn an app-visible 4xx/5xx into a hidden KV
      // mutation merely because a handler wrote before constructing its error.
      if (response.status >= 400) {
        await coordinatorRequest(env, '/release', { leaseId }).catch(() => {});
        if (homeLease) {
          await homeAuthorityRequest(config, env, {
            pathname: '/_tubepulse/authority/cancel', operation: 'authority-cancel', body: { leaseId }, authorization,
          }).catch(() => {});
        }
        return response;
      }

      const deltas = await bufferedKv.deltas();
      const committed = deltas.length
        ? await coordinatorRequest(env, '/commit', {
          leaseId,
          deltas,
          observedKvReads: bufferedKv.stats().keyReads,
        })
        : await coordinatorRequest(env, '/release', { leaseId });
      if (!committed.response.ok) {
        if (homeLease) {
          await homeAuthorityRequest(config, env, {
            pathname: '/_tubepulse/authority/cancel', operation: 'authority-cancel', body: { leaseId }, authorization,
          }).catch(() => {});
        }
        return json({ error: 'Canonical mutation could not be persisted' }, 503);
      }

      if (homeLease) {
        try {
          const replicated = await homeAuthorityRequest(config, env, {
            pathname: '/_tubepulse/authority/commit',
            operation: 'authority-commit',
            body: { leaseId, deltas },
            authorization,
          });
          if (!replicated.response.ok || replicated.payload?.ok !== true) {
            await coordinatorRequest(env, '/stale', { reason: 'home-commit-rejected' });
          }
        } catch {
          await coordinatorRequest(env, '/stale', { reason: 'home-commit-unavailable' });
        }
      }
      return response;
    },
  };
}

export const authorityTestHelpers = {
  MAX_DELTA_BODY_BYTES,
  MAX_SNAPSHOT_EXPORT_BYTES,
  STATE_KEY,
  authorityCanonical,
  readAuthorityConfig,
  authorityTrafficEnabled,
  validateDelta,
  isAuthorityCanonicalKey,
};
