const HEALTHY_PROGRESS_AGE_MS = 11 * 60 * 1000;
const OUTAGE_PROGRESS_AGE_MS = 16 * 60 * 1000;
const HEALTHY_BARRIERS = new Set(['passed', 'not-required', 'not-needed']);
const ISOLATED_FEED_BLOCKED_LIMIT = 2;
const ISOLATED_FEED_AGE_LIMIT_SECONDS = 15 * 60;

function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function response(status, observedAt, since = null) {
  const messages = {
    healthy: 'Notifications are operating normally',
    degraded: 'Notifications may be delayed',
    outage: 'Notification service is unavailable',
    unknown: 'Service status is unavailable',
  };
  return { status, message: messages[status], observedAt, since };
}

export function latestSchedulerProgressTimestamp(scheduler) {
  const candidates = [
    scheduler?.youtubeDataApi?.lastGoodAt,
    scheduler?.youtubeDataApi?.lastCycle?.finishedAt,
    scheduler?.lastSweep?.finishedAt,
    scheduler?.lastSweep?.scheduledAt,
    scheduler?.lastMinuteJobs?.scheduledAt,
    scheduler?.lastNotificationDelivery?.barrier
      ? scheduler?.lastNotificationDelivery?.observedAt
      : null,
    scheduler?.startedAt,
  ].map(timestamp).filter((value) => value !== null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function unsupersededSchedulerError(scheduler, progressAt) {
  const errorAt = timestamp(scheduler?.lastError?.at);
  return Boolean(scheduler?.lastError)
    && (errorAt === null || progressAt === null || errorAt >= progressAt);
}

export function classifyNotificationBarrier(scheduler) {
  const delivery = scheduler?.lastNotificationDelivery;
  if (!delivery?.barrier || HEALTHY_BARRIERS.has(delivery.barrier)) return 'healthy';
  if (delivery.reason !== 'feed-not-visible') return 'outage';

  const intents = scheduler?.notificationIntents || {};
  const blocked = Number(delivery.visibilityBlocked);
  const devices = Number(delivery.visibilityDevices);
  const channels = Number(delivery.visibilityChannels);
  const overdue = Number(intents.overduePending || 0);
  const oldestAge = Number(intents.oldestPendingAgeSeconds || 0);
  const bounded = Number.isFinite(blocked) && blocked > 0 && blocked <= ISOLATED_FEED_BLOCKED_LIMIT
    && Number.isFinite(devices) && devices > 0 && devices <= 1
    && Number.isFinite(channels) && channels > 0 && channels <= 1
    && overdue <= ISOLATED_FEED_BLOCKED_LIMIT
    && oldestAge <= ISOLATED_FEED_AGE_LIMIT_SECONDS;
  return bounded ? 'degraded' : 'outage';
}

function notificationAttention(scheduler) {
  const intents = scheduler?.notificationIntents || {};
  const overdue = Number.isFinite(Number(intents.overduePending))
    ? positive(intents.overduePending)
    : false;
  return overdue
    || positive(intents.sending)
    || positive(intents.callbackPending)
    || positive(intents.failed);
}

export function classifyPublicServiceStatus(localStatus, { nowMs = Date.now() } = {}) {
  const observedAt = new Date(nowMs).toISOString();
  const scheduler = localStatus?.scheduler || {};
  const authority = localStatus?.authority || {};
  const configuration = localStatus?.configuration || {};
  const progressAt = latestSchedulerProgressTimestamp(scheduler);

  const capabilityUnavailable = localStatus?.status !== 'ready'
    || localStatus?.mode !== 'active'
    || authority?.replication?.status !== 'current'
    || scheduler?.mode !== 'active'
    || scheduler?.lease?.state !== 'held'
    || configuration.notificationsEnabled !== true
    || configuration.alignedVideoNotificationsEnabled !== true;
  if (capabilityUnavailable) {
    const sinceAt = timestamp(authority?.replication?.changedAt)
      ?? timestamp(scheduler?.startedAt)
      ?? nowMs;
    return response('outage', observedAt, new Date(Math.min(nowMs, sinceAt)).toISOString());
  }

  if (unsupersededSchedulerError(scheduler, progressAt)) {
    const sinceAt = timestamp(scheduler?.lastError?.at) ?? progressAt ?? nowMs;
    return response('outage', observedAt, new Date(Math.min(nowMs, sinceAt)).toISOString());
  }

  const barrierStatus = classifyNotificationBarrier(scheduler);
  if (barrierStatus === 'outage') {
    const sinceAt = timestamp(scheduler?.lastNotificationDelivery?.observedAt) ?? progressAt ?? nowMs;
    return response('outage', observedAt, new Date(Math.min(nowMs, sinceAt)).toISOString());
  }
  if (barrierStatus === 'degraded') {
    const sinceAt = timestamp(scheduler?.lastNotificationDelivery?.observedAt);
    return response('degraded', observedAt, sinceAt === null ? null : new Date(sinceAt).toISOString());
  }

  if (scheduler?.youtubeDataApi?.lastError
    || scheduler?.preciseLiveWatch?.degraded
    || notificationAttention(scheduler)) {
    return response('degraded', observedAt, timestamp(scheduler.preciseLiveWatch.lastPollAt)
      ? new Date(timestamp(scheduler.preciseLiveWatch.lastPollAt)).toISOString()
      : null);
  }

  if (progressAt === null) return response('degraded', observedAt, timestamp(scheduler?.startedAt)
    ? new Date(timestamp(scheduler.startedAt)).toISOString()
    : null);

  const progressAgeMs = Math.max(0, nowMs - progressAt);
  if (progressAgeMs >= OUTAGE_PROGRESS_AGE_MS) {
    return response('outage', observedAt, new Date(progressAt + OUTAGE_PROGRESS_AGE_MS).toISOString());
  }
  if (progressAgeMs >= HEALTHY_PROGRESS_AGE_MS) {
    return response('degraded', observedAt, new Date(progressAt + HEALTHY_PROGRESS_AGE_MS).toISOString());
  }
  return response('healthy', observedAt);
}

export const publicServiceStatusTestHelpers = {
  HEALTHY_PROGRESS_AGE_MS,
  OUTAGE_PROGRESS_AGE_MS,
  ISOLATED_FEED_BLOCKED_LIMIT,
  ISOLATED_FEED_AGE_LIMIT_SECONDS,
};
