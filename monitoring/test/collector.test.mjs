import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createCollector, intervalFor, nextCollectionAt, waitForSchedulerSettlement,
} from '../src/collector.mjs';

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('collector writes once per interval, survives a partial failure, and retains last good data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tubepulse-collector-'));
  try {
    const tokenFile = path.join(root, 'token.txt');
    fs.writeFileSync(tokenFile, 'test-token');
    let failHost = false;
    const fetchImpl = async (url) => {
      if (String(url).includes('host.test')) return failHost ? jsonResponse({}, 503) : jsonResponse({ privacy: 'aggregate-only', host: { ready: true } });
      return jsonResponse({ data: { viewer: { accounts: [{
        workerWindow: [], workerDay: [], d1Window: [], d1Day: [], d1Storage: [],
        doInvocationsWindow: [], doInvocationsDay: [], doPeriodicWindow: [], doPeriodicDay: [], doStorage: [],
      }] } } });
    };
    const config = {
      port: 9464, hostStatusUrl: 'http://host.test/monitoring', accountId: 'a'.repeat(32),
      d1DatabaseId: '11111111-2222-3333-4444-555555555555', workerScript: 'tubepulse-api', tokenFile,
      snapshotDir: path.join(root, 'snapshots'), stateFile: path.join(root, 'collector', 'state.json'),
      cadenceMs: 300_000, analyticsDelayMs: 600_000, retentionDays: 1095,
      limits: { d1RowsWritten: 100000, d1RowsRead: 5000000, workerRequests: 100000 },
    };
    const firstTime = Date.parse('2026-10-06T11:06:00Z');
    const collector = createCollector({ config, fetchImpl, now: () => firstTime });
    const first = await collector.collect(firstTime);
    assert.equal(first.snapshot.collection.success, true);
    assert.equal((await collector.collect(firstTime + 1_000)).skipped, true);

    failHost = true;
    const secondTime = firstTime + 300_000;
    const second = await collector.collect(secondTime);
    assert.equal(second.snapshot.collection.success, false);
    assert.equal(second.snapshot.collection.hostSuccess, false);
    assert.equal(second.snapshot.host.host.ready, true);
    assert.equal(collector.state.errorsTotal, 1);
    assert.match(collector.metrics(), /tubepulse_collector_host_collection_success 0/);
    const lines = fs.readFileSync(path.join(root, 'snapshots', '2026-10-06.jsonl'), 'utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, 2);

    const restarted = createCollector({ config, fetchImpl, now: () => secondTime });
    assert.equal(restarted.state.lastIntervalStart, second.snapshot.intervalStart);
    assert.equal((await restarted.collect(secondTime + 1_000)).skipped, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('intervals are aligned and non-overlapping', () => {
  assert.deepEqual(intervalFor(Date.parse('2026-10-06T11:06:12Z')), {
    startMs: Date.parse('2026-10-06T11:00:00Z'), endMs: Date.parse('2026-10-06T11:05:00Z'),
  });
});

test('collection slots stay on the next future UTC five-minute +30s boundary without drift', () => {
  const expected = (at, next) => assert.equal(nextCollectionAt(Date.parse(at)), Date.parse(next));
  expected('2026-10-06T11:00:00.000Z', '2026-10-06T11:00:30.000Z');
  expected('2026-10-06T11:00:29.999Z', '2026-10-06T11:00:30.000Z');
  expected('2026-10-06T11:00:30.000Z', '2026-10-06T11:05:30.000Z');
  expected('2026-10-06T11:00:30.001Z', '2026-10-06T11:05:30.000Z');
  expected('2026-10-06T11:04:59.999Z', '2026-10-06T11:05:30.000Z');
  expected('2026-10-06T11:05:29.999Z', '2026-10-06T11:05:30.000Z');
  expected('2026-10-06T11:05:30.000Z', '2026-10-06T11:10:30.000Z');
  // A large forward wall-clock jump is realigned from the clock, not from the
  // previous timer, so it neither accumulates drift nor replays missed slots.
  expected('2026-10-06T14:02:17.000Z', '2026-10-06T14:05:30.000Z');
  assert.deepEqual(intervalFor(Date.parse('2026-10-06T11:05:30.000Z')), {
    startMs: Date.parse('2026-10-06T11:00:00.000Z'),
    endMs: Date.parse('2026-10-06T11:05:00.000Z'),
  });
});

test('scheduler settlement recognizes completed, failed and lease-busy cycles', async () => {
  const boundaryMs = Date.parse('2026-10-10T20:10:00Z');
  const run = async (scheduler) => await waitForSchedulerSettlement({
    statusUrl: 'http://host.test/status', boundaryMs, timeoutMs: 2_000,
    fetchImpl: async () => jsonResponse({ scheduler }), now: () => boundaryMs + 30_000,
  });
  assert.deepEqual(await run({ currentSweep: null, lastSweep: {
    outcome: 'ok', startedAt: '2026-10-10T20:10:00.038Z', finishedAt: '2026-10-10T20:10:04.837Z',
  } }), { status: 'complete', outcome: 'ok', waitedMs: 0, polls: 1 });
  assert.deepEqual(await run({ currentSweep: null, lastSweep: {
    outcome: 'error', startedAt: '2026-10-10T20:10:00.038Z', finishedAt: '2026-10-10T20:10:01.000Z',
  } }), { status: 'failed', outcome: 'error', waitedMs: 0, polls: 1 });
  assert.deepEqual(await run({ currentSweep: null, lastSweep: { outcome: 'not-due', scheduledAt: '2026-10-10T20:09:00Z' }, lastError: {
    at: '2026-10-10T20:10:00.065Z', scheduledAt: '2026-10-10T20:10:00Z', message: 'Home authority lease busy',
  } }), { status: 'skipped', outcome: 'lease-busy', waitedMs: 0, polls: 1 });
});

test('collector waits for an active aligned cycle and samples its completed counter alone', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tubepulse-collector-settlement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, 'token.txt');
  fs.writeFileSync(tokenFile, 'test-token');
  const boundary = Date.parse('2026-10-10T20:10:00Z');
  let nowMs = boundary + 30_000;
  let statusCalls = 0;
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.endsWith('/status')) {
      statusCalls++;
      if (statusCalls === 1) return jsonResponse({ scheduler: { currentSweep: { startedAt: new Date(boundary).toISOString() } } });
      return jsonResponse({ scheduler: { currentSweep: null, lastSweep: {
        outcome: 'ok', startedAt: new Date(boundary).toISOString(), finishedAt: new Date(boundary + 31_000).toISOString(),
      } } });
    }
    if (text.endsWith('/monitoring')) return jsonResponse({ privacy: 'aggregate-only', notifications: {
      fcmAcceptedTotal: 4, fcmFailedTotal: 0,
    } });
    return jsonResponse({ data: { viewer: { accounts: [{
      workerWindow: [], workerDay: [], d1Window: [], d1Day: [], d1Storage: [],
      doInvocationsWindow: [], doInvocationsDay: [], doPeriodicWindow: [], doPeriodicDay: [], doStorage: [],
    }] } } });
  };
  const config = {
    port: 9464, hostStatusUrl: 'http://host.test/monitoring', hostRuntimeStatusUrl: 'http://host.test/status',
    accountId: 'a'.repeat(32), d1DatabaseId: '11111111-2222-3333-4444-555555555555',
    workerScript: 'tubepulse-api', tokenFile, snapshotDir: path.join(root, 'snapshots'),
    stateFile: path.join(root, 'collector', 'state.json'), cadenceMs: 300_000,
    schedulerSettlementTimeoutMs: 20_000, schedulerSettlementPollMs: 1_000,
    analyticsDelayMs: 600_000, retentionDays: 1095,
    limits: { d1RowsWritten: 100000, d1RowsRead: 5000000, workerRequests: 100000 },
  };
  const collector = createCollector({
    config, fetchImpl, now: () => nowMs, sleep: async (delay) => { nowMs += delay; },
  });
  const result = await collector.collect(boundary + 30_000);
  assert.deepEqual(result.snapshot.collection.schedulerSettlement, {
    status: 'complete', outcome: 'ok', waitedMs: 1_000, polls: 2,
  });
  assert.equal(result.snapshot.host.notifications.fcmAcceptedInterval, 4);
  assert.equal(result.snapshot.collectedAt, '2026-10-10T20:10:30.000Z');
});

test('an overlong cycle times out without advancing unseen sends and the next sample catches up once', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tubepulse-collector-timeout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, 'token.txt');
  fs.writeFileSync(tokenFile, 'test-token');
  let boundary = Date.parse('2026-10-10T20:10:00Z');
  let nowMs = boundary + 30_000;
  let active = true;
  let total = 0;
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.endsWith('/status')) return jsonResponse({ scheduler: active
      ? { currentSweep: { startedAt: new Date(boundary).toISOString() } }
      : { currentSweep: null, lastSweep: { outcome: 'ok', startedAt: new Date(boundary).toISOString() } } });
    if (text.endsWith('/monitoring')) return jsonResponse({ privacy: 'aggregate-only', notifications: {
      fcmAcceptedTotal: total, fcmFailedTotal: 0,
    } });
    return jsonResponse({ data: { viewer: { accounts: [{
      workerWindow: [], workerDay: [], d1Window: [], d1Day: [], d1Storage: [],
      doInvocationsWindow: [], doInvocationsDay: [], doPeriodicWindow: [], doPeriodicDay: [], doStorage: [],
    }] } } });
  };
  const config = {
    port: 9464, hostStatusUrl: 'http://host.test/monitoring', hostRuntimeStatusUrl: 'http://host.test/status',
    accountId: 'a'.repeat(32), d1DatabaseId: '11111111-2222-3333-4444-555555555555',
    workerScript: 'tubepulse-api', tokenFile, snapshotDir: path.join(root, 'snapshots'),
    stateFile: path.join(root, 'collector', 'state.json'), cadenceMs: 300_000,
    schedulerSettlementTimeoutMs: 2_000, schedulerSettlementPollMs: 1_000,
    analyticsDelayMs: 600_000, retentionDays: 1095,
    limits: { d1RowsWritten: 100000, d1RowsRead: 5000000, workerRequests: 100000 },
  };
  const collector = createCollector({
    config, fetchImpl, now: () => nowMs, sleep: async (delay) => { nowMs += delay; },
  });
  const timedOut = await collector.collect(boundary + 30_000);
  assert.equal(timedOut.snapshot.collection.schedulerSettlement.status, 'timeout');
  assert.equal(timedOut.snapshot.host.notifications.fcmAcceptedInterval, 0);

  active = false;
  total = 3;
  boundary += 300_000;
  nowMs = boundary + 30_000;
  const caughtUp = await collector.collect(boundary + 30_000);
  assert.equal(caughtUp.snapshot.collection.schedulerSettlement.status, 'complete');
  assert.equal(caughtUp.snapshot.host.notifications.fcmAcceptedInterval, 3);
  assert.equal((await collector.collect(boundary + 31_000)).skipped, true);
});

test('notification interval deltas are exact across zero, single, batch, failure, restart and counter reset', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tubepulse-collector-notifications-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, 'token.txt');
  fs.writeFileSync(tokenFile, 'test-token');
  const totals = [
    { fcmAcceptedTotal: 0, fcmFailedTotal: 0 },
    { fcmAcceptedTotal: 1, fcmFailedTotal: 0 },
    { fcmAcceptedTotal: 4, fcmFailedTotal: 1 },
    null,
    { fcmAcceptedTotal: 6, fcmFailedTotal: 1 },
    { fcmAcceptedTotal: 0, fcmFailedTotal: 0 },
    { fcmAcceptedTotal: 2, fcmFailedTotal: 1 },
  ];
  let hostCall = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('host.test')) {
      const value = totals[hostCall++];
      return value === null
        ? jsonResponse({}, 503)
        : jsonResponse({ privacy: 'aggregate-only', notifications: value });
    }
    return jsonResponse({ data: { viewer: { accounts: [{
      workerWindow: [], workerDay: [], d1Window: [], d1Day: [], d1Storage: [],
      doInvocationsWindow: [], doInvocationsDay: [], doPeriodicWindow: [], doPeriodicDay: [], doStorage: [],
    }] } } });
  };
  const config = {
    port: 9464, hostStatusUrl: 'http://host.test/monitoring', accountId: 'a'.repeat(32),
    d1DatabaseId: '11111111-2222-3333-4444-555555555555', workerScript: 'tubepulse-api', tokenFile,
    snapshotDir: path.join(root, 'snapshots'), stateFile: path.join(root, 'collector', 'state.json'),
    cadenceMs: 300_000, analyticsDelayMs: 600_000, retentionDays: 1095,
    limits: { d1RowsWritten: 100000, d1RowsRead: 5000000, workerRequests: 100000 },
  };
  const start = Date.parse('2026-10-10T11:06:00Z');
  let collector = createCollector({ config, fetchImpl, now: () => start });
  const observed = [];
  for (let index = 0; index < totals.length; index++) {
    if (index === 4) collector = createCollector({ config, fetchImpl, now: () => start + index * 300_000 });
    const result = await collector.collect(start + index * 300_000);
    observed.push({
      accepted: result.snapshot.host.notifications.fcmAcceptedInterval,
      failed: result.snapshot.host.notifications.fcmFailedInterval,
      hostSuccess: result.snapshot.collection.hostSuccess,
    });
  }

  assert.deepEqual(observed, [
    { accepted: 0, failed: 0, hostSuccess: true }, // new counters begin at zero
    { accepted: 1, failed: 0, hostSuccess: true },
    { accepted: 3, failed: 1, hostSuccess: true },
    { accepted: 0, failed: 0, hostSuccess: false }, // never repeat the previous interval
    { accepted: 2, failed: 0, hostSuccess: true }, // catch up across the failed collection and restart
    { accepted: 0, failed: 0, hostSuccess: true }, // reset is not a large false increase
    { accepted: 2, failed: 1, hostSuccess: true },
  ]);
  assert.equal(observed.reduce((sum, item) => sum + item.accepted, 0), 8);
  assert.equal(observed.reduce((sum, item) => sum + item.failed, 0), 2);
});

test('D1 queue and transaction activity become actionable only after consecutive successful collector samples', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tubepulse-collector-pending-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, 'token.txt');
  fs.writeFileSync(tokenFile, 'test-token');
  let pendingBackupKeys = 10;
  let transactionActive = true;
  const fetchImpl = async (url) => {
    if (String(url).includes('host.test')) {
      return jsonResponse({ privacy: 'aggregate-only', authority: { pendingBackupKeys, transactionActive } });
    }
    return jsonResponse({ data: { viewer: { accounts: [{
      workerWindow: [], workerDay: [], d1Window: [], d1Day: [], d1Storage: [],
      doInvocationsWindow: [], doInvocationsDay: [], doPeriodicWindow: [], doPeriodicDay: [], doStorage: [],
    }] } } });
  };
  const config = {
    port: 9464, hostStatusUrl: 'http://host.test/monitoring', accountId: 'a'.repeat(32),
    d1DatabaseId: '11111111-2222-3333-4444-555555555555', workerScript: 'tubepulse-api', tokenFile,
    snapshotDir: path.join(root, 'snapshots'), stateFile: path.join(root, 'collector', 'state.json'),
    cadenceMs: 300_000, analyticsDelayMs: 600_000, retentionDays: 1095,
    limits: { d1RowsWritten: 100000, d1RowsRead: 5000000, workerRequests: 100000 },
  };
  const firstTime = Date.parse('2026-10-08T05:00:00Z');
  const collector = createCollector({ config, fetchImpl, now: () => firstTime });

  await collector.collect(firstTime);
  assert.match(collector.metrics(), /tubepulse_authority_pending_backup_keys 10/);
  assert.match(collector.metrics(), /tubepulse_authority_pending_backup_consecutive_samples 1/);
  assert.match(collector.metrics(), /tubepulse_authority_transaction_active_consecutive_samples 1/);

  const restarted = createCollector({ config, fetchImpl, now: () => firstTime + 300_000 });
  await restarted.collect(firstTime + 300_000);
  assert.match(restarted.metrics(), /tubepulse_authority_pending_backup_consecutive_samples 2/);
  assert.match(restarted.metrics(), /tubepulse_authority_transaction_active_consecutive_samples 2/);

  pendingBackupKeys = 0;
  transactionActive = false;
  await restarted.collect(firstTime + 600_000);
  assert.match(restarted.metrics(), /tubepulse_authority_pending_backup_keys 0/);
  assert.match(restarted.metrics(), /tubepulse_authority_pending_backup_consecutive_samples 0/);
  assert.match(restarted.metrics(), /tubepulse_authority_transaction_active_consecutive_samples 0/);
});
