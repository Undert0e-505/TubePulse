const GATEWAY_VERSION = '1';
const HEADER_PREFIX = 'x-tubepulse-gateway-';
const STATE_PREFIX = 'gateway:canary:';
const SAFE_READS = new Set(['GET /feed']);
const SHADOW_MUTATIONS = new Set([
  'POST /register',
  'POST /subscribe-channel',
  'POST /unsubscribe',
  'POST /seen',
  'POST /bootstrap',
  'POST /settings',
  'POST /channel-override',
]);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const MAX_HOME_RESPONSE_BYTES = 2 * 1024 * 1024;
const PRIVATE_ROUTE_ERROR_CODES = [
  'connection_refused',
  'connection_terminated',
  'connection_timeout',
  'connection_limit_reached',
  'destination_unavailable',
  'destination_not_found',
  'destination_ip_prohibited',
  'destination_ip_unroutable',
  'proxy_loop_detected',
  'dns_error',
  'dns_timeout',
  'tls_protocol_error',
  'tls_certificate_error',
  'http_request_error',
  'http_upgrade_failed',
  'http_request_denied',
  'http_protocol_error',
  'http_response_incomplete',
  'connection_read_timeout',
  'connection_write_timeout',
  'rate_limited',
  'proxy_internal_error',
];

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function safeGatewayFailureReason(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (message === 'home-not-ready' || message === 'home-incompatible') return message;
  if (error?.name === 'AbortError' || /\babort(?:ed)?\b/i.test(message)) return 'timeout';
  const normalized = message.toLowerCase();
  const privateRouteCode = PRIVATE_ROUTE_ERROR_CODES.find((code) => normalized.includes(code));
  if (privateRouteCode) return privateRouteCode;
  if (error?.name === 'TypeError') return 'type-error';
  return 'unavailable';
}

function isLocalTestHostname(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized.endsWith('.localhost')) return true;
  if (/^127\./.test(normalized) || /^10\./.test(normalized) || /^192\.168\./.test(normalized)) return true;
  const match = /^172\.(\d{1,3})\./.exec(normalized);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function readConfig(env) {
  if (!enabled(env.TUBEPULSE_HOME_GATEWAY_ENABLED)) return { enabled: false };

  const fingerprint = String(env.TUBEPULSE_HOME_CANARY_SHA256 || '').trim().toLowerCase();
  const secret = String(env.TUBEPULSE_HOME_GATEWAY_SECRET || '');
  const transport = String(env.TUBEPULSE_HOME_GATEWAY_TRANSPORT || 'https').trim().toLowerCase();
  if (!['https', 'vpc'].includes(transport)) {
    return { enabled: true, valid: false, reason: 'invalid-transport' };
  }
  if (transport === 'vpc' && typeof env.TUBEPULSE_HOME_VPC?.fetch !== 'function') {
    return { enabled: true, valid: false, reason: 'missing-vpc-binding' };
  }
  let origin;
  try {
    origin = new URL(String(env.TUBEPULSE_HOME_ORIGIN || ''));
  } catch {
    return { enabled: true, valid: false, reason: 'invalid-origin' };
  }
  const allowLocalHttp = enabled(env.TUBEPULSE_HOME_GATEWAY_ALLOW_HTTP);
  const secureOrigin = origin.protocol === 'https:';
  const allowedLocalOrigin = origin.protocol === 'http:'
    && (transport === 'vpc' || (allowLocalHttp && isLocalTestHostname(origin.hostname)));
  if (!secureOrigin && !allowedLocalOrigin) return { enabled: true, valid: false, reason: 'insecure-origin' };
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) {
    return { enabled: true, valid: false, reason: 'invalid-origin' };
  }
  if (origin.pathname !== '/') return { enabled: true, valid: false, reason: 'origin-must-not-have-path' };
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return { enabled: true, valid: false, reason: 'invalid-fingerprint' };
  if (secret.length < 32) return { enabled: true, valid: false, reason: 'invalid-secret' };

  const requestedTimeout = Number(env.TUBEPULSE_HOME_GATEWAY_TIMEOUT_MS || 1500);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(100, Math.min(5000, Math.trunc(requestedTimeout)))
    : 1500;
  return {
    enabled: true,
    valid: true,
    origin: origin.origin,
    transport,
    fingerprint,
    secret,
    timeoutMs,
  };
}

function bearer(request) {
  const value = request.headers.get('Authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function bytes(value = '') {
  return new TextEncoder().encode(value);
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  const input = typeof value === 'string' ? bytes(value) : value;
  return hex(await crypto.subtle.digest('SHA-256', input));
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    bytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, bytes(value)));
}

function constantTimeHexEqual(left, right) {
  if (left.length !== 64 || right.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < 64; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function targetPath(request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function requestCanonical({ timestamp, requestId, operation, method, target, authorizationDigest, bodyDigest }) {
  return [
    'tubepulse-gateway-v1',
    String(timestamp),
    requestId,
    operation,
    method.toUpperCase(),
    target,
    authorizationDigest,
    bodyDigest,
  ].join('\n');
}

function reconciliationCanonical({ timestamp, requestId, fingerprint }) {
  return [
    'tubepulse-gateway-reconcile-v1',
    String(timestamp),
    requestId,
    fingerprint,
  ].join('\n');
}

function safeForwardHeaders(source) {
  const headers = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'content-length' || HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower.startsWith(HEADER_PREFIX)) continue;
    headers.append(name, value);
  }
  return headers;
}

function stateKey(fingerprint) {
  return `${STATE_PREFIX}${fingerprint}:state`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function compatibleHomeResponse(response, method, pathname, { allowSemanticError = false } = {}) {
  if ([401, 403, 408, 429].includes(response.status) || response.status >= 500) return false;
  const type = response.headers.get('Content-Type') || '';
  if (!type.toLowerCase().includes('application/json')) return false;
  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return false;
  }
  if (response.ok && method === 'GET' && pathname === '/feed') return Array.isArray(payload?.channels);
  if (response.ok) return payload !== null && typeof payload === 'object';
  return allowSemanticError
    && response.status >= 400
    && response.status < 500
    && typeof payload?.error === 'string';
}

export function createGatewayWorker(appWorker, options = {}) {
  const fetchImpl = options.fetch || ((...args) => fetch(...args));
  const now = options.now || (() => Date.now());
  const randomUUID = options.randomUUID || (() => crypto.randomUUID());
  const logger = options.logger || console;
  // Memory closes the gap while a new KV stale transition propagates. Track
  // whether that transition was persisted so a receipt handled by another
  // isolate can eventually clear this cache through the shared KV state.
  const memoryStale = new Map();

  async function routeHome(request, env, config, operation, bodyBuffer = new ArrayBuffer(0)) {
    const target = operation === 'ready' ? '/_tubepulse/gateway/ready' : targetPath(request);
    const bodyDigest = await sha256Hex(bodyBuffer);
    const authorizationDigest = await sha256Hex(request.headers.get('Authorization') || '');
    const timestamp = now();
    const requestId = randomUUID();
    const method = operation === 'ready' ? 'GET' : request.method;
    const canonical = requestCanonical({
      timestamp,
      requestId,
      operation,
      method,
      target,
      authorizationDigest,
      bodyDigest,
    });
    const headers = safeForwardHeaders(request.headers);
    headers.set('X-TubePulse-Gateway-Version', GATEWAY_VERSION);
    headers.set('X-TubePulse-Gateway-Timestamp', String(timestamp));
    headers.set('X-TubePulse-Gateway-Request-Id', requestId);
    headers.set('X-TubePulse-Gateway-Operation', operation);
    headers.set('X-TubePulse-Gateway-Body-SHA256', bodyDigest);
    headers.set('X-TubePulse-Gateway-Signature', await hmacHex(config.secret, canonical));

    const homePath = operation === 'ready'
      ? '/_tubepulse/gateway/ready'
      : `/_tubepulse/gateway/app${target}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const resource = `${config.origin}${homePath}`;
      const init = {
        method,
        headers,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: bodyBuffer }),
        signal: controller.signal,
      };
      const upstream = config.transport === 'vpc'
        // Workers VPC currently rejects redirect mode overrides with a
        // pre-dispatch TypeError. Use the documented Request-object form;
        // VPC Services fix the destination and do not follow public routing.
        ? await env.TUBEPULSE_HOME_VPC.fetch(new Request(resource, init))
        : await fetchImpl(resource, { ...init, redirect: 'error' });
      const declaredLength = Number(upstream.headers.get('Content-Length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_HOME_RESPONSE_BYTES) {
        throw new Error('home-response-too-large');
      }
      const responseBody = await upstream.arrayBuffer();
      if (responseBody.byteLength > MAX_HOME_RESPONSE_BYTES) throw new Error('home-response-too-large');
      const responsePayload = [204, 205, 304].includes(upstream.status) ? null : responseBody;
      return new Response(responsePayload, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function homeReady(request, env, config) {
    const response = await routeHome(request, env, config, 'ready');
    if (!response.ok || !(response.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) return false;
    try {
      const payload = await response.json();
      return payload?.ok === true
        && payload?.ready === true
        && payload?.role === 'shadow'
        && payload?.profilePresent === true
        && payload?.current === true;
    } catch {
      return false;
    }
  }

  async function readState(env, fingerprint) {
    const memoryState = memoryStale.get(fingerprint);
    if (memoryState?.persistence === 'unpersisted') return { status: 'stale' };
    try {
      const state = await env.TUBEPULSE_KV.get(stateKey(fingerprint), 'json');
      if (memoryState?.persistence === 'persisted') {
        const reconciledAt = Date.parse(state?.changedAt || '');
        if (state?.status === 'current' && Number.isFinite(reconciledAt) && reconciledAt >= memoryState.staleAt) {
          memoryStale.delete(fingerprint);
        } else return { status: 'stale' };
      }
      return state;
    } catch {
      return null;
    }
  }

  async function markStale(env, fingerprint, reason) {
    if (memoryStale.has(fingerprint)) return;
    const staleAt = now();
    memoryStale.set(fingerprint, { persistence: 'unpersisted', staleAt });
    try {
      const existing = await env.TUBEPULSE_KV.get(stateKey(fingerprint), 'json');
      if (existing?.status !== 'stale') {
        await env.TUBEPULSE_KV.put(stateKey(fingerprint), JSON.stringify({
          schemaVersion: 1,
          status: 'stale',
          changedAt: new Date(staleAt).toISOString(),
          reason,
          ...(existing?.reconciliationRequestId
            ? { reconciliationRequestId: existing.reconciliationRequestId }
            : {}),
        }));
      }
      memoryStale.set(fingerprint, { persistence: 'persisted', staleAt });
    } catch {
      logger.error?.('[TubePulse gateway] stale marker persistence failed; this isolate remains fail-closed');
    }
  }

  async function handleReconcile(request, env, config) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: 'Invalid reconciliation receipt' }, 400);
    }
    const fingerprint = String(payload?.fingerprint || '').toLowerCase();
    const requestId = String(payload?.requestId || '');
    const signature = String(payload?.signature || '').toLowerCase();
    const timestamp = Number(payload?.timestamp);
    const validShape = /^[a-f0-9]{64}$/.test(fingerprint)
      && /^[a-zA-Z0-9_-]{16,128}$/.test(requestId)
      && /^[a-f0-9]{64}$/.test(signature)
      && Number.isFinite(timestamp);
    if (!validShape || !constantTimeHexEqual(fingerprint, config.fingerprint)) {
      return json({ error: 'Invalid reconciliation receipt' }, 401);
    }
    if (Math.abs(now() - timestamp) > 60_000) return json({ error: 'Expired reconciliation receipt' }, 401);
    const expected = await hmacHex(config.secret, reconciliationCanonical({ timestamp, requestId, fingerprint }));
    if (!constantTimeHexEqual(signature, expected)) return json({ error: 'Invalid reconciliation receipt' }, 401);

    const key = stateKey(fingerprint);
    let existing = null;
    try { existing = await env.TUBEPULSE_KV.get(key, 'json'); } catch { /* fail on the required write below */ }
    const staleAt = Date.parse(existing?.changedAt || '');
    if (existing?.status === 'stale' && Number.isFinite(staleAt) && timestamp <= staleAt) {
      return json({ error: 'Reconciliation receipt predates stale state' }, 409);
    }
    if (existing?.status !== 'current') {
      try {
        await env.TUBEPULSE_KV.put(key, JSON.stringify({
          schemaVersion: 1,
          status: 'current',
          changedAt: new Date(now()).toISOString(),
          reconciliationRequestId: requestId,
        }));
      } catch {
        return json({ error: 'Unable to persist reconciliation state' }, 503);
      }
    }
    memoryStale.delete(fingerprint);
    return json({ ok: true, state: 'current', changed: existing?.status !== 'current' });
  }

  return {
    async fetch(request, env, ctx) {
      const config = readConfig(env);
      if (!config.enabled) return await appWorker.fetch(request, env, ctx);
      if (!config.valid) {
        logger.warn?.(`[TubePulse gateway] disabled by invalid configuration (${config.reason})`);
        return await appWorker.fetch(request, env, ctx);
      }

      const url = new URL(request.url);
      if (url.pathname === '/_tubepulse/gateway/reconcile') {
        return await handleReconcile(request, env, config);
      }

      const route = `${request.method.toUpperCase()} ${url.pathname}`;
      const isRead = SAFE_READS.has(route);
      const isMutation = SHADOW_MUTATIONS.has(route);
      if (!isRead && !isMutation) return await appWorker.fetch(request, env, ctx);

      const identity = bearer(request);
      if (!identity) return await appWorker.fetch(request, env, ctx);
      const fingerprint = await sha256Hex(identity);
      if (!constantTimeHexEqual(fingerprint, config.fingerprint)) {
        return await appWorker.fetch(request, env, ctx);
      }

      const startedAt = now();
      if (isRead) {
        const state = await readState(env, fingerprint);
        if (state?.status !== 'current') {
          logger.info?.(`[TubePulse gateway] route=${url.pathname} outcome=cloudflare-state durationMs=${now() - startedAt}`);
          return await appWorker.fetch(request, env, ctx);
        }
        try {
          if (!(await homeReady(request, env, config))) throw new Error('home-not-ready');
          const response = await routeHome(request, env, config, 'read');
          if (!(await compatibleHomeResponse(response, request.method, url.pathname, { allowSemanticError: true }))) {
            throw new Error('home-incompatible');
          }
          logger.info?.(`[TubePulse gateway] route=${url.pathname} outcome=home durationMs=${now() - startedAt}`);
          return response;
        } catch (error) {
          logger.info?.(`[TubePulse gateway] route=${url.pathname} outcome=cloudflare-fallback reason=${safeGatewayFailureReason(error)} durationMs=${now() - startedAt}`);
          return await appWorker.fetch(request, env, ctx);
        }
      }

      let bodyBuffer;
      try {
        bodyBuffer = await request.clone().arrayBuffer();
      } catch {
        return await appWorker.fetch(request, env, ctx);
      }
      const cloudflareResponse = await appWorker.fetch(request, env, ctx);
      if (!cloudflareResponse.ok) return cloudflareResponse;

      try {
        const homeResponse = await routeHome(request, env, config, 'mutation', bodyBuffer);
        if (!(await compatibleHomeResponse(homeResponse, request.method, url.pathname))) {
          await markStale(env, fingerprint, 'replication-response');
          logger.warn?.(`[TubePulse gateway] route=${url.pathname} outcome=cloudflare-home-stale durationMs=${now() - startedAt}`);
        } else {
          logger.info?.(`[TubePulse gateway] route=${url.pathname} outcome=cloudflare-home-replicated durationMs=${now() - startedAt}`);
        }
      } catch (error) {
        await markStale(env, fingerprint, 'replication-unavailable');
        logger.warn?.(`[TubePulse gateway] route=${url.pathname} outcome=cloudflare-home-stale reason=${safeGatewayFailureReason(error)} durationMs=${now() - startedAt}`);
      }
      return cloudflareResponse;
    },
  };
}

export const gatewayTestHelpers = Object.freeze({
  hmacHex,
  reconciliationCanonical,
  requestCanonical,
  sha256Hex,
  stateKey,
});
