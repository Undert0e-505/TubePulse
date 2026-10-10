export const SERVICE_STATUS_CACHE_KEY = 'tubepulse_service_status_v1';
export const SERVICE_STATUS_REFRESH_TTL_MS = 60 * 1000;
export const SERVICE_STATUS_MAX_OBSERVATION_AGE_MS = 16 * 60 * 1000;

export const SERVICE_STATUS_COPY = Object.freeze({
  healthy: 'Service healthy',
  degraded: 'Notifications may be delayed',
  outage: 'Notification service unavailable',
  unknown: 'Service status unavailable',
});

const PUBLIC_STATUSES = new Set(['healthy', 'degraded', 'outage', 'unknown']);

function validTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeServiceStatus(payload, {
  nowMs = Date.now(),
  checkedAt = nowMs,
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const rawStatus = PUBLIC_STATUSES.has(payload.status) ? payload.status : 'unknown';
  const observedAtMs = validTimestamp(payload.observedAt);
  const checkedAtMs = validTimestamp(checkedAt) ?? (Number.isFinite(Number(checkedAt)) ? Number(checkedAt) : nowMs);
  const stale = observedAtMs === null
    || observedAtMs > nowMs + 60_000
    || nowMs - observedAtMs > SERVICE_STATUS_MAX_OBSERVATION_AGE_MS;
  const status = stale ? 'unknown' : rawStatus;
  return {
    status,
    message: SERVICE_STATUS_COPY[status],
    observedAt: observedAtMs === null ? null : new Date(observedAtMs).toISOString(),
    since: validTimestamp(payload.since) === null ? null : new Date(validTimestamp(payload.since)).toISOString(),
    checkedAt: new Date(checkedAtMs).toISOString(),
  };
}

export function unavailableServiceStatus(previous, { nowMs = Date.now() } = {}) {
  const priorCheck = validTimestamp(previous?.checkedAt);
  return {
    status: 'unknown',
    message: SERVICE_STATUS_COPY.unknown,
    observedAt: null,
    since: null,
    checkedAt: new Date(priorCheck ?? nowMs).toISOString(),
  };
}

export function serviceStatusPresentation(value, { nowMs = Date.now() } = {}) {
  if (!value) {
    return {
      status: 'checking',
      label: '',
      freshness: '',
    };
  }
  const normalized = normalizeServiceStatus(value, { nowMs, checkedAt: value.checkedAt })
    || unavailableServiceStatus(value, { nowMs });
  const checkedAtMs = validTimestamp(normalized.checkedAt);
  const ageMs = checkedAtMs === null ? null : Math.max(0, nowMs - checkedAtMs);
  let age = 'now';
  if (ageMs !== null && ageMs >= 60 * 60 * 1000) age = `${Math.floor(ageMs / (60 * 60 * 1000))}h ago`;
  else if (ageMs !== null && ageMs >= 60 * 1000) age = `${Math.floor(ageMs / (60 * 1000))}m ago`;
  return {
    status: normalized.status,
    label: SERVICE_STATUS_COPY[normalized.status],
    freshness: `${normalized.status === 'unknown' ? 'Last checked' : 'Checked'} ${age}`,
  };
}

export function shouldRefreshServiceStatus(value, { nowMs = Date.now() } = {}) {
  const checkedAtMs = validTimestamp(value?.checkedAt);
  return checkedAtMs === null || nowMs - checkedAtMs >= SERVICE_STATUS_REFRESH_TTL_MS;
}

export async function readCachedServiceStatus(storage, { nowMs = Date.now() } = {}) {
  try {
    const parsed = JSON.parse(await storage.getItem(SERVICE_STATUS_CACHE_KEY));
    return normalizeServiceStatus(parsed, { nowMs, checkedAt: parsed?.checkedAt });
  } catch {
    return null;
  }
}

export async function writeCachedServiceStatus(storage, value) {
  await storage.setItem(SERVICE_STATUS_CACHE_KEY, JSON.stringify(value));
  return value;
}
