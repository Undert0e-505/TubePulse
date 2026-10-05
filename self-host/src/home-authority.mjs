import crypto from 'node:crypto';
import path from 'node:path';
import { JsonStateFile } from './file-state.mjs';
import { contentHash } from './kv-adapters.mjs';

const AUTHORITY_VERSION = '1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_LEASE_TTL_MS = 120_000;
const AUTHORITY_MUTATION_ROUTES = new Set([
  'POST /register',
  'POST /subscribe-channel',
  'POST /unsubscribe',
  'POST /seen',
  'POST /bootstrap',
  'POST /settings',
  'POST /channel-override',
]);

function freshState() {
  return {
    schemaVersion: 1,
    replication: { status: 'stale', reason: 'not-reconciled', changedAt: new Date().toISOString(), generation: 0 },
    lease: null,
    transaction: null,
    manifest: null,
  };
}

function authorityCanonical({ timestamp, requestId, operation, method, target, authorizationDigest, bodyDigest }) {
  return [
    'tubepulse-authority-v1', String(timestamp), requestId, operation,
    method.toUpperCase(), target, authorizationDigest, bodyDigest,
  ].join('\n');
}

function safeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left || '') || !/^[a-f0-9]{64}$/.test(right || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function requestHeaders(request) {
  const result = {};
  for (const [name, value] of request.headers) result[name.toLowerCase()] = value;
  return result;
}

function validateDelta(delta) {
  if (!delta || typeof delta !== 'object') throw new Error('invalid-delta');
  const key = String(delta.key || '');
  if (!key || Buffer.byteLength(key) > 512) throw new Error('invalid-delta-key');
  if (!['put', 'delete'].includes(delta.operation)) throw new Error('invalid-delta-operation');
  if (delta.baseHash !== null && !/^[a-f0-9]{64}$/.test(String(delta.baseHash || ''))) throw new Error('invalid-delta-base');
  if (delta.operation === 'put') {
    if (typeof delta.value !== 'string' || Buffer.byteLength(delta.value) > 25 * 1024 * 1024) throw new Error('invalid-delta-value');
    if (!/^[a-f0-9]{64}$/.test(String(delta.nextHash || '')) || contentHash(delta.value) !== delta.nextHash) {
      throw new Error('invalid-delta-next');
    }
  } else if (delta.nextHash !== null) throw new Error('invalid-delete-next');
  return { ...delta, key, options: delta.options || {} };
}

class AsyncMutex {
  constructor() { this.tail = Promise.resolve(); }
  async run(operation) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

export class AuthorityReplayGuard {
  constructor({ now = Date.now, skewMs = 60_000 } = {}) {
    this.now = now;
    this.skewMs = skewMs;
    this.seen = new Map();
  }
  accept(id, timestamp) {
    const current = this.now();
    for (const [key, expiry] of this.seen) if (expiry < current) this.seen.delete(key);
    if (this.seen.has(id) || Math.abs(current - timestamp) > this.skewMs) return false;
    this.seen.set(id, current + this.skewMs);
    return true;
  }
}

export function signAuthorityRequest({
  secret, timestamp = Date.now(), requestId = crypto.randomUUID(), operation,
  method = 'POST', target, authorization = '', body = '',
}) {
  const bodyDigest = contentHash(body);
  const authorizationDigest = contentHash(authorization);
  const signature = crypto.createHmac('sha256', secret).update(authorityCanonical({
    timestamp, requestId, operation, method, target, authorizationDigest, bodyDigest,
  })).digest('hex');
  return {
    'X-TubePulse-Authority-Version': AUTHORITY_VERSION,
    'X-TubePulse-Authority-Timestamp': String(timestamp),
    'X-TubePulse-Authority-Request-Id': requestId,
    'X-TubePulse-Authority-Operation': operation,
    'X-TubePulse-Authority-Body-SHA256': bodyDigest,
    'X-TubePulse-Authority-Signature': signature,
  };
}

export function verifyAuthorityRequest({ secret, request, body, expectedOperation, replayGuard }) {
  const headers = requestHeaders(request);
  const timestamp = Number(headers['x-tubepulse-authority-timestamp']);
  const requestId = String(headers['x-tubepulse-authority-request-id'] || '');
  const operation = String(headers['x-tubepulse-authority-operation'] || '');
  const bodyDigest = String(headers['x-tubepulse-authority-body-sha256'] || '').toLowerCase();
  const signature = String(headers['x-tubepulse-authority-signature'] || '').toLowerCase();
  if (headers['x-tubepulse-authority-version'] !== AUTHORITY_VERSION
    || operation !== expectedOperation
    || !/^[a-zA-Z0-9_-]{16,128}$/.test(requestId)
    || !Number.isFinite(timestamp)
    || !safeHexEqual(bodyDigest, contentHash(body))) return { ok: false, reason: 'invalid-metadata' };
  const target = `${new URL(request.url).pathname}${new URL(request.url).search}`;
  const authorizationDigest = contentHash(request.headers.get('Authorization') || '');
  const expected = crypto.createHmac('sha256', secret).update(authorityCanonical({
    timestamp, requestId, operation, method: request.method, target, authorizationDigest, bodyDigest,
  })).digest('hex');
  if (!safeHexEqual(signature, expected)) return { ok: false, reason: 'signature' };
  if (!replayGuard.accept(requestId, timestamp)) return { ok: false, reason: 'expired-or-replay' };
  return { ok: true, requestId };
}

export function createHomeAuthorityStateFile(dataDir) {
  return new JsonStateFile(path.join(dataDir, 'home-authority-state.json'), freshState());
}

export class HomeAuthorityGate {
  constructor({ adapter, stateFile, now = Date.now, leaseTtlMs = DEFAULT_LEASE_TTL_MS }) {
    this.adapter = adapter;
    this.stateFile = stateFile;
    this.now = now;
    this.leaseTtlMs = leaseTtlMs;
    this.mutex = new AsyncMutex();
  }

  async initialize() {
    return await this.mutex.run(async () => {
      const state = await this.stateFile.read();
      if (state.transaction) {
        try { await this.applyTransaction(state); } catch {
          await this.markStaleInState(state, 'local-transaction-recovery-failed');
        }
      }
      if (state.lease && Number(state.lease.expiresAt || 0) <= this.now()) {
        state.lease = null;
        await this.markStaleInState(state, 'local-lease-expired');
      } else {
        await this.stateFile.write(state);
      }
      return this.publicState(state);
    });
  }

  publicState(state) {
    return {
      replication: { ...state.replication },
      lease: state.lease ? { kind: state.lease.kind, phase: state.lease.phase, expiresAt: state.lease.expiresAt } : null,
      transaction: state.transaction ? {
        kind: state.transaction.kind, nextIndex: state.transaction.nextIndex, count: state.transaction.deltas.length,
      } : null,
      manifest: state.manifest ? {
        recordCount: state.manifest.recordCount,
        hash: state.manifest.hash,
        reconciledAt: state.manifest.reconciledAt || null,
      } : null,
    };
  }

  async status() { return this.publicState(await this.stateFile.read()); }

  async markStaleInState(state, reason) {
    if (state.replication.status !== 'stale' || state.replication.reason !== reason) {
      state.replication = {
        status: 'stale', reason, changedAt: new Date(this.now()).toISOString(),
        generation: Number(state.replication.generation || 0) + 1,
      };
    }
    await this.stateFile.write(state);
  }

  async markStale(reason) {
    return await this.mutex.run(async () => {
      const state = await this.stateFile.read();
      await this.markStaleInState(state, String(reason || 'replication-uncertain').slice(0, 80));
      return this.publicState(state);
    });
  }

  async reconcile({ manifestHash, recordCount }) {
    return await this.mutex.run(async () => {
      const state = await this.stateFile.read();
      if (state.lease || state.transaction) throw new Error('Home authority is busy');
      state.manifest = { hash: manifestHash, recordCount, reconciledAt: new Date(this.now()).toISOString() };
      state.replication = {
        status: 'current', reason: 'reconciled', changedAt: new Date(this.now()).toISOString(),
        generation: Number(state.replication.generation || 0) + 1,
      };
      await this.stateFile.write(state);
      return this.publicState(state);
    });
  }

  async acquire({ leaseId, kind, identityHash = null, method = null, route = null }) {
    return await this.mutex.run(async () => {
      const state = await this.stateFile.read();
      if (state.transaction) throw new Error('Home authority recovery is pending');
      if (state.lease && Number(state.lease.expiresAt || 0) <= this.now()) {
        state.lease = null;
        await this.markStaleInState(state, 'local-lease-expired');
      }
      if (state.lease) throw new Error('Home authority lease busy');
      if (state.replication.status !== 'current') throw new Error('Home authority is stale');
      if (!['api', 'scheduler'].includes(kind)) throw new Error('Invalid Home authority lease kind');
      state.lease = {
        leaseId, kind, identityHash, method, route,
        phase: kind === 'scheduler' ? 'polling' : 'replicating',
        acquiredAt: this.now(), expiresAt: this.now() + this.leaseTtlMs,
      };
      await this.stateFile.write(state);
      return this.publicState(state);
    });
  }

  async release(leaseId) {
    return await this.mutex.run(async () => {
      const state = await this.stateFile.read();
      if (!state.lease || state.lease.leaseId !== leaseId) throw new Error('Invalid Home authority lease');
      state.lease = null;
      await this.stateFile.write(state);
      return this.publicState(state);
    });
  }

  async renew(leaseId) {
    return await this.mutex.run(async () => {
      const state = await this.stateFile.read();
      if (!state.lease || state.lease.leaseId !== leaseId) throw new Error('Invalid Home authority lease');
      if (Number(state.lease.expiresAt || 0) <= this.now()) {
        state.lease = null;
        await this.markStaleInState(state, 'local-lease-expired');
        throw new Error('Home authority lease expired');
      }
      state.lease.expiresAt = this.now() + this.leaseTtlMs;
      await this.stateFile.write(state);
      return this.publicState(state);
    });
  }

  async failLease(leaseId, reason) {
    return await this.mutex.run(async () => {
      const state = await this.stateFile.read();
      if (state.lease?.leaseId === leaseId) state.lease = null;
      await this.markStaleInState(state, reason);
      return this.publicState(state);
    });
  }

  async verifyScheduler(leaseId, deltas, { release = false } = {}) {
    return await this.mutex.run(async () => {
      const state = await this.stateFile.read();
      if (!state.lease || state.lease.leaseId !== leaseId || state.lease.kind !== 'scheduler') {
        throw new Error('Invalid Home authority lease');
      }
      for (const delta of deltas.map(validateDelta)) {
        const current = await this.adapter.get(delta.key);
        const currentHash = current === null || current === undefined ? null : contentHash(current);
        if (currentHash !== delta.nextHash) {
          state.lease = null;
          await this.markStaleInState(state, 'local-publication-result-diverged');
          throw new Error('Home publication result diverged');
        }
      }
      state.lease.phase = 'published';
      if (release) state.lease = null;
      await this.stateFile.write(state);
      return this.publicState(state);
    });
  }

  async readReady() {
    const state = await this.stateFile.read();
    const safeLease = !state.lease
      || (state.lease.kind === 'scheduler' && state.lease.phase === 'published');
    return state.replication.status === 'current' && !state.transaction && safeLease;
  }

  async applyTransaction(state) {
    const transaction = state.transaction;
    for (let index = Number(transaction.nextIndex || 0); index < transaction.deltas.length; index++) {
      const delta = transaction.deltas[index];
      if (delta.operation === 'delete') await this.adapter.delete(delta.key);
      else await this.adapter.put(delta.key, delta.value, delta.options || {});
      transaction.nextIndex = index + 1;
      await this.stateFile.write(state);
    }
    state.transaction = null;
    state.lease = null;
    await this.stateFile.write(state);
  }

  async commit({ leaseId, deltas, kind, identityHash = null }) {
    return await this.mutex.run(async () => {
      const state = await this.stateFile.read();
      const lease = state.lease;
      if (!lease || lease.leaseId !== leaseId || lease.kind !== kind
        || (kind === 'api' && lease.identityHash !== identityHash)) throw new Error('Invalid Home authority lease');
      const validated = Array.isArray(deltas) && deltas.length <= 1000 ? deltas.map(validateDelta) : null;
      if (!validated) throw new Error('Invalid Home authority delta batch');
      for (const delta of validated) {
        const current = await this.adapter.get(delta.key);
        const currentHash = current === null || current === undefined ? null : contentHash(current);
        if (currentHash !== delta.baseHash) {
          state.lease = null;
          await this.markStaleInState(state, 'local-baseline-diverged');
          throw new Error('Home authority baseline diverged');
        }
      }
      state.transaction = { id: leaseId, kind, deltas: validated, nextIndex: 0, createdAt: this.now() };
      await this.stateFile.write(state);
      try {
        await this.applyTransaction(state);
      } catch (error) {
        await this.markStaleInState(state, 'local-transaction-failed');
        throw error;
      }
      return { ok: true, applied: validated.length };
    });
  }
}

export class HomeAuthorityIngress {
  constructor({ secret, gate, replayGuard = new AuthorityReplayGuard(), feedHandler = null, mutationHandler = null }) {
    if (!secret || secret.length < 32) throw new Error('Home authority secret must contain at least 32 characters');
    this.secret = secret;
    this.gate = gate;
    this.replayGuard = replayGuard;
    this.feedHandler = feedHandler;
    this.mutationHandler = mutationHandler;
  }

  async handle(request) {
    const url = new URL(request.url);
    if (url.pathname === '/_tubepulse/authority/feed') {
      if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405 });
      const verified = verifyAuthorityRequest({
        secret: this.secret, request, body: '', expectedOperation: 'authority-feed', replayGuard: this.replayGuard,
      });
      if (!verified.ok) return Response.json({ error: 'Invalid authority authentication' }, { status: 401 });
      const authorization = request.headers.get('Authorization') || '';
      if (!authorization.startsWith('Bearer ') || !authorization.slice(7).trim()) {
        return Response.json({ error: 'Authenticated device identity required' }, { status: 401 });
      }
      if (!(await this.gate.readReady())) return Response.json({ error: 'Home authority is not readable' }, { status: 503 });
      if (!this.feedHandler) return Response.json({ error: 'Home feed is unavailable' }, { status: 503 });
      return await this.feedHandler(request);
    }
    const routes = new Map([
      ['/_tubepulse/authority/mutation', 'authority-mutation'],
      ['/_tubepulse/authority/preflight', 'authority-preflight'],
      ['/_tubepulse/authority/cancel', 'authority-cancel'],
      ['/_tubepulse/authority/commit', 'authority-commit'],
    ]);
    const operation = routes.get(url.pathname);
    if (!operation) return Response.json({ error: 'Not found' }, { status: 404 });
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
    const body = await request.text();
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return Response.json({ error: 'Request too large' }, { status: 413 });
    const verified = verifyAuthorityRequest({
      secret: this.secret, request, body, expectedOperation: operation, replayGuard: this.replayGuard,
    });
    if (!verified.ok) return Response.json({ error: 'Invalid authority authentication' }, { status: 401 });
    const authorization = request.headers.get('Authorization') || '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!bearer) return Response.json({ error: 'Authenticated device identity required' }, { status: 401 });
    let payload;
    try { payload = body ? JSON.parse(body) : {}; } catch { return Response.json({ error: 'Invalid request' }, { status: 400 }); }
    const leaseId = String(payload.leaseId || '');
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(leaseId)) return Response.json({ error: 'Invalid request' }, { status: 400 });
    const identityHash = contentHash(bearer);
    try {
      if (operation === 'authority-mutation') {
        const method = String(payload.method || '').toUpperCase();
        let target;
        try { target = new URL(String(payload.path || ''), 'http://authority.local'); } catch {
          return Response.json({ error: 'Invalid request' }, { status: 400 });
        }
        if (!AUTHORITY_MUTATION_ROUTES.has(`${method} ${target.pathname}`)) {
          return Response.json({ error: 'Route is not allowed' }, { status: 404 });
        }
        if (typeof payload.body !== 'string' || Buffer.byteLength(payload.body) > MAX_BODY_BYTES) {
          return Response.json({ error: 'Invalid request' }, { status: 400 });
        }
        if (!this.mutationHandler) return Response.json({ error: 'Home mutation handler is unavailable' }, { status: 503 });
        await this.gate.acquire({ leaseId, kind: 'api', identityHash, method, route: target.pathname });
        let result;
        try {
          result = await this.mutationHandler({
            method,
            path: `${target.pathname}${target.search}`,
            body: payload.body,
            headers: payload.headers && typeof payload.headers === 'object' ? payload.headers : {},
            authorization,
          });
          if (!result?.response || !Array.isArray(result.deltas)) throw new Error('Invalid Home mutation result');
          if (Number(result.response.status) >= 400) {
            await this.gate.release(leaseId);
            return Response.json({ ok: true, response: result.response, deltas: [] });
          }
          await this.gate.commit({ leaseId, deltas: result.deltas, kind: 'api', identityHash });
          return Response.json({ ok: true, response: result.response, deltas: result.deltas });
        } catch (error) {
          await this.gate.release(leaseId).catch(() => {});
          const message = String(error?.message || 'Home mutation failed');
          if (/stale|busy|lease|diverged|recovery/i.test(message)) throw error;
          return Response.json({ error: 'Home mutation failed' }, { status: 500 });
        }
      }
      if (operation === 'authority-preflight') {
        const method = String(payload.method || '').toUpperCase();
        const route = new URL(String(payload.path || ''), 'http://authority.local').pathname;
        if (!AUTHORITY_MUTATION_ROUTES.has(`${method} ${route}`)) return Response.json({ error: 'Route is not allowed' }, { status: 404 });
        await this.gate.acquire({ leaseId, kind: 'api', identityHash, method, route });
        return Response.json({ ok: true });
      }
      if (operation === 'authority-cancel') {
        await this.gate.release(leaseId);
        return Response.json({ ok: true });
      }
      const result = await this.gate.commit({ leaseId, deltas: payload.deltas, kind: 'api', identityHash });
      return Response.json(result);
    } catch (error) {
      const message = String(error?.message || 'Home authority rejected the request');
      const status = /stale|busy|lease|diverged|recovery/i.test(message) ? 409 : 400;
      return Response.json({ error: message }, { status });
    }
  }
}

export async function authorityManifest(adapter, { exclude = () => false, concurrency = 8 } = {}) {
  const listed = (await adapter.listKeys()).filter(({ name }) => !exclude(name)).sort((a, b) => a.name.localeCompare(b.name));
  const records = new Array(listed.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, listed.length) }, async () => {
    while (next < listed.length) {
      const index = next++;
      const { name } = listed[index];
      const value = await adapter.get(name);
      records[index] = { key: name, hash: value === null ? null : contentHash(value) };
    }
  }));
  return {
    hash: contentHash(records.map(({ key, hash }) => `${key}\0${hash || ''}\n`).join('')),
    recordCount: records.length,
  };
}

export async function exportAuthoritySnapshot(adapter, { exclude = () => false, concurrency = 8 } = {}) {
  const listed = (await adapter.listKeys()).filter(({ name }) => !exclude(name)).sort((a, b) => a.name.localeCompare(b.name));
  const records = new Array(listed.length);
  let next = 0;
  let totalBytes = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, listed.length) }, async () => {
    while (next < listed.length) {
      const index = next++;
      const { name, expiration } = listed[index];
      const value = await adapter.get(name);
      if (value === null) continue;
      const record = {
        key: name,
        value,
        hash: contentHash(value),
        ...(Number.isFinite(expiration) ? { expiration } : {}),
      };
      records[index] = record;
      totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 128;
      if (Buffer.byteLength(value) > 1_900_000) throw new Error('Canonical snapshot contains a D1-incompatible value');
      if (totalBytes > 10 * 1024 * 1024) throw new Error('Canonical snapshot is too large');
    }
  }));
  const present = records.filter(Boolean);
  return {
    records: present,
    manifestHash: contentHash(present.map(({ key, hash }) => `${key}\0${hash}\n`).join('')),
    recordCount: present.length,
    totalBytes,
  };
}

export async function installAuthoritySnapshot(adapter, snapshot) {
  const records = Array.isArray(snapshot?.records) ? snapshot.records : null;
  if (!records || records.length !== Number(snapshot?.recordCount)) {
    throw new Error('Canonical snapshot record count is invalid');
  }
  const expected = new Map();
  let totalBytes = 0;
  for (const record of records) {
    const key = String(record?.key || '');
    const value = record?.value;
    if (!key || Buffer.byteLength(key) > 512 || !isAuthorityCanonicalKey(key) || expected.has(key)) {
      throw new Error('Canonical snapshot contains an invalid key');
    }
    if (typeof value !== 'string' || contentHash(value) !== record.hash) {
      throw new Error('Canonical snapshot record hash is invalid');
    }
    if (record.expiration !== undefined
      && (!Number.isFinite(record.expiration) || record.expiration <= 0)) {
      throw new Error('Canonical snapshot record expiration is invalid');
    }
    totalBytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 128;
    if (totalBytes > 10 * 1024 * 1024) throw new Error('Canonical snapshot is too large');
    expected.set(key, record);
  }
  const manifest = {
    hash: contentHash([...expected.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(({ key, hash }) => `${key}\0${hash}\n`).join('')),
    recordCount: expected.size,
  };
  if (manifest.hash !== String(snapshot?.manifestHash || '')) {
    throw new Error('Canonical snapshot manifest hash is invalid');
  }

  const localKeys = (await adapter.listKeys())
    .map(({ name }) => name)
    .filter(isAuthorityCanonicalKey);
  const summary = { imported: 0, updated: 0, deleted: 0, unchanged: 0 };
  for (const key of localKeys) {
    if (!expected.has(key)) {
      await adapter.delete(key);
      summary.deleted++;
    }
  }
  for (const record of [...expected.values()].sort((left, right) => left.key.localeCompare(right.key))) {
    const current = await adapter.get(record.key);
    if (current === record.value) {
      summary.unchanged++;
      continue;
    }
    await adapter.put(record.key, record.value, {
      ...(Number.isFinite(record.expiration) ? { expiration: record.expiration } : {}),
    });
    if (current === null || current === undefined) summary.imported++;
    else summary.updated++;
  }
  return { ...summary, ...manifest };
}

export function isAuthorityCanonicalKey(key) {
  return key !== 'fcm:cache:token'
    && !String(key).startsWith('gateway:canary:')
    && !String(key).startsWith('handle:');
}

export const homeAuthorityTestHelpers = Object.freeze({
  AUTHORITY_MUTATION_ROUTES,
  authorityCanonical,
  freshState,
  validateDelta,
});
