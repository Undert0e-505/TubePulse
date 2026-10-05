import crypto from 'node:crypto';

export const RSS_COHORT_COUNT = 5;
export const PACIFIC_TIME_ZONE = 'America/Los_Angeles';
export const RSS_HEALTH_POLICY_VERSION = 2;
export const YOUTUBE_DAILY_REQUEST_LIMIT = 10_000;
export const RSS_PROBE_OFFICIAL_CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';

export function rssNextMinuteSchedule(nowMs, nextConfirmationAt = null) {
  const scheduledTime = Math.floor(nowMs / 60_000) * 60_000 + 60_000;
  const dueAt = Date.parse(nextConfirmationAt || '');
  // Wait before acquiring any publication/mutation lease. Only a small
  // boundary skew is allowed; longer spacing defers to the following tick.
  const runAt = Number.isFinite(dueAt) && dueAt > scheduledTime && dueAt <= scheduledTime + 5_000
    ? dueAt : scheduledTime;
  return { scheduledTime, runAt };
}

export function validateIndependentRssProbe(result, activeChannelId) {
  const invalid = { outcome: 'inconclusive', probes: [], errorCategory: 'invalid-probe-response' };
  const expectedLabels = activeChannelId && activeChannelId !== RSS_PROBE_OFFICIAL_CHANNEL_ID
    ? ['official', 'active'] : ['official'];
  if (result?.ok !== true || !['success', 'failure'].includes(result.outcome)
    || !Array.isArray(result.probes) || result.probes.length !== expectedLabels.length) return invalid;
  const probes = [];
  for (const label of expectedLabels) {
    const matches = result.probes.filter((entry) => entry?.label === label);
    if (matches.length !== 1) return invalid;
    const { status, validXml, classification } = matches[0];
    const httpStatus = Number.isInteger(status) && status >= 200 && status <= 599;
    const good = classification === 'valid-feed' && validXml === true && httpStatus && status < 300;
    const failed = validXml === false && (
      (['network', 'timeout'].includes(classification) && status === null)
      || (classification === 'redirect' && httpStatus && status >= 300 && status < 400)
      || (classification === 'invalid-xml' && httpStatus && status < 300)
      || (classification === 'response-too-large' && httpStatus)
      || (httpStatus && status >= 400 && classification === `http-${status}`)
    );
    if (!good && !failed) return invalid;
    probes.push({ label, status, validXml, classification });
  }
  const outcome = probes.some((probe) => probe.validXml) ? 'success' : 'failure';
  return outcome === result.outcome ? { outcome, probes } : invalid;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function rssCycleNumber(scheduledTime) {
  return Math.floor(Number(scheduledTime) / 300_000);
}

export function deterministicRssOrder(activeChannels, cycleNumber) {
  const channels = [...new Set(activeChannels || [])].sort();
  if (channels.length < 2) return channels;
  const base = [...channels].sort((left, right) => hash(`base:${left}`).localeCompare(hash(`base:${right}`)) || left.localeCompare(right));
  const first = base[((cycleNumber % base.length) + base.length) % base.length];
  const rest = channels
    .filter((channelId) => channelId !== first)
    .sort((left, right) => hash(`${cycleNumber}:${left}`).localeCompare(hash(`${cycleNumber}:${right}`)) || left.localeCompare(right));
  return [first, ...rest];
}

export function balancedRssCohorts(activeChannels, cycleNumber, count = RSS_COHORT_COUNT) {
  const order = deterministicRssOrder(activeChannels, cycleNumber);
  const cohorts = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    const size = Math.floor(order.length / count) + (index < order.length % count ? 1 : 0);
    cohorts.push(order.slice(offset, offset + size));
    offset += size;
  }
  return cohorts;
}

export function rssCohortForMinute(activeChannels, scheduledTime) {
  const cycle = rssCycleNumber(scheduledTime);
  const slot = ((Math.floor(Number(scheduledTime) / 60_000) % RSS_COHORT_COUNT) + RSS_COHORT_COUNT) % RSS_COHORT_COUNT;
  const cohorts = balancedRssCohorts(activeChannels, cycle);
  return { cycle, slot, order: cohorts.flat(), channels: cohorts[slot], cohorts };
}

function pacificDayKey(nowMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function findDayBoundary(nowMs, direction) {
  const key = pacificDayKey(nowMs);
  let inside = nowMs;
  let outside = nowMs;
  const step = direction * 3_600_000;
  for (let index = 0; index < 30 && pacificDayKey(outside) === key; index++) outside += step;
  let low = Math.min(inside, outside);
  let high = Math.max(inside, outside);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const same = pacificDayKey(middle) === key;
    if (direction > 0) {
      if (same) low = middle; else high = middle;
    } else if (same) high = middle; else low = middle;
  }
  return high;
}

export function pacificQuotaWindow(nowMs = Date.now()) {
  const startedAtMs = findDayBoundary(nowMs, -1);
  const resetsAtMs = findDayBoundary(nowMs, 1);
  return {
    day: pacificDayKey(nowMs),
    startedAt: new Date(startedAtMs).toISOString(),
    resetsAt: new Date(resetsAtMs).toISOString(),
    durationHours: (resetsAtMs - startedAtMs) / 3_600_000,
  };
}

export function fallbackQuotaPlan({
  channelCount,
  dailyQuotaUnits,
  reserveUnits,
  postsCadenceMinutes,
  explicitDailyCap = null,
}) {
  dailyQuotaUnits = Math.min(YOUTUBE_DAILY_REQUEST_LIMIT, dailyQuotaUnits);
  reserveUnits = Math.max(1_000, reserveUnits);
  const postsProjection = channelCount * (1440 / postsCadenceMinutes);
  const calculatedAvailable = Math.max(0, Math.floor(dailyQuotaUnits - reserveUnits - postsProjection));
  const dailyCap = explicitDailyCap === null
    ? calculatedAvailable
    : Math.max(0, Math.min(calculatedAvailable, Math.floor(explicitDailyCap)));
  const budgetCoverageMinutes = dailyCap > 0 ? Math.ceil(channelCount * 1440 / dailyCap) : null;
  const coverageMinutes = channelCount === 0
    ? 60
    : dailyCap === 0
      ? null
      : Math.max(60, Math.ceil(channelCount / 2), budgetCoverageMinutes);
  return {
    unitCostPerRequest: 1,
    postsProjection,
    reserveUnits,
    dailyQuotaUnits,
    dailyCap,
    requestLimit: Math.min(YOUTUBE_DAILY_REQUEST_LIMIT, dailyCap),
    quotaUnitLimit: Math.min(YOUTUBE_DAILY_REQUEST_LIMIT, dailyCap),
    coverageMinutes,
    requestsPerCoverage: channelCount,
    projectedDailyRequests: coverageMinutes ? Math.ceil(channelCount * 1440 / coverageMinutes) : 0,
  };
}

export function fallbackChannelsForMinute(activeChannels, scheduledTime, coverageMinutes) {
  const channels = [...new Set(activeChannels || [])].sort();
  if (channels.length === 0 || !Number.isInteger(coverageMinutes) || coverageMinutes <= 0) return [];
  const minute = Math.floor(Number(scheduledTime) / 60_000);
  const epoch = Math.floor(minute / coverageMinutes);
  const slot = ((minute % coverageMinutes) + coverageMinutes) % coverageMinutes;
  const order = deterministicRssOrder(channels, epoch);
  const start = Math.floor(slot * order.length / coverageMinutes);
  const end = Math.floor((slot + 1) * order.length / coverageMinutes);
  return order.slice(start, end);
}

export function sameFleetOutage(results, channelCount) {
  if (!Array.isArray(results) || channelCount <= 0 || results.length !== channelCount) return null;
  if (results.some((entry) => entry.outcome !== 'error' || !entry.errorCategory)) return null;
  const categories = new Set(results.map((entry) => entry.errorCategory));
  return categories.size === 1 ? [...categories][0] : null;
}

export function freshRssHealthState(nowMs = Date.now()) {
  const quota = pacificQuotaWindow(nowMs);
  return {
    policyVersion: RSS_HEALTH_POLICY_VERSION,
    sourceMode: 'rss',
    lastGoodRssAt: null,
    lastGoodApiAt: null,
    requestCount: 0,
    attemptCount: 0,
    skippedCount: 0,
    currentCycle: null,
    circuit: {
      open: false,
      reason: null,
      outageClass: null,
      openedAt: null,
      until: null,
      cooldownMinutes: 15,
      recoverySuccesses: 0,
    },
    independentProbe: {
      lastAt: null,
      outcome: null,
      official: null,
      active: null,
      unavailableStreak: 0,
      firstUnavailableAt: null,
      lastUnavailableAt: null,
      nextConfirmationAt: null,
      confirmedAt: null,
      confirmationPending: false,
    },
    fallback: {
      quotaDay: quota.day,
      quotaUsed: 0,
      quotaLimit: 0,
      quotaUnitsUsed: 0,
      quotaUnitLimit: 0,
      resetsAt: quota.resetsAt,
      requests: 0,
      requestLimit: YOUTUBE_DAILY_REQUEST_LIMIT,
      failures: 0,
      skipped: 0,
      coverageMinutes: null,
      lastError: null,
    },
  };
}

export function normalizeRssHealthState(value, nowMs = Date.now()) {
  const fresh = freshRssHealthState(nowMs);
  if (!value || typeof value !== 'object') return fresh;
  const normalized = {
    ...fresh,
    ...value,
    policyVersion: RSS_HEALTH_POLICY_VERSION,
    circuit: { ...fresh.circuit, ...(value.circuit || {}) },
    independentProbe: { ...fresh.independentProbe, ...(value.independentProbe || {}) },
    fallback: { ...fresh.fallback, ...(value.fallback || {}) },
  };
  normalized.fallback.quotaUnitsUsed = Number.isFinite(Number(value.fallback?.quotaUnitsUsed))
    ? Math.max(0, Number(value.fallback.quotaUnitsUsed))
    : Math.max(0, Number(value.fallback?.quotaUsed || 0));
  // Keep the original fields as status/API compatibility aliases while all
  // enforcement uses the explicitly named quota-unit counter.
  normalized.fallback.quotaUsed = normalized.fallback.quotaUnitsUsed;
  normalized.fallback.requests = Number.isFinite(Number(value.fallback?.requests))
    ? Math.max(0, Number(value.fallback.requests)) : normalized.fallback.quotaUnitsUsed;

  if (Number(value.policyVersion || 0) < RSS_HEALTH_POLICY_VERSION
    && normalized.circuit.open
    && normalized.sourceMode === 'rss-probe-inconclusive') {
    // Version 1 collapsed Cloudflare subrequest rejection into an ambiguous
    // probe result. Promptly obtain fresh version-2 evidence after rollout;
    // the regular scheduler lease and state file still serialize this path.
    normalized.independentProbe = {
      ...normalized.independentProbe,
      unavailableStreak: 0,
      firstUnavailableAt: null,
      lastUnavailableAt: null,
      nextConfirmationAt: new Date(nowMs).toISOString(),
      confirmedAt: null,
      confirmationPending: true,
    };
    normalized.circuit.until = new Date(nowMs).toISOString();
  }
  return normalized;
}
