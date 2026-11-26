import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SAFE_PHASES = new Set([
  'startup-began', 'docker-ready', 'home-ready', 'tunnel-restarted', 'tunnel-registered',
  'signed-stability-check', 'coordinator-proof', 'post-restart-cycle', 'stability-gate',
  'reconciliation-evidence', 'ready', 'stability-timeout', 'coordinator-proof',
  'post-tunnel-restart-time-missing', 'exception',
]);

function safeTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const HEALTHY_BARRIERS = new Set(['passed', 'not-needed', 'not-required', 'shadow']);
const MAX_SOURCE_AGE_MS = 11 * 60 * 1000;

function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusFromTimeline(raw) {
  const current = raw?.current;
  if (!current || typeof current !== 'object') return { status: 'not-managed' };
  const outcome = ['running', 'succeeded', 'failed'].includes(current.outcome) ? current.outcome : 'unknown';
  const supersededAt = safeTimestamp(current.supersededAt);
  return {
    status: outcome === 'running'
      ? 'in-progress'
      : outcome === 'succeeded'
        ? 'passed'
        : outcome === 'failed' && supersededAt
          ? 'superseded'
          : outcome,
    phase: SAFE_PHASES.has(current.phase) ? current.phase : 'unknown',
    startedAt: safeTimestamp(current.startedAt),
    finishedAt: safeTimestamp(current.finishedAt),
    supersededAt,
    historicalOutcome: outcome === 'failed' ? 'failed' : outcome,
    retentionDays: Math.max(0, Math.min(30, Number(raw.retentionDays || 0))),
    retainedRuns: Math.max(0, Math.min(100, Array.isArray(raw.history) ? raw.history.length : 0)),
  };
}

async function readTimeline(dataDir) {
  return JSON.parse(await fs.readFile(path.join(dataDir, 'startup-recovery-timeline.json'), 'utf8'));
}

export async function readStartupRecoveryStatus(dataDir) {
  try {
    return statusFromTimeline(await readTimeline(dataDir));
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'not-managed' };
    return { status: 'unknown', phase: 'unreadable' };
  }
}

function newerSuccessfulProgress(scheduler, failedAt) {
  const cycleFinishedAt = timestamp(scheduler?.youtubeDataApi?.lastCycle?.finishedAt)
    ?? timestamp(scheduler?.lastSweep?.finishedAt);
  const sourceGoodAt = timestamp(scheduler?.youtubeDataApi?.lastGoodAt) ?? cycleFinishedAt;
  const deliveryAt = timestamp(scheduler?.lastNotificationDelivery?.observedAt);
  const errorAt = timestamp(scheduler?.lastError?.at);
  return {
    cycleFinishedAt,
    sourceGoodAt,
    deliveryAt,
    clean: cycleFinishedAt !== null && cycleFinishedAt > failedAt
      && sourceGoodAt !== null && sourceGoodAt >= cycleFinishedAt
      && deliveryAt !== null && deliveryAt >= cycleFinishedAt
      && (errorAt === null || errorAt < cycleFinishedAt),
  };
}

export function evaluateStartupRecoverySupersession({
  startupRecovery, authority, scheduler, remoteStatus, nowMs = Date.now(),
}) {
  if (startupRecovery?.status !== 'failed') return { eligible: false, reason: 'startup-not-failed' };
  const failedAt = timestamp(startupRecovery.finishedAt) ?? timestamp(startupRecovery.startedAt);
  if (failedAt === null) return { eligible: false, reason: 'failure-time-missing' };
  if (authority?.replication?.status !== 'current' || authority?.transaction || authority?.lease) {
    return { eligible: false, reason: 'local-authority-not-idle-current' };
  }
  if (remoteStatus?.ok !== true
    || remoteStatus?.backend?.selected !== 'd1'
    || remoteStatus?.backend?.ready !== true
    || remoteStatus?.replication?.status !== 'current'
    || remoteStatus?.transaction
    || remoteStatus?.lease
    || finite(remoteStatus?.pendingBackupKeys) !== 0) {
    return { eligible: false, reason: 'remote-authority-not-idle-current' };
  }
  const localRecords = finite(authority?.manifest?.recordCount);
  const remoteRecords = finite(remoteStatus?.replication?.recordCount);
  if (localRecords <= 0 || localRecords !== remoteRecords) {
    return { eligible: false, reason: 'authority-record-count-mismatch' };
  }
  if (scheduler?.mode !== 'active' || scheduler?.lease?.state !== 'held' || scheduler?.currentSweep) {
    return { eligible: false, reason: 'scheduler-not-idle-active' };
  }
  const progress = newerSuccessfulProgress(scheduler, failedAt);
  if (!progress.clean) return { eligible: false, reason: 'clean-post-failure-cycle-missing' };
  if (scheduler?.youtubeDataApi?.lastError || scheduler?.preciseLiveWatch?.degraded) {
    return { eligible: false, reason: 'source-health-not-clean' };
  }
  if (nowMs - progress.sourceGoodAt >= MAX_SOURCE_AGE_MS) {
    return { eligible: false, reason: 'source-progress-overdue' };
  }
  const delivery = scheduler?.lastNotificationDelivery || {};
  const intents = scheduler?.notificationIntents || {};
  if (!HEALTHY_BARRIERS.has(delivery.barrier)
    || finite(delivery.failed) !== 0
    || finite(intents.pending) !== 0
    || finite(intents.overduePending) !== 0
    || finite(intents.sending) !== 0
    || finite(intents.callbackPending) !== 0
    || finite(intents.failed) !== 0) {
    return { eligible: false, reason: 'notification-state-not-clean' };
  }
  for (const publication of [scheduler?.lastSweep?.publication, scheduler?.lastSweep?.notificationPublication]) {
    if (publication && (finite(publication.pending) !== 0 || finite(publication.conflicts) !== 0)) {
      return { eligible: false, reason: 'publication-not-settled' };
    }
  }
  const proofObservedAt = new Date(nowMs).toISOString();
  return {
    eligible: true,
    reason: 'clean-post-failure-cycle-and-signed-authority-proof',
    proof: {
      observedAt: proofObservedAt,
      cycleFinishedAt: new Date(progress.cycleFinishedAt).toISOString(),
      deliveryObservedAt: new Date(progress.deliveryAt).toISOString(),
      sourceGoodAt: new Date(progress.sourceGoodAt).toISOString(),
      localGeneration: Math.max(0, finite(authority?.replication?.generation)),
      remoteGeneration: Math.max(0, finite(remoteStatus?.replication?.generation)),
      recordCount: remoteRecords,
      pendingBackupKeys: 0,
    },
  };
}

export async function supersedeFailedStartupRecovery(dataDir, evidence) {
  let raw;
  try {
    raw = await readTimeline(dataDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'not-managed' };
    return { status: 'unknown', phase: 'unreadable' };
  }
  const startupRecovery = statusFromTimeline(raw);
  const decision = evaluateStartupRecoverySupersession({ startupRecovery, ...evidence });
  if (!decision.eligible) return { ...startupRecovery, supersessionPendingReason: decision.reason };

  const supersededAt = decision.proof.observedAt;
  raw.current.supersededAt = supersededAt;
  raw.current.supersededReason = decision.reason;
  raw.current.supersededProof = decision.proof;
  if (Array.isArray(raw.history)) {
    const retained = raw.history.find((entry) => entry?.runId && entry.runId === raw.current.runId);
    if (retained) {
      retained.supersededAt = supersededAt;
      retained.supersededReason = decision.reason;
      retained.supersededProof = decision.proof;
    }
  }
  const target = path.join(dataDir, 'startup-recovery-timeline.json');
  const temporary = `${target}.tmp-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temporary, JSON.stringify(raw), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return statusFromTimeline(raw);
}

export const startupRecoveryStatusTestHelpers = { MAX_SOURCE_AGE_MS };
