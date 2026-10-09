import { pacificQuotaWindow } from './youtube-data-api.mjs';

export const PRECISE_LIVE_WATCH_BEFORE_MS = 5 * 60 * 1000;
export const PRECISE_LIVE_WATCH_AFTER_MS = 15 * 60 * 1000;
export const PRECISE_LIVE_WATCH_CADENCE_MS = 10 * 1000;
export const ORDINARY_LIVE_WATCH_CADENCE_MS = 5 * 60 * 1000;

function validTime(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function eventKey(event) {
  return String(event?.videoId || '');
}

export function normalizePreciseLiveWatchState(value, nowMs = Date.now()) {
  const state = value && typeof value === 'object' ? structuredClone(value) : {};
  const window = pacificQuotaWindow(nowMs);
  state.watchers = state.watchers && typeof state.watchers === 'object' ? state.watchers : {};
  state.quota = state.quota?.day === window.day
    ? {
      day: window.day,
      resetsAt: window.resetsAt,
      requests: Math.max(0, Number(state.quota.requests || 0)),
      units: Math.max(0, Number(state.quota.units || 0)),
      failures: Math.max(0, Number(state.quota.failures || 0)),
    }
    : { day: window.day, resetsAt: window.resetsAt, requests: 0, units: 0, failures: 0 };
  for (const field of ['transitions', 'cancellations', 'completed', 'timeouts', 'reschedules']) {
    state[field] = Math.max(0, Number(state[field] || 0));
  }
  state.activeWatcherCount = Math.max(0, Number(state.activeWatcherCount || 0));
  state.inWindowCount = Math.max(0, Number(state.inWindowCount || 0));
  state.lastPollAt ||= null;
  state.lastOutcome ||= null;
  state.lastTriggerReason = ['actual-start-time', 'live-broadcast-content', 'both'].includes(state.lastTriggerReason)
    ? state.lastTriggerReason
    : null;
  state.nextWindowAt ||= null;
  state.degraded = Boolean(state.degraded);
  state.degradedReason ||= null;
  return state;
}

export function publicPreciseLiveWatchState(value, nowMs = Date.now()) {
  const state = normalizePreciseLiveWatchState(value, nowMs);
  return {
    enabledAt: state.enabledAt || null,
    activeWatcherCount: state.activeWatcherCount,
    inWindowCount: state.inWindowCount,
    lastPollAt: state.lastPollAt,
    lastOutcome: state.lastOutcome,
    lastTriggerReason: state.lastTriggerReason,
    transitions: state.transitions,
    cancellations: state.cancellations,
    completed: state.completed,
    timeouts: state.timeouts,
    reschedules: state.reschedules,
    quota: state.quota,
    degraded: state.degraded,
    degradedReason: state.degradedReason,
  };
}

export function planPreciseLiveWatch(events, watchState, nowMs, { ordinaryFallback = false } = {}) {
  const state = normalizePreciseLiveWatchState(watchState, nowMs);
  const due = [];
  let inWindowCount = 0;
  let nextWindowAt = null;
  let timeoutCount = 0;

  for (const event of Array.isArray(events) ? events : []) {
    const videoId = eventKey(event);
    const scheduledFor = validTime(event?.scheduledFor);
    if (!videoId || !event?.channelId || scheduledFor === null) continue;
    const watcher = state.watchers[videoId] || {};
    const windowStart = scheduledFor - PRECISE_LIVE_WATCH_BEFORE_MS;
    const windowEnd = scheduledFor + PRECISE_LIVE_WATCH_AFTER_MS;
    const lastPolledAt = validTime(watcher.lastPolledAt);

    if (nowMs < windowStart) {
      nextWindowAt = nextWindowAt === null ? windowStart : Math.min(nextWindowAt, windowStart);
      continue;
    }
    if (nowMs <= windowEnd) {
      inWindowCount++;
      if (lastPolledAt === null || nowMs - lastPolledAt >= PRECISE_LIVE_WATCH_CADENCE_MS) {
        due.push({ ...event, scheduledFor, cadence: 'precise' });
      }
      continue;
    }

    if (Number(watcher.timedOutFor || 0) !== scheduledFor) timeoutCount++;
    if (ordinaryFallback
      && (lastPolledAt === null || nowMs - lastPolledAt >= ORDINARY_LIVE_WATCH_CADENCE_MS)) {
      due.push({ ...event, scheduledFor, cadence: 'ordinary' });
    }
  }

  return { due, inWindowCount, nextWindowAt, timeoutCount };
}

export function classifyPublicLiveObservation(item, event) {
  if (!item) return { outcome: 'cancellation-like', reason: 'missing-item' };
  const details = item.liveStreamingDetails || {};
  const snippet = item.snippet || {};
  const status = item.status || {};
  const actualStartTime = validTime(details.actualStartTime);
  const actualEndTime = validTime(details.actualEndTime);
  const scheduledStartTime = validTime(details.scheduledStartTime);

  // A completed event that was never observed live must not manufacture a
  // late live-now notification merely because actualStartTime is also present.
  if (actualEndTime !== null) {
    return { outcome: 'completed', actualStartTime, actualEndTime, scheduledStartTime };
  }
  const broadcastSaysLive = snippet.liveBroadcastContent === 'live';
  if (actualStartTime !== null || broadcastSaysLive) {
    return {
      outcome: 'live',
      actualStartTime,
      scheduledStartTime,
      triggerReason: actualStartTime !== null && broadcastSaysLive
        ? 'both'
        : actualStartTime !== null ? 'actual-start-time' : 'live-broadcast-content',
    };
  }
  if (status.privacyStatus && status.privacyStatus !== 'public') {
    return { outcome: 'cancellation-like', reason: 'not-public' };
  }
  if (['deleted', 'failed', 'rejected'].includes(String(status.uploadStatus || '').toLowerCase())) {
    return { outcome: 'cancellation-like', reason: 'terminal-upload-status' };
  }
  if (snippet.liveBroadcastContent === 'upcoming' && scheduledStartTime !== null) {
    return scheduledStartTime !== Number(event.scheduledFor)
      ? { outcome: 'rescheduled', scheduledStartTime }
      : { outcome: 'upcoming', scheduledStartTime };
  }
  return { outcome: 'cancellation-like', reason: 'lost-upcoming-metadata' };
}

export function advanceCancellationObservation(watcher, observation) {
  const next = watcher && typeof watcher === 'object' ? { ...watcher } : {};
  if (observation?.outcome === 'api-error') return { watcher: next, terminal: false };
  if (observation?.outcome === 'cancellation-like') {
    next.consecutiveCancellation = Math.max(0, Number(next.consecutiveCancellation || 0)) + 1;
    return { watcher: next, terminal: next.consecutiveCancellation >= 2 };
  }
  next.consecutiveCancellation = 0;
  return { watcher: next, terminal: false };
}

export function nextTenSecondBoundary(nowMs = Date.now()) {
  return Math.floor(nowMs / PRECISE_LIVE_WATCH_CADENCE_MS) * PRECISE_LIVE_WATCH_CADENCE_MS
    + PRECISE_LIVE_WATCH_CADENCE_MS;
}

export function shouldRunPreciseLiveWatchCycle({ preciseLiveOnly, scheduledTime }) {
  return Boolean(preciseLiveOnly) || Math.floor(scheduledTime / 60_000) % 5 === 0;
}

export function chunkLiveWatchEvents(events, size = 50) {
  const chunks = [];
  for (let index = 0; index < events.length; index += size) chunks.push(events.slice(index, index + size));
  return chunks;
}

export function liveWatchRequestPriority({ ordinaryFallback, precisionUnits, precisionDailyCap }) {
  return ordinaryFallback && Number(precisionUnits) >= Number(precisionDailyCap)
    ? 'scheduled-live-fallback'
    : 'live-watch';
}
