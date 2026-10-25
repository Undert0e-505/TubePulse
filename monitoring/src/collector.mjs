import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchCloudflareAnalytics } from './cloudflare.mjs';
import { prometheusText } from './prometheus.mjs';
import { appendSnapshotOnce, pruneSnapshots, readJson, writeJsonAtomic } from './snapshots.mjs';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const COLLECTION_OFFSET_MS = 30 * 1000;

function counterDelta(current, previous) {
  const next = Number(current);
  const prior = Number(previous);
  if (!Number.isFinite(next) || next < 0) return 0;
  if (!Number.isFinite(prior) || prior < 0) return next;
  return next >= prior ? next - prior : next;
}

function addNotificationCounterDeltas(host, previousHost) {
  host.notifications ||= {};
  host.notifications.fcmAcceptedInterval = counterDelta(
    host.notifications.fcmAcceptedTotal,
    previousHost?.notifications?.fcmAcceptedTotal,
  );
  host.notifications.fcmFailedInterval = counterDelta(
    host.notifications.fcmFailedTotal,
    previousHost?.notifications?.fcmFailedTotal,
  );
  return host;
}

function withoutStaleNotificationDeltas(host) {
  const snapshot = structuredClone(host);
  if (snapshot?.notifications) {
    snapshot.notifications.fcmAcceptedInterval = 0;
    snapshot.notifications.fcmFailedInterval = 0;
  }
  return snapshot;
}

function integer(value, fallback, minimum = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  const hostStatusUrl = env.TUBEPULSE_HOST_MONITORING_URL || 'http://home-authority:8788/_tubepulse/monitoring';
  return {
    port: integer(env.PORT, 9464, 1),
    hostStatusUrl,
    hostRuntimeStatusUrl: env.TUBEPULSE_HOST_RUNTIME_STATUS_URL
      || hostStatusUrl.replace(/\/_tubepulse\/monitoring(?:\?.*)?$/, '/_tubepulse/status'),
    accountId: env.CLOUDFLARE_ACCOUNT_ID || '',
    d1DatabaseId: env.CLOUDFLARE_D1_DATABASE_ID || '',
    workerScript: env.CLOUDFLARE_WORKER_SCRIPT || 'tubepulse-api',
    tokenFile: env.CLOUDFLARE_API_TOKEN_FILE || '/run/secrets/cloudflare-read-token.txt',
    snapshotDir: env.TUBEPULSE_SNAPSHOT_DIR || '/data/snapshots',
    stateFile: env.TUBEPULSE_COLLECTOR_STATE_FILE || '/data/collector/state.json',
    cadenceMs: integer(env.TUBEPULSE_MONITORING_CADENCE_MS, FIVE_MINUTES_MS, 60_000),
    collectionOffsetMs: integer(env.TUBEPULSE_MONITORING_OFFSET_MS, COLLECTION_OFFSET_MS, 0),
    schedulerSettlementTimeoutMs: integer(env.TUBEPULSE_SCHEDULER_SETTLEMENT_TIMEOUT_MS, 20_000, 0),
    schedulerSettlementPollMs: integer(env.TUBEPULSE_SCHEDULER_SETTLEMENT_POLL_MS, 1_000, 100),
    analyticsDelayMs: integer(env.TUBEPULSE_CLOUDFLARE_DELAY_MS, 10 * 60 * 1000, 0),
    retentionDays: integer(env.TUBEPULSE_SNAPSHOT_RETENTION_DAYS, 1095, 32),
    limits: {
      d1RowsWritten: integer(env.TUBEPULSE_D1_ROWS_WRITTEN_GUARDRAIL, 100_000, 1),
      d1RowsRead: integer(env.TUBEPULSE_D1_ROWS_READ_GUARDRAIL, 5_000_000, 1),
      durableObjectRowsWritten: integer(env.TUBEPULSE_DO_ROWS_WRITTEN_GUARDRAIL, 100_000, 1),
      workerRequests: integer(env.TUBEPULSE_WORKER_REQUEST_GUARDRAIL, 100_000, 1),
    },
  };
}

export function intervalFor(nowMs, cadenceMs = FIVE_MINUTES_MS) {
  const endMs = Math.floor(nowMs / cadenceMs) * cadenceMs;
  return { startMs: endMs - cadenceMs, endMs };
}

export function nextCollectionAt(
  nowMs,
  cadenceMs = FIVE_MINUTES_MS,
  offsetMs = COLLECTION_OFFSET_MS,
) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(cadenceMs) || cadenceMs <= 0) {
    throw new TypeError('Collection alignment requires a finite time and positive cadence');
  }
  const normalizedOffset = ((offsetMs % cadenceMs) + cadenceMs) % cadenceMs;
  return (Math.floor((nowMs - normalizedOffset) / cadenceMs) + 1) * cadenceMs + normalizedOffset;
}

function safeFailure(error) {
  const message = String(error?.message || error || 'unknown');
  const http = message.match(/HTTP (\d{3})/);
  if (http) return `http-${http[1]}`;
  if (/timeout|abort/i.test(message)) return 'timeout';
  if (/Cloudflare/i.test(message)) return 'cloudflare-unavailable';
  if (/host/i.test(message)) return 'host-unavailable';
  return 'collection-failed';
}

async function fetchJson(url, fetchImpl, timeoutMs = 30_000) {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
  });
  if (!response.ok) throw new Error(`host monitoring HTTP ${response.status}`);
  return await response.json();
}

function timestamp(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cycleMatchesBoundary(cycle, boundaryMs, cadenceMs) {
  const observed = timestamp(cycle?.scheduledAt ?? cycle?.startedAt ?? cycle?.finishedAt);
  return observed !== null && Math.abs(observed - boundaryMs) < Math.min(cadenceMs, 60_000);
}

function terminalCycle(status, boundaryMs, cadenceMs) {
  const scheduler = status?.scheduler || {};
  const sweep = scheduler.lastSweep || {};
  const error = scheduler.lastError || {};
  const sweepMatches = cycleMatchesBoundary(sweep, boundaryMs, cadenceMs);
  const errorMatches = cycleMatchesBoundary(error, boundaryMs, cadenceMs);
  if (errorMatches && (!sweepMatches || timestamp(error.at) >= timestamp(sweep.finishedAt))) {
    const leaseBusy = /lease busy/i.test(String(error.message || ''));
    return { status: leaseBusy ? 'skipped' : 'failed', outcome: leaseBusy ? 'lease-busy' : 'failed' };
  }
  if (sweepMatches && sweep.outcome) {
    const outcome = String(sweep.outcome);
    if (/fail|error/i.test(outcome)) return { status: 'failed', outcome };
    if (/skip|lease-busy/i.test(outcome)) return { status: 'skipped', outcome };
    return { status: 'complete', outcome };
  }
  return { status: 'not-observed', outcome: null };
}

export async function waitForSchedulerSettlement({
  statusUrl,
  fetchImpl,
  boundaryMs,
  cadenceMs = FIVE_MINUTES_MS,
  timeoutMs = 20_000,
  pollMs = 1_000,
  now = Date.now,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
}) {
  if (!statusUrl || timeoutMs <= 0) {
    return { status: 'disabled', outcome: null, waitedMs: 0, polls: 0 };
  }
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let polls = 0;
  while (true) {
    let status;
    try {
      status = await fetchJson(statusUrl, fetchImpl, Math.min(5_000, Math.max(1, deadline - now())));
      polls++;
    } catch (error) {
      return {
        status: 'unavailable', outcome: null, waitedMs: Math.max(0, now() - startedAt), polls,
        failure: safeFailure(error),
      };
    }
    if (!status?.scheduler?.currentSweep) {
      const terminal = terminalCycle(status, boundaryMs, cadenceMs);
      return { ...terminal, waitedMs: Math.max(0, now() - startedAt), polls };
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { status: 'timeout', outcome: 'running', waitedMs: Math.max(0, now() - startedAt), polls };
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

export function createCollector({
  config = loadConfig(),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep,
} = {}) {
  fs.mkdirSync(config.snapshotDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
  const persisted = readJson(config.stateFile, {}) || {};
  const state = {
    lastIntervalStart: persisted.lastIntervalStart || null,
    lastAttemptAt: persisted.lastAttemptAt || null,
    lastSuccessAt: persisted.lastSuccessAt || null,
    lastCollectionSuccess: Boolean(persisted.lastCollectionSuccess),
    errorsTotal: Number(persisted.errorsTotal) || 0,
    lastFailure: persisted.lastFailure || null,
    authorityPendingConsecutiveSamples: Number(persisted.authorityPendingConsecutiveSamples) || 0,
    authorityTransactionConsecutiveSamples: Number(persisted.authorityTransactionConsecutiveSamples) || 0,
    latest: persisted.latest || null,
    cache: persisted.cache || { host: null, cloudflare: null },
  };
  let running = null;

  const persist = () => writeJsonAtomic(config.stateFile, state);

  async function collect(atMs = now()) {
    if (running) return await running;
    running = (async () => {
      const interval = intervalFor(atMs, config.cadenceMs);
      const intervalStart = new Date(interval.startMs).toISOString();
      if (state.lastIntervalStart === intervalStart) return { skipped: true, snapshot: state.latest };
      state.lastAttemptAt = new Date(atMs).toISOString();
      const schedulerSettlement = await waitForSchedulerSettlement({
        statusUrl: config.hostRuntimeStatusUrl,
        fetchImpl,
        boundaryMs: interval.endMs,
        cadenceMs: config.cadenceMs,
        timeoutMs: config.schedulerSettlementTimeoutMs ?? 0,
        pollMs: config.schedulerSettlementPollMs ?? 1_000,
        now,
        sleep,
      });
      const token = fs.readFileSync(config.tokenFile, 'utf8').trim();
      const finalizedEnd = interval.endMs - config.analyticsDelayMs;
      const finalizedStart = finalizedEnd - config.cadenceMs;
      const [hostResult, cloudflareResult] = await Promise.allSettled([
        fetchJson(config.hostStatusUrl, fetchImpl),
        fetchCloudflareAnalytics({
          token, fetchImpl,
          accountId: config.accountId,
          d1DatabaseId: config.d1DatabaseId,
          workerScript: config.workerScript,
          windowStart: finalizedStart,
          windowEnd: finalizedEnd,
        }),
      ]);
      const hostSuccess = hostResult.status === 'fulfilled';
      const cloudflareSuccess = cloudflareResult.status === 'fulfilled';
      if (hostSuccess) {
        const host = addNotificationCounterDeltas(
          structuredClone(hostResult.value),
          state.cache.host,
        );
        const pending = Number(host?.authority?.pendingBackupKeys || 0);
        const transactionActive = Boolean(host?.authority?.transactionActive);
        state.authorityPendingConsecutiveSamples = pending > 0
          ? state.authorityPendingConsecutiveSamples + 1
          : 0;
        state.authorityTransactionConsecutiveSamples = transactionActive
          ? state.authorityTransactionConsecutiveSamples + 1
          : 0;
        if (host?.authority && typeof host.authority === 'object') {
          host.authority.pendingBackupConsecutiveSamples = state.authorityPendingConsecutiveSamples;
          host.authority.transactionActiveConsecutiveSamples = state.authorityTransactionConsecutiveSamples;
        }
        state.cache.host = host;
      } else {
        // A failed host collection cannot confirm that a queue remained
        // pending across consecutive observations.
        state.authorityPendingConsecutiveSamples = 0;
        state.authorityTransactionConsecutiveSamples = 0;
      }
      if (cloudflareSuccess) state.cache.cloudflare = cloudflareResult.value;
      const failures = [];
      if (!hostSuccess) failures.push(safeFailure(hostResult.reason));
      if (!cloudflareSuccess) failures.push(safeFailure(cloudflareResult.reason));
      const snapshot = {
        schemaVersion: 1,
        intervalStart,
        intervalEnd: new Date(interval.endMs).toISOString(),
        collectedAt: new Date(atMs).toISOString(),
        collection: {
          success: hostSuccess && cloudflareSuccess,
          hostSuccess,
          cloudflareSuccess,
          failures,
          schedulerSettlement,
          cloudflareWindowStart: new Date(finalizedStart).toISOString(),
          cloudflareWindowEnd: new Date(finalizedEnd).toISOString(),
        },
        host: hostSuccess ? state.cache.host : withoutStaleNotificationDeltas(state.cache.host),
        cloudflare: state.cache.cloudflare,
      };
      const write = appendSnapshotOnce(config.snapshotDir, snapshot);
      pruneSnapshots(config.snapshotDir, { retentionDays: config.retentionDays, nowMs: atMs });
      state.lastIntervalStart = intervalStart;
      state.latest = snapshot;
      state.lastCollectionSuccess = snapshot.collection.success;
      state.lastFailure = failures.join(',') || null;
      if (snapshot.collection.success) state.lastSuccessAt = snapshot.collectedAt;
      else state.errorsTotal++;
      persist();
      return { skipped: !write.appended, snapshot };
    })();
    try { return await running; } finally { running = null; }
  }

  function metrics() {
    return prometheusText({
      snapshot: state.latest,
      collector: { ...state, limits: config.limits },
      nowMs: now(),
    });
  }

  function health() {
    return {
      status: 'ok',
      service: 'tubepulse-aggregate-collector',
      collectionSuccess: state.lastCollectionSuccess,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      lastIntervalStart: state.lastIntervalStart,
      lastFailure: state.lastFailure,
    };
  }
  return { state, collect, metrics, health };
}

export async function main() {
  const config = loadConfig();
  const collector = createCollector({ config });
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://collector.local').pathname;
    if (request.method === 'GET' && pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return response.end(JSON.stringify(collector.health()));
    }
    if (request.method === 'GET' && pathname === '/metrics') {
      response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      return response.end(collector.metrics());
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
  });
  server.listen(config.port, '0.0.0.0');
  const arm = () => {
    const armedAt = Date.now();
    const slot = nextCollectionAt(armedAt, config.cadenceMs, config.collectionOffsetMs);
    const delay = Math.max(1, slot - armedAt);
    const timer = setTimeout(async () => {
      await collector.collect(slot).catch((error) => console.error(`[collector] collection failed: ${safeFailure(error)}`));
      arm();
    }, delay);
    timer.unref?.();
  };
  arm();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[collector] fatal: ${safeFailure(error)}`);
    process.exitCode = 1;
  });
}
