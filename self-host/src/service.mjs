import crypto from 'node:crypto';
import http from 'node:http';
import { CloudflareKvError, CloudflareKvRestAdapter, LocalKvAdapter, contentHash } from './kv-adapters.mjs';
import { publicConfig } from './config.mjs';
import { createRuntimeStateFile, createSyncStateFile } from './file-state.mjs';
import {
  createReconciliationReceipt,
  GatewayReplayGuard,
  verifyGatewayRequest,
} from './gateway-auth.mjs';
import { TubePulseRuntime } from './runtime.mjs';
import { SchedulerController } from './scheduler.mjs';
import { resolveCanonicalGatewayPullConflict, SyncEngine } from './sync-engine.mjs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const APP_API_METHODS = new Map([
  ['/register', 'POST'],
  ['/subscribe-channel', 'POST'],
  ['/unsubscribe', 'POST'],
  ['/seen', 'POST'],
  ['/feed', 'GET'],
  ['/resolve', 'GET'],
  ['/bootstrap', 'POST'],
  ['/settings', 'POST'],
  ['/channel-override', 'POST'],
]);
const GATEWAY_READ_METHODS = new Map([['/feed', 'GET']]);
const GATEWAY_MUTATION_METHODS = new Map([
  ['/register', 'POST'],
  ['/subscribe-channel', 'POST'],
  ['/unsubscribe', 'POST'],
  ['/seen', 'POST'],
  ['/bootstrap', 'POST'],
  ['/settings', 'POST'],
  ['/channel-override', 'POST'],
]);

function tokenMatches(expected, supplied) {
  const expectedHash = crypto.createHash('sha256').update(expected || '').digest();
  const suppliedHash = crypto.createHash('sha256').update(supplied || '').digest();
  return crypto.timingSafeEqual(expectedHash, suppliedHash) && Boolean(expected);
}

function suppliedBearer(request) {
  const authorization = request.headers.authorization || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

function bearerMatchesFingerprint(value, fingerprint) {
  if (!value || !/^[a-f0-9]{64}$/.test(fingerprint || '')) return false;
  const actual = crypto.createHash('sha256').update(value).digest();
  const expected = Buffer.from(fingerprint, 'hex');
  return crypto.timingSafeEqual(actual, expected);
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : null;
}

async function parseJsonBody(request) {
  const body = await readBody(request);
  if (!body) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 });
  }
}

function forwardHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith('x-tubepulse-gateway-')) continue;
    result[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

export class TubePulseSelfHostService {
  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
    this.runtime = options.runtime || new TubePulseRuntime(config);
    this.scheduler = null;
    this.syncEngine = null;
    this.syncStateFile = null;
    this.localNamespace = null;
    this.server = null;
    this.url = null;
    this.syncTimer = null;
    this.lastAutomaticSyncError = null;
    this.lastAutomaticReconciliation = null;
    this.lastTakeoverEligibilityErrorAt = null;
    this.mirrorMaintenanceOperation = null;
    this.gatewayOperationsInFlight = 0;
    this.gatewayMutationEpoch = 0;
    this.automaticSyncPending = false;
    this.automaticSyncQueued = false;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.gatewayReplayGuard = config.gatewayOrigin?.enabled
      ? new GatewayReplayGuard({ skewMs: config.gatewayOrigin.clockSkewMs })
      : null;
    this.ready = false;
  }

  async start() {
    await this.runtime.start();
    const localNamespace = await this.runtime.getLocalNamespace();
    this.localNamespace = localNamespace;
    this.scheduler = new SchedulerController({
      runtime: this.runtime,
      mode: this.config.mode,
      stateFile: createRuntimeStateFile(this.config.dataDir),
      timers: this.options.timers ?? true,
    });
    await this.scheduler.start();

    this.syncStateFile = createSyncStateFile(this.config.dataDir);
    if (this.config.sync.configured) {
      this.syncEngine = new SyncEngine({
        local: new LocalKvAdapter(localNamespace),
        remote: new CloudflareKvRestAdapter(this.config.sync),
        stateFile: this.syncStateFile,
        concurrency: this.config.sync.concurrency,
        writeEnabled: this.config.sync.writeEnabled,
        resolvePullConflict: this.config.gatewayOrigin?.enabled
          ? resolveCanonicalGatewayPullConflict
          : null,
      });
    }

    this.server = http.createServer((request, response) => {
      this.handleNodeRequest(request, response).catch((error) => {
        sendJson(response, error?.status || 500, { error: error?.status ? error.message : 'Internal self-host service error' });
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, resolve);
    });
    const address = this.server.address();
    const displayHost = this.config.host === '0.0.0.0' || this.config.host === '::' ? '127.0.0.1' : this.config.host;
    this.url = `http://${displayHost}:${address.port}`;
    this.ready = true;

    if (this.config.mode === 'mirror' && this.syncEngine && (this.options.automaticSync ?? true)) {
      const run = () => this.runAutomaticSync();
      setTimeout(run, 0).unref?.();
      this.syncTimer = setInterval(run, this.config.sync.pullIntervalMs);
      this.syncTimer.unref?.();
    }
    return this;
  }

  async runAutomaticSync() {
    if (!this.syncEngine) return null;
    // A periodic tick that lands inside a long-running pull is simply skipped;
    // otherwise a pull that takes at least one interval would create an
    // endless immediate catch-up loop. An app operation is short-lived, so a
    // tick that finds one active is queued and runs as soon as its lease ends.
    if (this.mirrorMaintenanceOperation || this.syncEngine.running) {
      return { deferred: true };
    }
    if (this.gatewayOperationsInFlight > 0) {
      this.automaticSyncPending = true;
      return { deferred: true };
    }

    this.automaticSyncPending = false;
    this.mirrorMaintenanceOperation = 'pull';
    const mutationEpochAtStart = this.gatewayMutationEpoch;
    try {
      const result = await this.syncEngine.pull();
      if (this.config.sync.autoPush) await this.syncEngine.push({ apply: true });
      this.lastAutomaticSyncError = null;
      const syncStatus = await this.syncEngine.status();
      const parityProven = result?.status === 'ok'
        && (result?.conflicts || 0) === 0
        && (result?.pendingLocal || 0) === 0
        && syncStatus.conflictCount === 0
        && (syncStatus.lastPull?.pendingLocal || 0) === 0;
      const overlappedCanonicalMutation = this.gatewayMutationEpoch !== mutationEpochAtStart;

      if (this.config.gatewayOrigin?.enabled && overlappedCanonicalMutation) {
        // The canonical mutation completed before its signed shadow request
        // reached Home, so a pull already in progress may have listed an
        // earlier key set. Never issue a current receipt from that snapshot.
        this.automaticSyncPending = true;
        this.lastAutomaticReconciliation = {
          at: new Date().toISOString(),
          status: 'deferred',
          reason: 'mutation-overlap',
        };
      } else if (this.config.gatewayOrigin?.enabled && !parityProven) {
        this.lastAutomaticReconciliation = {
          at: new Date().toISOString(),
          status: 'blocked',
          reason: 'parity-not-proven',
        };
      } else if (this.config.gatewayOrigin?.enabled && this.config.gatewayOrigin.reconcileUrl) {
        this.mirrorMaintenanceOperation = 'reconcile';
        const reconcileEpoch = this.gatewayMutationEpoch;
        this.lastAutomaticReconciliation = await this.postGatewayReconciliation();
        if (this.gatewayMutationEpoch !== reconcileEpoch) {
          this.automaticSyncPending = true;
          this.lastAutomaticReconciliation = {
            at: new Date().toISOString(),
            status: 'deferred',
            reason: 'mutation-overlap',
          };
        }
      }
      return result;
    } catch (error) {
      this.lastAutomaticSyncError = {
        at: new Date().toISOString(),
        category: 'cloudflare-sync-failed',
        status: Number.isInteger(error?.status) ? error.status : null,
        retryable: Boolean(error?.retryable),
      };
      return null;
    } finally {
      this.mirrorMaintenanceOperation = null;
      if (this.automaticSyncPending && this.gatewayOperationsInFlight === 0) {
        this.queueAutomaticSync();
      }
    }
  }

  queueAutomaticSync() {
    if (this.automaticSyncQueued || !this.ready || !this.syncEngine) return;
    this.automaticSyncQueued = true;
    const handle = setImmediate(() => {
      this.automaticSyncQueued = false;
      if (this.ready) void this.runAutomaticSync();
    });
    handle.unref?.();
  }

  async postGatewayReconciliation() {
    const receipt = createReconciliationReceipt({
      secret: this.config.gatewayOrigin.secret,
      fingerprint: this.config.gatewayOrigin.fingerprint,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.gatewayOrigin.reconcileTimeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(this.config.gatewayOrigin.reconcileUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(receipt),
        signal: controller.signal,
        redirect: 'error',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true || payload?.state !== 'current') {
        return {
          at: new Date().toISOString(),
          status: 'failed',
          reason: response.status === 409 ? 'receipt-superseded' : 'endpoint-rejected',
          httpStatus: response.status,
        };
      }
      return {
        at: new Date().toISOString(),
        status: 'current',
        changed: payload.changed === true,
      };
    } catch (error) {
      return {
        at: new Date().toISOString(),
        status: 'failed',
        reason: error?.name === 'AbortError' ? 'timeout' : 'network',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async status() {
    let syncStatus = { lastPull: null, lastPush: null, conflictCount: 0, pendingCount: 0, stateReadable: true };
    if (this.syncEngine) {
      try {
        syncStatus = { ...(await this.syncEngine.status()), stateReadable: true };
      } catch {
        syncStatus = { lastPull: null, lastPush: null, conflictCount: 0, pendingCount: 0, stateReadable: false };
      }
    }
    return {
      status: this.ready ? 'ready' : 'starting',
      version: 'self-host-preview-0.1.0',
      mode: this.config.mode,
      listener: { host: this.config.host, url: this.url },
      runtime: { engine: 'Miniflare / workerd', persistentKv: true },
      scheduler: this.scheduler?.status() || null,
      sync: {
        configured: Boolean(this.syncEngine),
        running: this.mirrorMaintenanceOperation || this.syncEngine?.running || null,
        automaticPull: this.config.mode === 'mirror' && Boolean(this.syncEngine),
        automaticPush: this.config.sync.autoPush,
        writeEnabled: this.config.sync.writeEnabled,
        lastAutomaticError: this.lastAutomaticSyncError,
        lastAutomaticReconciliation: this.lastAutomaticReconciliation,
        ...syncStatus,
      },
      configuration: publicConfig(this.config),
    };
  }

  async gatewayReadiness(deviceId) {
    if (
      !this.config.gatewayOrigin?.enabled
      || !this.ready
      || this.config.mode !== 'mirror'
      || !this.syncEngine
      || this.scheduler?.status()?.state !== 'standby'
      || this.mirrorMaintenanceOperation
      || this.syncEngine.running
      || this.lastAutomaticSyncError
    ) return { ready: false, profilePresent: false };

    let syncStatus;
    let profilePresent = false;
    try {
      [syncStatus, profilePresent] = await Promise.all([
        this.syncEngine.status(),
        deviceId ? this.localNamespace.get(`device:${deviceId}:profile`, 'text').then(Boolean) : false,
      ]);
    } catch {
      return { ready: false, profilePresent: false };
    }
    const lastPullAt = Date.parse(syncStatus.lastPull?.at || '');
    const current = syncStatus.lastPull?.status === 'ok'
      && Number.isFinite(lastPullAt)
      && Date.now() - lastPullAt <= this.config.gatewayOrigin.readinessMaxAgeMs
      && Date.now() >= lastPullAt - this.config.gatewayOrigin.clockSkewMs
      && syncStatus.conflictCount === 0
      && (syncStatus.lastPull?.pendingLocal || 0) === 0;
    return { ready: current && profilePresent, current, profilePresent };
  }

  authorizeAdmin(request, response) {
    if (!this.config.adminToken) {
      sendJson(response, 503, { error: 'Admin operations are disabled until TUBEPULSE_ADMIN_TOKEN is configured' });
      return false;
    }
    if (!tokenMatches(this.config.adminToken, suppliedBearer(request))) {
      sendJson(response, 401, { error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  sendAdminOperationError(response, error) {
    if (error instanceof CloudflareKvError) {
      sendJson(response, 502, {
        error: 'Cloudflare KV operation failed',
        upstreamStatus: error.status || null,
        retryable: error.retryable,
      });
      return;
    }
    const message = String(error?.message || 'Admin operation failed');
    if (message.includes('already running')) return sendJson(response, 409, { error: 'A synchronization operation is already running' });
    if (message.includes('writes are disabled')) return sendJson(response, 409, { error: message });
    sendJson(response, 500, { error: 'Admin operation failed' });
  }

  async handleAdmin(request, response, pathname) {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }
    if (!this.authorizeAdmin(request, response)) return;

    if (pathname === '/_tubepulse/admin/takeover') {
      sendJson(response, 200, { ok: true, result: await this.scheduler.takeover('admin-http') });
      return;
    }
    if (pathname === '/_tubepulse/admin/standby') {
      sendJson(response, 200, { ok: true, result: await this.scheduler.standby('admin-http') });
      return;
    }
    if (pathname === '/_tubepulse/admin/sync/pull') {
      if (!this.syncEngine) return sendJson(response, 503, { error: 'Cloudflare synchronization is not configured' });
      try {
        sendJson(response, 200, { ok: true, result: await this.syncEngine.pull() });
      } catch (error) {
        this.sendAdminOperationError(response, error);
      }
      return;
    }
    if (pathname === '/_tubepulse/admin/sync/push') {
      if (!this.syncEngine) return sendJson(response, 503, { error: 'Cloudflare synchronization is not configured' });
      const body = await parseJsonBody(request);
      try {
        sendJson(response, 200, { ok: true, result: await this.syncEngine.push({ apply: body.apply === true }) });
      } catch (error) {
        this.sendAdminOperationError(response, error);
      }
      return;
    }
    if (pathname === '/_tubepulse/admin/gateway/reconcile') {
      if (!this.config.gatewayOrigin?.enabled || !this.syncEngine) {
        return sendJson(response, 503, { error: 'Home gateway origin is not configured' });
      }
      try {
        const result = await this.syncEngine.pull();
        const status = await this.syncEngine.status();
        const complete = result?.status === 'ok'
          && (result?.conflicts || 0) === 0
          && (result?.pendingLocal || 0) === 0
          && status.conflictCount === 0
          && (status.lastPull?.pendingLocal || 0) === 0;
        if (!complete) {
          return sendJson(response, 409, {
            error: 'Full canary reconciliation did not converge',
            conflictCount: status.conflictCount,
            pendingCount: status.lastPull?.pendingLocal || 0,
          });
        }
        this.lastAutomaticSyncError = null;
        const receipt = createReconciliationReceipt({
          secret: this.config.gatewayOrigin.secret,
          fingerprint: this.config.gatewayOrigin.fingerprint,
        });
        sendJson(response, 200, { ok: true, result, receipt });
      } catch (error) {
        this.sendAdminOperationError(response, error);
      }
      return;
    }
    sendJson(response, 404, { error: 'Unknown admin operation' });
  }

  async writeWorkerResponse(response, workerResponse) {
    const responseBody = Buffer.from(await workerResponse.arrayBuffer());
    const headers = {};
    for (const [name, value] of workerResponse.headers) {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }
    response.writeHead(workerResponse.status, headers);
    response.end(responseBody);
  }

  async handleGateway(request, response, parsedUrl) {
    if (!this.config.gatewayOrigin?.enabled) return sendJson(response, 404, { error: 'Not found' });
    const isReady = parsedUrl.pathname === '/_tubepulse/gateway/ready';
    const prefix = '/_tubepulse/gateway/app';
    const isApp = parsedUrl.pathname.startsWith(`${prefix}/`);
    if (!isReady && !isApp) return sendJson(response, 404, { error: 'Not found' });

    const body = ['GET', 'HEAD'].includes(request.method) ? Buffer.alloc(0) : (await readBody(request) || Buffer.alloc(0));
    const target = isReady
      ? '/_tubepulse/gateway/ready'
      : `${parsedUrl.pathname.slice(prefix.length)}${parsedUrl.search}`;
    const targetPathname = new URL(target, 'http://gateway.local').pathname;
    const expectedOperation = isReady ? 'ready' : request.method === 'GET' ? 'read' : 'mutation';
    const verified = verifyGatewayRequest({
      secret: this.config.gatewayOrigin.secret,
      headers: request.headers,
      method: request.method,
      target,
      body,
      expectedOperation,
      replayGuard: this.gatewayReplayGuard,
      skewMs: this.config.gatewayOrigin.clockSkewMs,
    });
    if (!verified.ok) {
      console.warn(`[TubePulse home gateway] outcome=authentication-rejected reason=${verified.reason || 'unknown'}`);
      return sendJson(response, 401, { error: 'Invalid gateway authentication' });
    }

    const deviceId = suppliedBearer(request);
    if (!bearerMatchesFingerprint(deviceId, this.config.gatewayOrigin.fingerprint)) {
      return sendJson(response, 403, { error: 'Gateway canary identity rejected' });
    }
    if (isReady && request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' });
    const allowed = isReady
      || GATEWAY_READ_METHODS.get(targetPathname) === request.method
      || GATEWAY_MUTATION_METHODS.get(targetPathname) === request.method;
    if (!allowed) return sendJson(response, 404, { error: 'Gateway route is not allowed' });

    // Acquiring this lease is synchronous. Therefore either the signed app
    // operation wins and the next automatic pull defers, or maintenance wins
    // and this operation fails closed before touching local KV.
    this.gatewayOperationsInFlight++;
    if (expectedOperation === 'mutation') this.gatewayMutationEpoch++;
    try {
      const readiness = await this.gatewayReadiness(deviceId);
      if (isReady) {
        if (!readiness.ready) {
          console.warn('[TubePulse home gateway] outcome=not-ready route=readiness');
          return sendJson(response, 503, { error: 'Home shadow is not ready' });
        }
        return sendJson(response, 200, {
          ok: true,
          ready: true,
          current: true,
          role: 'shadow',
          profilePresent: true,
        });
      }

      if (!readiness.ready) {
        console.warn('[TubePulse home gateway] outcome=not-ready route=app');
        return sendJson(response, 503, { error: 'Home shadow is not ready' });
      }

      const workerUrl = `http://tubepulse.local${target}`;
      const workerResponse = await this.runtime.dispatchFetch(workerUrl, {
        method: request.method,
        headers: forwardHeaders(request.headers),
        ...(body.length ? { body } : {}),
      });
      await this.writeWorkerResponse(response, workerResponse);
    } finally {
      this.gatewayOperationsInFlight--;
      if (this.gatewayOperationsInFlight === 0 && this.automaticSyncPending) {
        this.queueAutomaticSync();
      }
    }
  }

  async forwardToApi(request, response, parsedUrl) {
    const body = ['GET', 'HEAD'].includes(request.method) ? null : await readBody(request);
    const workerUrl = `http://tubepulse.local${parsedUrl.pathname}${parsedUrl.search}`;
    const workerInit = {
      method: request.method,
      headers: forwardHeaders(request.headers),
      ...(body ? { body } : {}),
    };
    const failoverMarker = request.headers['x-tubepulse-failover'];
    const authorization = String(request.headers.authorization || '');
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    // Check before dispatch: /register may create a profile, but a brand-new
    // arbitrary identity must not be able to activate mirror schedulers.
    let baselineBackedDevice = false;
    if (failoverMarker && bearer && APP_API_METHODS.get(parsedUrl.pathname) === request.method) {
      const profileKey = `device:${bearer}:profile`;
      try {
        const [profile, syncState] = await Promise.all([
          this.localNamespace.get(profileKey, 'text'),
          this.syncStateFile.read(),
        ]);
        const baseline = syncState.baseline?.[profileKey];
        baselineBackedDevice = Boolean(profile && baseline?.hash && contentHash(profile) === baseline.hash);
        this.lastTakeoverEligibilityErrorAt = null;
      } catch {
        // A missing baseline is handled by JsonStateFile, while corruption or
        // an unreadable file must fail closed for activation without breaking
        // the app API request itself.
        baselineBackedDevice = false;
        this.lastTakeoverEligibilityErrorAt = new Date().toISOString();
      }
    }
    const workerResponse = await this.runtime.dispatchFetch(workerUrl, workerInit);
    // The marker is a signal, not a secret. Activation additionally requires
    // an app route, a pre-existing mirrored device profile, and a successful
    // API response. The behavior is still disabled unless explicitly opted in.
    if (
      failoverMarker
      && baselineBackedDevice
      && workerResponse.ok
      && this.config.mode === 'mirror'
      && this.config.autoTakeover
      && !this.scheduler.active
    ) {
      await this.scheduler.takeover('successful-client-failover-request');
    }
    const responseBody = Buffer.from(await workerResponse.arrayBuffer());
    const headers = {};
    for (const [name, value] of workerResponse.headers) {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }
    const allowHeaders = headers['access-control-allow-headers'];
    if (allowHeaders && !allowHeaders.toLowerCase().includes('x-tubepulse-failover')) {
      headers['access-control-allow-headers'] = `${allowHeaders}, X-TubePulse-Failover`;
    }
    response.writeHead(workerResponse.status, headers);
    response.end(responseBody);
  }

  async handleNodeRequest(request, response) {
    const parsedUrl = new URL(request.url, 'http://self-host.local');
    if (parsedUrl.pathname === '/_tubepulse/status') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' });
      return sendJson(response, 200, await this.status());
    }
    if (parsedUrl.pathname.startsWith('/_tubepulse/admin/')) {
      return await this.handleAdmin(request, response, parsedUrl.pathname);
    }
    if (parsedUrl.pathname.startsWith('/_tubepulse/gateway/')) {
      return await this.handleGateway(request, response, parsedUrl);
    }
    // A gateway origin is a dedicated mirror surface. Do not leave the
    // ordinary app API reachable beside the authenticated gateway prefix;
    // status and admin routes above remain available to operators.
    if (this.config.gatewayOrigin?.enabled) {
      return sendJson(response, 404, { error: 'Not found' });
    }

    await this.forwardToApi(request, response, parsedUrl);
  }

  async close() {
    this.ready = false;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.scheduler?.stop();
    if (this.server) {
      const closing = new Promise((resolve) => this.server.close(resolve));
      this.server.closeAllConnections?.();
      await closing;
    }
    this.server = null;
    await this.runtime.close();
  }
}

export async function createTubePulseService(config, options) {
  return await new TubePulseSelfHostService(config, options).start();
}
