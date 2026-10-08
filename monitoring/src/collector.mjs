import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchCloudflareAnalytics } from './cloudflare.mjs';
import { prometheusText } from './prometheus.mjs';
import { appendSnapshotOnce, pruneSnapshots, readJson, writeJsonAtomic } from './snapshots.mjs';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function integer(value, fallback, minimum = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  return {
    port: integer(env.PORT, 9464, 1),
    hostStatusUrl: env.TUBEPULSE_HOST_MONITORING_URL || 'http://home-authority:8788/_tubepulse/monitoring',
    accountId: env.CLOUDFLARE_ACCOUNT_ID || '',
    d1DatabaseId: env.CLOUDFLARE_D1_DATABASE_ID || '',
    workerScript: env.CLOUDFLARE_WORKER_SCRIPT || 'tubepulse-api',
    tokenFile: env.CLOUDFLARE_API_TOKEN_FILE || '/run/secrets/cloudflare-read-token.txt',
    snapshotDir: env.TUBEPULSE_SNAPSHOT_DIR || '/data/snapshots',
    stateFile: env.TUBEPULSE_COLLECTOR_STATE_FILE || '/data/collector/state.json',
    cadenceMs: integer(env.TUBEPULSE_MONITORING_CADENCE_MS, FIVE_MINUTES_MS, 60_000),
    analyticsDelayMs: integer(env.TUBEPULSE_CLOUDFLARE_DELAY_MS, 10 * 60 * 1000, 0),
    retentionDays: integer(env.TUBEPULSE_SNAPSHOT_RETENTION_DAYS, 1095, 32),
    limits: {
      d1RowsWritten: integer(env.TUBEPULSE_D1_ROWS_WRITTEN_GUARDRAIL, 100_000, 1),
      d1RowsRead: integer(env.TUBEPULSE_D1_ROWS_READ_GUARDRAIL, 5_000_000, 1),
      workerRequests: integer(env.TUBEPULSE_WORKER_REQUEST_GUARDRAIL, 100_000, 1),
    },
  };
}

export function intervalFor(nowMs, cadenceMs = FIVE_MINUTES_MS) {
  const endMs = Math.floor(nowMs / cadenceMs) * cadenceMs;
  return { startMs: endMs - cadenceMs, endMs };
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

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`host monitoring HTTP ${response.status}`);
  return await response.json();
}

export function createCollector({ config = loadConfig(), fetchImpl = globalThis.fetch, now = Date.now } = {}) {
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
        const host = structuredClone(hostResult.value);
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
          cloudflareWindowStart: new Date(finalizedStart).toISOString(),
          cloudflareWindowEnd: new Date(finalizedEnd).toISOString(),
        },
        host: state.cache.host,
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
    return prometheusText({ snapshot: state.latest, collector: { ...state, limits: config.limits } });
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
  await collector.collect().catch((error) => console.error(`[collector] initial collection failed: ${safeFailure(error)}`));
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
    const delay = Math.max(1000, Math.floor((Date.now() / config.cadenceMs) + 1) * config.cadenceMs - Date.now() + 5000);
    const timer = setTimeout(async () => {
      await collector.collect().catch((error) => console.error(`[collector] collection failed: ${safeFailure(error)}`));
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
