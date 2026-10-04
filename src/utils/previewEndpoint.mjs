import {
  createEndpointPolicy,
  DEFAULT_TUBEPULSE_API_URL,
} from './apiEndpointPolicy.mjs';

export const PREVIEW_ORIGIN_STORAGE_KEY = 'tubepulse_preview_api_origin_v1';

function normalizedHostname(parsed) {
  return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

export function isLanHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (!host.includes('.') && !host.includes(':')) return true;
  if (isPrivateIpv4(host)) return true;
  return host === '::1'
    || /^f[cd][0-9a-f]*:/i.test(host)
    || /^fe[89ab][0-9a-f]*:/i.test(host);
}

/**
 * Validate and normalize a TubePulse Home base URL.
 *
 * Preview builds may use plain HTTP only for a loopback/private/LAN host.
 * Public endpoints (including Cloudflare Tunnel hostnames) must use HTTPS.
 */
export function normalizePreviewOrigin(value, { allowLanHttp = true } = {}) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Enter the TubePulse Home URL.');

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('Enter an absolute URL beginning with http:// or https://.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('The server URL must use http:// or https://.');
  }
  if (!parsed.hostname) throw new Error('The server URL must include a host.');
  if (parsed.username || parsed.password) throw new Error('Do not include credentials in the server URL.');
  if (parsed.search) throw new Error('Do not include a query string in the server URL.');
  if (parsed.hash) throw new Error('Do not include a fragment in the server URL.');

  if (parsed.protocol === 'http:' && (!allowLanHttp || !isLanHostname(normalizedHostname(parsed)))) {
    throw new Error('Use HTTPS for public servers. Plain HTTP is only allowed for a LAN address in TubePulse Preview.');
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

export async function testTubePulseHomeOrigin(
  value,
  {
    fetchImpl = globalThis.fetch,
    allowLanHttp = true,
    timeoutMs = 5000,
    retryDelaysMs = [600],
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  let origin;
  try {
    origin = normalizePreviewOrigin(value, { allowLanHttp });
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const attemptProbe = async () => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(`${origin}/`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) {
        return {
          result: { ok: false, origin, error: `TubePulse Home returned HTTP ${response.status}.` },
          retryable: response.status === 408
            || response.status === 425
            || response.status === 429
            || response.status >= 500,
        };
      }
      const body = await response.json().catch(() => null);
      if (body?.status !== 'ok' || body?.worker !== 'tubepulse-api') {
        return {
          result: { ok: false, origin, error: 'The server responded, but it is not a compatible TubePulse Home.' },
          // A 200 whose body was lost/truncated on the first Android LAN
          // request is transient; a genuinely incompatible server will fail
          // the same validation again after this one bounded retry.
          retryable: true,
        };
      }
      return { result: { ok: true, origin, version: body.version || null }, retryable: false };
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      return {
        result: {
          ok: false,
          origin,
          error: timedOut
            ? 'Connection timed out. Check the address and that TubePulse Home is running.'
            : 'Could not connect. Check the address, network, and TubePulse Home status.',
        },
        retryable: true,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : [];
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) await sleep(delays[attempt - 1]);
    const outcome = await attemptProbe();
    if (outcome.result.ok || !outcome.retryable || attempt >= delays.length) {
      return outcome.result;
    }
  }
}

export function createRuntimeEndpointResolver({
  preview,
  storage,
  productionPrimaryUrl = DEFAULT_TUBEPULSE_API_URL,
  productionFallbackUrl = '',
}) {
  const productionPolicy = createEndpointPolicy({
    primaryUrl: productionPrimaryUrl,
    fallbackUrl: productionFallbackUrl,
  });
  let previewOrigin;
  let previewOriginLoaded = false;

  async function getPreviewOrigin() {
    if (!preview) return null;
    if (!previewOriginLoaded) {
      const stored = await storage.getItem(PREVIEW_ORIGIN_STORAGE_KEY);
      try {
        previewOrigin = stored ? normalizePreviewOrigin(stored) : '';
      } catch {
        previewOrigin = '';
      }
      previewOriginLoaded = true;
    }
    return previewOrigin || null;
  }

  return {
    isPreview: preview === true,
    async getPreviewOrigin() {
      return await getPreviewOrigin();
    },
    async setPreviewOrigin(value) {
      if (!preview) throw new Error('Preview server configuration is unavailable in the production app.');
      const normalized = normalizePreviewOrigin(value);
      await storage.setItem(PREVIEW_ORIGIN_STORAGE_KEY, normalized);
      previewOrigin = normalized;
      previewOriginLoaded = true;
      return normalized;
    },
    async endpointPolicy() {
      if (!preview) return productionPolicy;
      const origin = await getPreviewOrigin();
      if (!origin) {
        const error = new Error('Choose and test a TubePulse Preview server before continuing.');
        error.code = 'PREVIEW_ENDPOINT_NOT_CONFIGURED';
        throw error;
      }
      return createEndpointPolicy({ primaryUrl: origin, fallbackUrl: '' });
    },
    reset() {
      if (!preview) productionPolicy.reset();
    },
  };
}
