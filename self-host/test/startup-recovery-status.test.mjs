import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  evaluateStartupRecoverySupersession,
  readStartupRecoveryStatus,
  supersedeFailedStartupRecovery,
} from '../src/startup-recovery-status.mjs';

test('startup recovery status is privacy-safe and distinguishes in-progress from passed', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-startup-status-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await readStartupRecoveryStatus(directory), { status: 'not-managed' });
  const file = path.join(directory, 'startup-recovery-timeline.json');
  await fs.writeFile(file, JSON.stringify({
    retentionDays: 7,
    current: {
      outcome: 'running', phase: 'signed-stability-check',
      startedAt: '2026-11-21T03:00:00Z',
      deviceId: 'must-not-leak',
      events: [{ channelId: 'must-not-leak' }],
    },
    history: [{ outcome: 'succeeded' }],
  }));
  assert.deepEqual(await readStartupRecoveryStatus(directory), {
    status: 'in-progress', phase: 'signed-stability-check',
    startedAt: '2026-11-21T03:00:00.000Z', finishedAt: null,
    supersededAt: null, historicalOutcome: 'running',
    retentionDays: 7, retainedRuns: 1,
  });
  const payload = JSON.parse(await fs.readFile(file, 'utf8'));
  payload.current.outcome = 'succeeded';
  payload.current.phase = 'ready';
  payload.current.finishedAt = '2026-11-21T03:02:00Z';
  await fs.writeFile(file, JSON.stringify(payload));
  assert.equal((await readStartupRecoveryStatus(directory)).status, 'passed');
});

function cleanSupersessionEvidence(nowMs = Date.parse('2026-11-21T12:10:00Z')) {
  const cycleFinishedAt = '2026-11-21T12:05:10Z';
  return {
    nowMs,
    authority: {
      replication: { status: 'current', generation: 40 }, lease: null, transaction: null,
      manifest: { recordCount: 2431 },
    },
    remoteStatus: {
      ok: true, backend: { selected: 'd1', ready: true },
      replication: { status: 'current', generation: 50, recordCount: 2431 },
      lease: null, transaction: null, pendingBackupKeys: 0,
    },
    scheduler: {
      mode: 'active', lease: { state: 'held' }, currentSweep: null,
      youtubeDataApi: { lastGoodAt: cycleFinishedAt, lastCycle: { finishedAt: cycleFinishedAt } },
      lastError: { at: '2026-11-21T10:00:00Z' },
      lastNotificationDelivery: { barrier: 'not-needed', failed: 0, observedAt: '2026-11-21T12:05:12Z' },
      notificationIntents: { pending: 0, overduePending: 0, sending: 0, callbackPending: 0, failed: 0 },
      lastSweep: {
        publication: { pending: 0, conflicts: 0 },
        notificationPublication: { pending: 0, conflicts: 0 },
      },
    },
  };
}

test('later clean cycle and fresh signed idle authority proof supersede live failure without erasing history', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-startup-supersession-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'startup-recovery-timeline.json');
  const failed = {
    runId: 'safe-run-id', outcome: 'failed', phase: 'stability-timeout',
    startedAt: '2026-11-21T10:56:42Z', finishedAt: '2026-11-21T11:02:16Z',
    events: [{ at: '2026-11-21T11:02:16Z', phase: 'stability-timeout', outcome: 'failed' }],
  };
  await fs.writeFile(file, JSON.stringify({ retentionDays: 7, current: failed, history: [{ ...failed, events: undefined }] }));

  const status = await supersedeFailedStartupRecovery(directory, cleanSupersessionEvidence());
  assert.equal(status.status, 'superseded');
  assert.equal(status.historicalOutcome, 'failed');
  const timeline = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(timeline.current.outcome, 'failed', 'audit outcome must never be rewritten');
  assert.equal(timeline.history[0].outcome, 'failed');
  assert.equal(timeline.current.supersededReason, 'clean-post-failure-cycle-and-signed-authority-proof');
  assert.equal(timeline.current.supersededProof.recordCount, 2431);
  assert.equal(JSON.stringify(timeline.current.supersededProof).includes('device'), false);
});

test('supersession is refused for stale, pending, incomplete, overdue or dirty evidence', () => {
  const startupRecovery = {
    status: 'failed', startedAt: '2026-11-21T10:56:42Z', finishedAt: '2026-11-21T11:02:16Z',
  };
  const base = cleanSupersessionEvidence();
  const cases = [
    { ...base, authority: { ...base.authority, replication: { status: 'stale' } } },
    { ...base, remoteStatus: { ...base.remoteStatus, pendingBackupKeys: 1 } },
    { ...base, remoteStatus: { ...base.remoteStatus, transaction: { kind: 'scheduler' } } },
    { ...base, remoteStatus: { ...base.remoteStatus, replication: { ...base.remoteStatus.replication, recordCount: 999 } } },
    { ...base, remoteStatus: null },
    { ...base, scheduler: { ...base.scheduler, currentSweep: { status: 'running' } } },
    { ...base, nowMs: Date.parse('2026-11-21T12:20:11Z') },
    { ...base, scheduler: { ...base.scheduler, youtubeDataApi: { ...base.scheduler.youtubeDataApi, lastError: { at: '2026-11-21T12:05:09Z' } } } },
    { ...base, scheduler: { ...base.scheduler, notificationIntents: { ...base.scheduler.notificationIntents, overduePending: 1 } } },
    { ...base, scheduler: { ...base.scheduler, lastNotificationDelivery: { barrier: 'failed', failed: 0, observedAt: '2026-11-21T12:05:12Z' } } },
    { ...base, scheduler: { ...base.scheduler, lastNotificationDelivery: { barrier: 'passed', failed: 0, observedAt: '2026-11-21T12:05:09Z' } } },
    { ...base, scheduler: { ...base.scheduler, lastSweep: { ...base.scheduler.lastSweep, publication: { pending: 1, conflicts: 0 } } } },
    { ...base, scheduler: { ...base.scheduler, notificationIntents: { ...base.scheduler.notificationIntents, pending: 1 } } },
    { ...base, scheduler: { ...base.scheduler, lastNotificationDelivery: { ...base.scheduler.lastNotificationDelivery, barrier: 'failed' } } },
    { ...base, scheduler: { ...base.scheduler, lastSweep: { publication: { pending: 1 } } } },
  ];
  for (const evidence of cases) {
    assert.equal(evaluateStartupRecoverySupersession({ startupRecovery, ...evidence }).eligible, false);
  }
});
