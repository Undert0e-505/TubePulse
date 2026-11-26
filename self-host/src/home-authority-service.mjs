import http from 'node:http';
import crypto from 'node:crypto';
import { appWorker, touchExistingDeviceActivity } from '../../worker/tubepulse-api/index.js';
import { BufferedKvNamespace } from '../../worker/tubepulse-api/authority.mjs';
import { AuthorityClient } from './authority-client.mjs';
import {
  createHomeAuthorityStateFile,
  HomeAuthorityGate,
  HomeAuthorityIngress,
} from './home-authority.mjs';
import {
  ensureHomeAuthorityCurrent,
  verifyAndRecoverHomeAuthority,
} from './home-authority-reconcile.mjs';
import {
  createHomeSchedulerSyncStateFile,
  FileLease,
  HomeSchedulerRunner,
  publicHomeSchedulerState,
} from './home-scheduler.mjs';
import { LocalKvAdapter } from './kv-adapters.mjs';
import { TubePulseRuntime } from './runtime.mjs';
import { collectAggregateMonitoring } from './aggregate-monitoring.mjs';
import { classifyPublicServiceStatus } from './public-service-status.mjs';
import {
  readStartupRecoveryStatus,
  supersedeFailedStartupRecovery,
} from './startup-recovery-status.mjs';
import {
  createLocalKvIntegrityStateFile,
  publicLocalKvIntegrity,
} from './local-kv-integrity.mjs';
import { DurableKvMirror } from './kv-durable-mirror.mjs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

function bearerToken(request) {
  const header = String(request.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function tokenMatches(expected, supplied) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(supplied || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

class CapturingExecutionContext {
  constructor() { this.promises = []; }
  waitUntil(promise) { this.promises.push(Promise.resolve(promise)); }
  passThroughOnException() {}
  async flush() {
    const results = await Promise.allSettled(this.promises);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(
      failures.map((result) => result.reason),
      'One or more Home mutation continuations failed',
    );
  }
}

function responseHeaders(response) {
  const headers = {};
  for (const [name, value] of response.headers) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
}

function sendResponse(response, workerResponse) {
  return workerResponse.arrayBuffer().then((buffer) => {
    const headers = Object.fromEntries(workerResponse.headers);
    response.writeHead(workerResponse.status, headers);
    response.end(Buffer.from(buffer));
  });
}

async function nodeRequestToRequest(request, origin) {
  const chunks = [];
  let length = 0;
  if (!['GET', 'HEAD'].includes(request.method)) {
    for await (const chunk of request) {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) throw Object.assign(new Error('Request too large'), { status: 413 });
      chunks.push(chunk);
    }
  }
  return new Request(new URL(request.url, origin), {
    method: request.method,
    headers: request.headers,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
  });
}

export class UnifiedHomeAuthorityService {
  constructor(config, options = {}) {
    if (!['standby', 'active'].includes(config.mode)) {
      throw new Error('Unified Home authority service supports only standby or active mode');
    }
    if (!config.authority?.enabled || !config.authority.secret) {
      throw new Error('Unified Home authority service requires signed authority configuration');
    }
    this.config = config;
    this.host = options.host || config.authority.host || '0.0.0.0';
    this.port = options.port ?? config.authority.port ?? 8788;
    this.runtime = options.runtime || new TubePulseRuntime({
      dataDir: config.dataDir, repoRoot: config.repoRoot,
      workerBindings: config.workerBindings, quiet: config.quiet,
    });
    this.runner = options.runner || null;
    this.lease = options.lease || null;
    this.gate = options.gate || null;
    this.client = options.client || null;
    this.server = null;
    this.ready = false;
    this.feedHealth = {
      requests: 0,
      failures5xx: 0,
      consecutiveFailures: 0,
      lastStatus: null,
      lastSuccessAt: null,
      lastFailureAt: null,
    };
  }

  recordFeedResponse(status) {
    const observedAt = new Date().toISOString();
    this.feedHealth.requests++;
    this.feedHealth.lastStatus = Number(status);
    if (Number(status) >= 500) {
      this.feedHealth.failures5xx++;
      this.feedHealth.consecutiveFailures++;
      this.feedHealth.lastFailureAt = observedAt;
    } else if (Number(status) >= 200 && Number(status) < 400) {
      this.feedHealth.consecutiveFailures = 0;
      this.feedHealth.lastSuccessAt = observedAt;
    }
  }

  async publicIntegrity() {
    return publicLocalKvIntegrity(await this.integrityStateFile.read());
  }

  async liveStartupRecovery(authority, scheduler, remoteStatus = undefined) {
    let startupRecovery = await readStartupRecoveryStatus(this.config.dataDir);
    let remote = remoteStatus;
    if (startupRecovery.status === 'failed') {
      if (remote === undefined) remote = await this.client.status().catch(() => null);
      startupRecovery = await supersedeFailedStartupRecovery(this.config.dataDir, {
        authority,
        scheduler,
        remoteStatus: remote,
      });
    }
    return { startupRecovery, remoteStatus: remote };
  }

  async start() {
    let runnerStarted = false;
    let startupRecovery = null;
    try {
      // The unified service owns the process lease before starting workerd or
      // reconciling. HomeSchedulerRunner reuses this same lease instance.
      if (!this.runner) {
        this.lease ||= new FileLease({ dataDir: this.config.dataDir, ttlMs: this.config.leaseTtlMs });
        await this.lease.acquire();
      }
      await this.runtime.start();
      const namespace = await this.runtime.getLocalNamespace();
      this.durableMirror ||= new DurableKvMirror(this.config.dataDir);
      const local = new LocalKvAdapter(namespace, { durableMirror: this.durableMirror });
      this.localAdapter = local;
      this.gate ||= new HomeAuthorityGate({
        adapter: local,
        stateFile: createHomeAuthorityStateFile(this.config.dataDir),
        leaseTtlMs: this.config.leaseTtlMs,
      });
      await this.gate.initialize();
      this.client ||= new AuthorityClient({
        baseUrl: this.config.authority.apiUrl,
        secret: this.config.authority.secret,
        timeoutMs: this.config.authority.timeoutMs,
      });
      const syncStateFile = createHomeSchedulerSyncStateFile(this.config.dataDir);
      this.integrityStateFile ||= createLocalKvIntegrityStateFile(this.config.dataDir);
      const ensureCurrent = async () => await ensureHomeAuthorityCurrent({
        local,
        client: this.client,
        gate: this.gate,
        syncStateFile,
      });
      if (this.config.mode === 'active' && !this.runner) {
        const gateAtProcessStart = await this.gate.status();
        if (gateAtProcessStart.lease) {
          await this.gate.recoverOrphanedLease('process-restarted-with-local-lease');
        }
        const integrity = await verifyAndRecoverHomeAuthority({
          local,
          client: this.client,
          gate: this.gate,
          syncStateFile,
          integrityStateFile: this.integrityStateFile,
          dataDir: this.config.dataDir,
        durableMirror: this.durableMirror,
        });
        startupRecovery = { reconciled: integrity.repaired, result: integrity };
      }
      this.ingress = new HomeAuthorityIngress({
        secret: this.config.authority.secret,
        gate: this.gate,
        feedHandler: async (request) => {
          try {
            const result = await this.runtime.dispatchFetch('http://tubepulse.local/feed', {
              method: 'GET',
              headers: { Authorization: request.headers.get('Authorization') || '' },
            });
            this.recordFeedResponse(result.status);
            return result;
          } catch (error) {
            this.recordFeedResponse(500);
            throw error;
          }
        },
        mutationHandler: async ({ method, path, body, headers, authorization }) => {
          const buffered = new BufferedKvNamespace(namespace);
          const context = new CapturingExecutionContext();
          const forwardedHeaders = new Headers({ Authorization: authorization });
          for (const name of ['content-type', 'accept']) {
            if (typeof headers?.[name] === 'string') forwardedHeaders.set(name, headers[name]);
          }
          const request = new Request(`http://tubepulse.local${path}`, {
            method,
            headers: forwardedHeaders,
            ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
          });
          const response = await appWorker.fetch(request, {
            ...this.config.workerBindings,
            TUBEPULSE_KV: buffered,
            TUBEPULSE_DISABLE_WEBSUB: 'true',
            TUBEPULSE_INTERNAL_ACTIVITY_TOUCH: 'true',
          }, context);
          await context.flush();
          if (response.ok && path !== '/register' && path !== '/_tubepulse/activity-touch') {
            const deviceId = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
            await touchExistingDeviceActivity({ TUBEPULSE_KV: buffered }, deviceId).catch(() => {});
          }
          const responseBody = await response.text();
          return {
            response: { status: response.status, headers: responseHeaders(response), body: responseBody },
            deltas: response.status >= 400 ? [] : await buffered.deltas(),
          };
        },
      });
      this.runner ||= new HomeSchedulerRunner({
        config: this.config,
        runtime: this.runtime,
        lease: this.lease,
        authorityGate: this.gate,
        authorityClient: this.client,
        recoverAuthority: ensureCurrent,
        durableMirror: this.durableMirror,
      });
      await this.runner.start();
      runnerStarted = true;
      if (startupRecovery?.reconciled) {
        await this.runner.scheduleCanonicalRecoveryRevalidation(startupRecovery);
      }
      if (this.config.mode === 'active') await this.runner.run();

      this.server = http.createServer((request, response) => {
        this.handle(request, response).catch((error) => {
          const status = error?.status || 500;
          sendResponse(response, Response.json({ error: status === 413 ? 'Request too large' : 'Internal authority error' }, { status }));
        });
      });
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.port, this.host, resolve);
      });
      this.ready = true;
      if (this.config.mode === 'active') {
        const scheduledAt = Date.now();
        const catchUp = this.runner.runStartupPostCatchUpIfDue()
          .catch((error) => this.runner.handleScheduledTickError(error, scheduledAt))
          .catch((error) => {
            console.error(`TubePulse startup post catch-up error handler failed: ${String(error?.message || error).slice(0, 300)}`);
          });
        this.runner.activeTick = catchUp;
        void catchUp.finally(() => {
          if (this.runner.activeTick === catchUp) this.runner.activeTick = null;
        });
      }
      return this;
    } catch (error) {
      this.ready = false;
      if (this.server) {
        this.server.closeAllConnections?.();
        await new Promise((resolve) => this.server.close(resolve)).catch(() => {});
        this.server = null;
      }
      if (runnerStarted) await this.runner.close().catch(() => {});
      else {
        await this.runtime.close().catch(() => {});
        await this.lease?.release().catch(() => {});
      }
      throw error;
    }
  }

  async handle(request, response) {
    const parsed = new URL(request.url, 'http://authority.local');
    if (parsed.pathname === '/_tubepulse/admin/purge-devices') {
      if (request.method !== 'POST') return await sendResponse(response, Response.json({ error: 'Method not allowed' }, { status: 405 }));
      if (!tokenMatches(this.config.authority.secret, bearerToken(request))) {
        return await sendResponse(response, Response.json({ error: 'Unauthorized' }, { status: 401 }));
      }
      const operatorRequest = await nodeRequestToRequest(request, 'http://authority.local');
      const payload = await operatorRequest.json().catch(() => null);
      if (!payload || !Array.isArray(payload.devices)) {
        return await sendResponse(response, Response.json({ error: 'Invalid cleanup plan' }, { status: 400 }));
      }
      try {
        const result = await this.runner.operatorCleanupDevices(payload.devices, { apply: payload.apply === true });
        return await sendResponse(response, Response.json({ ok: true, result }));
      } catch (error) {
        const status = Number(error?.status) || (/precondition|cleanup plan/i.test(String(error?.message)) ? 409 : 500);
        return await sendResponse(response, Response.json({ error: String(error?.message || 'Cleanup failed') }, { status }));
      }
    }
    if (parsed.pathname === '/service-status') {
      if (request.method !== 'GET') return await sendResponse(response, Response.json({ error: 'Method not allowed' }, { status: 405 }));
      const [authority, scheduler] = await Promise.all([this.gate.status(), this.runner.status()]);
      const { startupRecovery } = await this.liveStartupRecovery(authority, scheduler);
      const startupPassed = ['passed', 'superseded', 'not-managed'].includes(startupRecovery.status);
      const status = classifyPublicServiceStatus({
        status: this.ready && startupPassed ? 'ready' : startupRecovery.status === 'failed' ? 'startup-failed' : 'starting',
        mode: this.config.mode,
        authority,
        scheduler: publicHomeSchedulerState(scheduler),
        startupRecovery,
        localIntegrity: await this.publicIntegrity(),
        feedHealth: { ...this.feedHealth },
        capabilities: {
          localKvIntegrity: true,
          homeFeedHealth: true,
          notificationVisibility: true,
          durableNotificationIntent: true,
        },
        configuration: {
          notificationsEnabled: this.config.notificationsEnabled,
          alignedVideoNotificationsEnabled: this.config.alignedVideoNotificationsEnabled,
        },
      });
      return await sendResponse(response, new Response(JSON.stringify(status), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=60, stale-if-error=120',
        },
      }));
    }
    if (parsed.pathname === '/_tubepulse/status') {
      if (request.method !== 'GET') return await sendResponse(response, Response.json({ error: 'Method not allowed' }, { status: 405 }));
      const [authority, scheduler] = await Promise.all([this.gate.status(), this.runner.status()]);
      const { startupRecovery } = await this.liveStartupRecovery(authority, scheduler);
      const startupPassed = ['passed', 'superseded', 'not-managed'].includes(startupRecovery.status);
      return await sendResponse(response, Response.json({
        status: this.ready && startupPassed ? 'ready' : startupRecovery.status === 'failed' ? 'startup-failed' : 'starting',
        service: 'unified-home-authority',
        mode: this.config.mode,
        authority,
        scheduler: publicHomeSchedulerState(scheduler),
        startupRecovery,
        localIntegrity: await this.publicIntegrity(),
        feedHealth: { ...this.feedHealth },
        configuration: {
          videoCadenceMinutes: 5,
          videoSourceMode: this.config.videoSourceMode,
          postsCadenceMinutes: this.config.postsCadenceMinutes,
          notificationsEnabled: this.config.notificationsEnabled,
          alignedVideoNotificationsEnabled: this.config.alignedVideoNotificationsEnabled,
          preciseLiveWatchEnabled: this.config.preciseLiveWatchEnabled,
          preciseLiveWatchDailyCap: this.config.preciseLiveWatchDailyCap,
          remoteWriteEnabled: this.config.remoteWriteEnabled,
          publicAppRoutes: false,
          periodicCanonicalPull: false,
        },
      }));
    }
    if (parsed.pathname === '/_tubepulse/monitoring') {
      if (request.method !== 'GET') return await sendResponse(response, Response.json({ error: 'Method not allowed' }, { status: 405 }));
      const [authority, scheduler, remoteResult] = await Promise.all([
        this.gate.status(),
        this.runner.status(),
        this.client.status().then((value) => ({ value })).catch(() => ({ value: null })),
      ]);
      const { startupRecovery } = await this.liveStartupRecovery(authority, scheduler, remoteResult.value);
      const startupPassed = ['passed', 'superseded', 'not-managed'].includes(startupRecovery.status);
      const localStatus = {
        status: this.ready && startupPassed ? 'ready' : startupRecovery.status === 'failed' ? 'startup-failed' : 'starting',
        mode: this.config.mode,
        authority,
        scheduler: publicHomeSchedulerState(scheduler),
        startupRecovery,
        localIntegrity: await this.publicIntegrity(),
        feedHealth: { ...this.feedHealth },
        capabilities: {
          localKvIntegrity: true,
          homeFeedHealth: true,
          notificationVisibility: true,
          durableNotificationIntent: true,
        },
        configuration: {
          videoSourceMode: this.config.videoSourceMode,
          preciseLiveWatchEnabled: this.config.preciseLiveWatchEnabled,
          preciseLiveWatchDailyCap: this.config.preciseLiveWatchDailyCap,
        },
      };
      const aggregate = await collectAggregateMonitoring({
        adapter: this.localAdapter,
        localStatus,
        remoteStatus: remoteResult.value,
        config: this.config,
      });
      return await sendResponse(response, new Response(JSON.stringify(aggregate), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      }));
    }
    if (!parsed.pathname.startsWith('/_tubepulse/authority/')) {
      return await sendResponse(response, Response.json({ error: 'Not found' }, { status: 404 }));
    }
    const origin = `http://${request.headers.host || 'gateway-origin:8788'}`;
    return await sendResponse(response, await this.ingress.handle(await nodeRequestToRequest(request, origin)));
  }

  async close() {
    this.ready = false;
    let failure = null;
    if (this.server) {
      const closing = new Promise((resolve) => this.server.close(resolve));
      this.server.closeAllConnections?.();
      try { await closing; } catch (error) { failure = error; }
      this.server = null;
    }
    try {
      if (this.runner) await this.runner.close();
    } catch (error) {
      failure ||= error;
    }
    try { await this.lease?.release(); } catch (error) { failure ||= error; }
    try { await this.runtime.close(); } catch (error) { failure ||= error; }
    if (failure) throw failure;
  }
}

export async function createUnifiedHomeAuthorityService(config, options) {
  return await new UnifiedHomeAuthorityService(config, options).start();
}
