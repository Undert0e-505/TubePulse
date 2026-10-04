export const DEFAULT_TUBEPULSE_API_URL = 'https://tubepulse-api.jimothyoakley55.workers.dev';
export const FAILOVER_RETRYABLE_STATUSES = Object.freeze([429, 502, 503, 504]);

export function normalizeApiBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const parsed = new URL(text);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('TubePulse API URLs must use http or https');
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

export function isRetryableFailoverStatus(status) {
  return FAILOVER_RETRYABLE_STATUSES.includes(status);
}

export function createEndpointPolicy({ primaryUrl, fallbackUrl }) {
  const primary = normalizeApiBaseUrl(primaryUrl) || DEFAULT_TUBEPULSE_API_URL;
  const normalizedFallback = normalizeApiBaseUrl(fallbackUrl);
  const fallback = normalizedFallback && normalizedFallback !== primary ? normalizedFallback : '';
  let stickyFallback = false;

  return {
    get primaryUrl() { return primary; },
    get fallbackUrl() { return fallback; },
    get isFallbackSticky() { return stickyFallback; },
    targets() {
      if (stickyFallback && fallback) return [{ baseUrl: fallback, fallback: true }];
      return [
        { baseUrl: primary, fallback: false },
        ...(fallback ? [{ baseUrl: fallback, fallback: true }] : []),
      ];
    },
    markFallbackSuccess() {
      if (fallback) stickyFallback = true;
    },
    reset() {
      stickyFallback = false;
    },
  };
}

function requestInitForTarget(init, fallback) {
  const headers = new Headers(init?.headers || {});
  if (fallback) headers.set('X-TubePulse-Failover', '1');
  return { ...(init || {}), headers };
}

export async function fetchWithEndpointFailover({ policy, path, init, fetchImpl = globalThis.fetch }) {
  const targets = policy.targets();
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    const hasFallbackAttempt = !target.fallback && index + 1 < targets.length;
    try {
      const response = await fetchImpl(`${target.baseUrl}${path}`, requestInitForTarget(init, target.fallback));
      if (response.ok && target.fallback) policy.markFallbackSuccess();
      if (!response.ok && hasFallbackAttempt && isRetryableFailoverStatus(response.status)) continue;
      return response;
    } catch (error) {
      if (hasFallbackAttempt) continue;
      throw error;
    }
  }
  throw new Error('No TubePulse API endpoint was available');
}
