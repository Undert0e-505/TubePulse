import crypto from 'node:crypto';
import { signAuthorityRequest } from './home-authority.mjs';

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try { return await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' }); }
  finally { clearTimeout(timer); }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AuthorityClientError extends Error {
  constructor(message, { status = null, operation = null, retryable = false, details = null } = {}) {
    super(message);
    this.name = 'AuthorityClientError';
    this.status = status;
    this.operation = operation;
    this.retryable = retryable;
    this.details = details;
  }
}

const ROUTES = Object.freeze({
  status: { method: 'GET', path: '/_tubepulse/authority/status', operation: 'authority-status' },
  acquire: { method: 'POST', path: '/_tubepulse/authority/publication/acquire', operation: 'authority-publication-acquire' },
  commit: { method: 'POST', path: '/_tubepulse/authority/publication/commit', operation: 'authority-publication-commit' },
  release: { method: 'POST', path: '/_tubepulse/authority/publication/release', operation: 'authority-publication-release' },
  snapshot: { method: 'POST', path: '/_tubepulse/authority/reconcile/snapshot', operation: 'authority-reconcile-snapshot' },
  activate: { method: 'POST', path: '/_tubepulse/authority/reconcile/activate', operation: 'authority-reconcile-activate' },
  reconcileRelease: { method: 'POST', path: '/_tubepulse/authority/reconcile/release', operation: 'authority-reconcile-release' },
  stale: { method: 'POST', path: '/_tubepulse/authority/stale', operation: 'authority-stale' },
  migrationBegin: { method: 'POST', path: '/_tubepulse/authority/backend-migration/begin', operation: 'authority-backend-migration-begin' },
  migrationChunk: { method: 'POST', path: '/_tubepulse/authority/backend-migration/chunk', operation: 'authority-backend-migration-chunk' },
  migrationCommit: { method: 'POST', path: '/_tubepulse/authority/backend-migration/commit', operation: 'authority-backend-migration-commit' },
  rssProbe: { method: 'POST', path: '/_tubepulse/authority/rss-probe', operation: 'authority-rss-probe' },
});

export class AuthorityClient {
  constructor({ baseUrl, secret, timeoutMs = 10_000, fetchImpl = globalThis.fetch, sleep = delay }) {
    if (!baseUrl || new URL(baseUrl).protocol !== 'https:') throw new Error('Authority API URL must use HTTPS');
    if (!secret || secret.length < 32) throw new Error('Authority secret must contain at least 32 characters');
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.secret = secret;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.operations = { requests: 0, failures: 0 };
  }

  async request(routeName, payload) {
    const route = ROUTES[routeName];
    if (!route) throw new Error('Unknown authority client operation');
    const body = route.method === 'GET' ? '' : JSON.stringify(payload || {});
    const headers = signAuthorityRequest({
      secret: this.secret,
      operation: route.operation,
      method: route.method,
      target: route.path,
      body,
    });
    if (body) headers['Content-Type'] = 'application/json';
    this.operations.requests++;
    let response;
    try {
      response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}${route.path}`, {
        method: route.method, headers, ...(body ? { body } : {}),
      }, this.timeoutMs);
    } catch (error) {
      this.operations.failures++;
      throw new AuthorityClientError(`Authority ${routeName} network failure`, {
        operation: routeName, retryable: true,
      });
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      this.operations.failures++;
      throw new AuthorityClientError(`Authority ${routeName} rejected`, {
        status: response.status, operation: routeName,
        retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
        details: result,
      });
    }
    return result;
  }

  async status() { return await this.request('status'); }
  async acquirePublication({ ttlMs = 120_000, retryWindowMs = 5_000 } = {}) {
    const leaseId = `home-${crypto.randomUUID()}`;
    const deadline = Date.now() + Math.max(0, retryWindowMs);
    let attempt = 0;
    while (true) {
      try {
        const result = await this.request('acquire', { leaseId, kind: 'publication', ttlMs });
        return { leaseId, result };
      } catch (error) {
        const leaseBusy = error instanceof AuthorityClientError
          && error.status === 409
          && error.details?.error === 'Authority lease busy';
        if (!leaseBusy || Date.now() >= deadline) throw error;
        await this.sleep(Math.min(800, 50 * (2 ** Math.min(attempt++, 4))));
      }
    }
  }
  async commitPublication(leaseId, deltas, { retainLease = false } = {}) {
    return await this.request('commit', { leaseId, deltas, retainLease });
  }
  async releasePublication(leaseId) { return await this.request('release', { leaseId }); }
  async flushAllPending({ ttlMs = 30_000, retryWindowMs = 5_000 } = {}) {
    const leaseId = `recovery-${crypto.randomUUID()}`;
    const deadline = Date.now() + Math.max(0, retryWindowMs);
    let attempt = 0;
    let result;
    while (true) {
      try {
        result = await this.request('acquire', {
          leaseId, kind: 'api', ttlMs, flushAllPending: true,
        });
        break;
      } catch (error) {
        const leaseBusy = error instanceof AuthorityClientError
          && error.status === 409
          && error.details?.error === 'Authority lease busy';
        if (!leaseBusy || Date.now() >= deadline) throw error;
        await this.sleep(Math.min(800, 50 * (2 ** Math.min(attempt++, 4))));
      }
    }
    try {
      return { leaseId, ...result };
    } finally {
      await this.request('release', { leaseId }).catch(() => {});
    }
  }
  async markStale(reason, { clearSeeded = false } = {}) {
    return await this.request('stale', { reason, ...(clearSeeded ? { clearSeeded: true } : {}) });
  }
  async probeRss(activeChannelId = undefined) {
    return await this.request('rssProbe', activeChannelId ? { activeChannelId } : {});
  }
  async snapshotCanonical({ includeValues = false, retryWindowMs = 5_000 } = {}) {
    const leaseId = `reconcile-${crypto.randomUUID()}`;
    const deadline = Date.now() + Math.max(0, retryWindowMs);
    let attempt = 0;
    while (true) {
      try {
        const result = await this.request('snapshot', { leaseId, ...(includeValues ? { includeValues: true } : {}) });
        return { ...result, leaseId };
      } catch (error) {
        const blocked = error instanceof AuthorityClientError
          && error.status === 409
          && ['Authority lease busy', 'Canonical backup queue must drain before reconciliation']
            .includes(error.details?.error);
        if (!blocked || Date.now() >= deadline) throw error;
        await this.sleep(Math.min(800, 50 * (2 ** Math.min(attempt++, 4))));
      }
    }
  }
  async activateCanonical(manifest) {
    return await this.request('activate', {
      leaseId: manifest.leaseId,
      manifestHash: manifest.hash || manifest.manifestHash,
      recordCount: manifest.recordCount,
    });
  }
  async releaseReconciliation(leaseId) { return await this.request('reconcileRelease', { leaseId }); }
  async beginBackendMigration(payload) { return await this.request('migrationBegin', payload); }
  async appendBackendMigration(payload) { return await this.request('migrationChunk', payload); }
  async commitBackendMigration(payload) { return await this.request('migrationCommit', payload); }
}

export const authorityClientRoutes = ROUTES;
