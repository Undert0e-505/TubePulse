import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_HOST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Expected a boolean value, received ${JSON.stringify(value)}`);
}

function parsePort(value) {
  const port = Number(value ?? 8788);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('TUBEPULSE_PORT must be an integer from 0 through 65535');
  }
  return port;
}

function parsePositiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed[0] === trimmed.at(-1) && ['"', "'"].includes(trimmed[0])) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n');
  }
  return trimmed;
}

export function loadDotEnv(filePath = path.join(SELF_HOST_DIR, '.env'), target = process.env) {
  if (!fs.existsSync(filePath)) return false;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match || Object.hasOwn(target, match[1])) continue;
    target[match[1]] = unquote(match[2]);
  }
  return true;
}

function readSecret(env, valueName, fileName) {
  const direct = env[valueName];
  if (direct !== undefined && String(direct).length > 0) return String(direct);
  const sourcePath = env[fileName];
  if (!sourcePath) return undefined;
  return fs.readFileSync(path.resolve(String(sourcePath)), 'utf8').trim();
}

function readCanaryFingerprint(env) {
  const direct = env.TUBEPULSE_HOME_CANARY_SHA256;
  if (direct !== undefined && String(direct).trim()) return String(direct).trim().toLowerCase();
  const sourcePath = env.TUBEPULSE_HOME_CANARY_SHA256_FILE;
  if (!sourcePath) return undefined;
  const text = fs.readFileSync(path.resolve(String(sourcePath)), 'utf8').trim();
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.deviceFingerprintSha256 || '').trim().toLowerCase();
  } catch {
    return text.toLowerCase();
  }
}

function normalizeMode(value) {
  const mode = String(value || 'standalone').trim().toLowerCase();
  if (!['standalone', 'mirror'].includes(mode)) {
    throw new Error('TUBEPULSE_MODE must be either "standalone" or "mirror"');
  }
  return mode;
}

function parseGatewayReconcileUrl(value, allowHttp) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error('TUBEPULSE_GATEWAY_RECONCILE_URL must be an absolute URL');
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error('TUBEPULSE_GATEWAY_RECONCILE_URL must not contain credentials, a query, or a fragment');
  }
  if (url.pathname !== '/_tubepulse/gateway/reconcile') {
    throw new Error('TUBEPULSE_GATEWAY_RECONCILE_URL must end at /_tubepulse/gateway/reconcile');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new Error('TUBEPULSE_GATEWAY_RECONCILE_URL must use HTTPS (HTTP is allowed only for explicit local tests)');
  }
  return url.toString();
}

export function readConfig(env = process.env, options = {}) {
  const pilot = parseBoolean(env.TUBEPULSE_PILOT, false);
  const mode = normalizeMode(env.TUBEPULSE_MODE);
  const dataDir = path.resolve(env.TUBEPULSE_DATA_DIR || path.join(SELF_HOST_DIR, 'data'));
  const adminToken = readSecret(env, 'TUBEPULSE_ADMIN_TOKEN', 'TUBEPULSE_ADMIN_TOKEN_FILE');
  const firebaseServiceAccount = readSecret(
    env,
    'FIREBASE_SERVICE_ACCOUNT',
    'FIREBASE_SERVICE_ACCOUNT_FILE',
  ) || readSecret(env, 'TUBEPULSE_FIREBASE_SERVICE_ACCOUNT', 'TUBEPULSE_FIREBASE_SERVICE_ACCOUNT_FILE');
  const youtubeApiKey = readSecret(env, 'YOUTUBE_API_KEY', 'YOUTUBE_API_KEY_FILE');
  // Pilot mode is a hard local-only boundary. Even if an existing ignored
  // .env contains Cloudflare credentials, do not read or expose them to the
  // sync engine while this runtime is serving the isolated Preview pilot.
  const cloudflareToken = pilot
    ? undefined
    : readSecret(env, 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_TOKEN_FILE');
  const cloudflareFields = {
    accountId: pilot ? undefined : env.CLOUDFLARE_ACCOUNT_ID?.trim(),
    namespaceId: pilot ? undefined : env.CLOUDFLARE_KV_NAMESPACE_ID?.trim(),
    apiToken: cloudflareToken,
  };
  const hasAnyCloudflareField = Object.values(cloudflareFields).some(Boolean);
  const hasAllCloudflareFields = Object.values(cloudflareFields).every(Boolean);
  if (hasAnyCloudflareField && !hasAllCloudflareFields) {
    throw new Error(
      'Cloudflare sync requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_KV_NAMESPACE_ID, and CLOUDFLARE_API_TOKEN (or its _FILE variant)',
    );
  }

  const pullIntervalSeconds = parsePositiveInteger(
    env.TUBEPULSE_SYNC_PULL_INTERVAL_SECONDS,
    1800,
    'TUBEPULSE_SYNC_PULL_INTERVAL_SECONDS',
  );
  const syncAutoPush = parseBoolean(env.TUBEPULSE_SYNC_AUTO_PUSH, false);
  const cloudflareWriteEnabled = parseBoolean(env.TUBEPULSE_CLOUDFLARE_WRITE_ENABLED, false);
  const autoTakeover = parseBoolean(env.TUBEPULSE_AUTO_TAKEOVER, false);
  const gatewayOriginEnabled = parseBoolean(env.TUBEPULSE_GATEWAY_ORIGIN_ENABLED, false);
  const gatewaySecret = gatewayOriginEnabled
    ? readSecret(env, 'TUBEPULSE_HOME_GATEWAY_SECRET', 'TUBEPULSE_HOME_GATEWAY_SECRET_FILE')
    : undefined;
  const gatewayFingerprint = gatewayOriginEnabled ? readCanaryFingerprint(env) : undefined;
  const gatewayReconcileAllowHttp = gatewayOriginEnabled
    ? parseBoolean(env.TUBEPULSE_GATEWAY_RECONCILE_ALLOW_HTTP, false)
    : false;
  const gatewayReconcileUrl = gatewayOriginEnabled
    ? parseGatewayReconcileUrl(env.TUBEPULSE_GATEWAY_RECONCILE_URL, gatewayReconcileAllowHttp)
    : undefined;
  const gatewayReconcileTimeoutSeconds = gatewayOriginEnabled
    ? parsePositiveInteger(
        env.TUBEPULSE_GATEWAY_RECONCILE_TIMEOUT_SECONDS,
        10,
        'TUBEPULSE_GATEWAY_RECONCILE_TIMEOUT_SECONDS',
      )
    : 10;
  const gatewayClockSkewSeconds = gatewayOriginEnabled
    ? parsePositiveInteger(env.TUBEPULSE_GATEWAY_CLOCK_SKEW_SECONDS, 60, 'TUBEPULSE_GATEWAY_CLOCK_SKEW_SECONDS')
    : 60;
  const gatewayReadinessMaxAgeSeconds = gatewayOriginEnabled
    ? parsePositiveInteger(
        env.TUBEPULSE_GATEWAY_READINESS_MAX_AGE_SECONDS,
        Math.max(120, pullIntervalSeconds * 2),
        'TUBEPULSE_GATEWAY_READINESS_MAX_AGE_SECONDS',
      )
    : Math.max(120, pullIntervalSeconds * 2);
  if (gatewayOriginEnabled && pilot) {
    throw new Error('TUBEPULSE_GATEWAY_ORIGIN_ENABLED is not allowed in pilot mode');
  }
  if (pilot && mode !== 'standalone') {
    throw new Error('TUBEPULSE_PILOT requires TUBEPULSE_MODE=standalone');
  }
  if (pilot && autoTakeover) {
    throw new Error('TUBEPULSE_PILOT requires TUBEPULSE_AUTO_TAKEOVER=false');
  }
  if (pilot && cloudflareWriteEnabled) {
    throw new Error('TUBEPULSE_PILOT requires TUBEPULSE_CLOUDFLARE_WRITE_ENABLED=false');
  }
  if (pilot && syncAutoPush) {
    throw new Error('TUBEPULSE_PILOT requires TUBEPULSE_SYNC_AUTO_PUSH=false');
  }
  if (syncAutoPush && !cloudflareWriteEnabled) {
    throw new Error('TUBEPULSE_SYNC_AUTO_PUSH requires TUBEPULSE_CLOUDFLARE_WRITE_ENABLED=true');
  }
  if (syncAutoPush && !hasAllCloudflareFields) {
    throw new Error('TUBEPULSE_SYNC_AUTO_PUSH requires complete Cloudflare synchronization credentials');
  }
  if (gatewayOriginEnabled && mode !== 'mirror') {
    throw new Error('TUBEPULSE_GATEWAY_ORIGIN_ENABLED requires TUBEPULSE_MODE=mirror');
  }
  if (gatewayOriginEnabled && !hasAllCloudflareFields) {
    throw new Error('TUBEPULSE_GATEWAY_ORIGIN_ENABLED requires complete Cloudflare synchronization credentials');
  }
  if (gatewayOriginEnabled && !adminToken) {
    throw new Error('TUBEPULSE_GATEWAY_ORIGIN_ENABLED requires TUBEPULSE_ADMIN_TOKEN');
  }
  if (gatewayOriginEnabled && autoTakeover) {
    throw new Error('TUBEPULSE_GATEWAY_ORIGIN_ENABLED requires TUBEPULSE_AUTO_TAKEOVER=false');
  }
  if (gatewayOriginEnabled && (cloudflareWriteEnabled || syncAutoPush)) {
    throw new Error('TUBEPULSE_GATEWAY_ORIGIN_ENABLED requires Cloudflare writes and automatic push to remain disabled');
  }
  if (gatewayOriginEnabled && (!gatewaySecret || gatewaySecret.length < 32)) {
    throw new Error('TUBEPULSE_GATEWAY_ORIGIN_ENABLED requires a gateway secret of at least 32 characters');
  }
  if (gatewayOriginEnabled && !/^[a-f0-9]{64}$/.test(gatewayFingerprint || '')) {
    throw new Error('TUBEPULSE_GATEWAY_ORIGIN_ENABLED requires a full 64-hex canary SHA-256 fingerprint');
  }

  const warnings = [];
  if (!firebaseServiceAccount) {
    warnings.push('FIREBASE_SERVICE_ACCOUNT is not configured; notification delivery cannot run when a scheduled job has recipients.');
  }
  if (!youtubeApiKey) {
    warnings.push('YOUTUBE_API_KEY is not configured; handle resolution and API-based bootstrap fallback are unavailable.');
  }
  if (!adminToken) warnings.push('TUBEPULSE_ADMIN_TOKEN is not configured; all mutating admin HTTP operations are disabled.');
  if (gatewayOriginEnabled && !gatewayReconcileUrl) {
    warnings.push('TUBEPULSE_GATEWAY_RECONCILE_URL is not configured; a clean pull cannot automatically clear a stale canary marker.');
  }
  if (pilot && [
    env.CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_KV_NAMESPACE_ID,
    env.CLOUDFLARE_API_TOKEN,
    env.CLOUDFLARE_API_TOKEN_FILE,
  ].some((value) => String(value || '').trim())) {
    warnings.push('Pilot mode ignores Cloudflare synchronization credentials and keeps remote synchronization unavailable.');
  }
  if (mode === 'mirror' && !hasAllCloudflareFields) {
    warnings.push('Mirror mode has no Cloudflare credentials; automatic and manual Cloudflare synchronization are unavailable.');
  }

  return {
    pilot,
    mode,
    host: String(env.TUBEPULSE_HOST || '127.0.0.1').trim(),
    port: parsePort(env.TUBEPULSE_PORT),
    dataDir,
    adminToken,
    autoTakeover,
    gatewayOrigin: {
      enabled: gatewayOriginEnabled,
      secret: gatewaySecret,
      fingerprint: gatewayFingerprint,
      clockSkewMs: gatewayClockSkewSeconds * 1000,
      readinessMaxAgeMs: gatewayReadinessMaxAgeSeconds * 1000,
      reconcileUrl: gatewayReconcileUrl,
      reconcileTimeoutMs: gatewayReconcileTimeoutSeconds * 1000,
    },
    sync: {
      configured: hasAllCloudflareFields,
      pullIntervalMs: pullIntervalSeconds * 1000,
      autoPush: syncAutoPush,
      writeEnabled: cloudflareWriteEnabled,
      concurrency: parsePositiveInteger(env.TUBEPULSE_SYNC_CONCURRENCY, 4, 'TUBEPULSE_SYNC_CONCURRENCY'),
      ...(hasAllCloudflareFields ? cloudflareFields : {}),
    },
    workerBindings: {
      TUBEPULSE_ENABLE_COMMUNITY_POSTS: String(env.TUBEPULSE_ENABLE_COMMUNITY_POSTS ?? 'true'),
      ...(env.TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST
        ? { TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST: env.TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST }
        : {}),
      ...(env.TUBEPULSE_DEBUG_COMMUNITY_POSTS
        ? { TUBEPULSE_DEBUG_COMMUNITY_POSTS: env.TUBEPULSE_DEBUG_COMMUNITY_POSTS }
        : {}),
      ...(youtubeApiKey ? { YOUTUBE_API_KEY: youtubeApiKey } : {}),
      ...(firebaseServiceAccount ? { FIREBASE_SERVICE_ACCOUNT: firebaseServiceAccount } : {}),
    },
    repoRoot: path.resolve(SELF_HOST_DIR, '..'),
    selfHostDir: SELF_HOST_DIR,
    quiet: options.quiet ?? false,
    warnings,
  };
}

export function publicConfig(config) {
  return {
    pilot: config.pilot,
    mode: config.mode,
    host: config.host,
    port: config.port,
    autoTakeover: config.autoTakeover,
    adminConfigured: Boolean(config.adminToken),
    homeGatewayOriginEnabled: Boolean(config.gatewayOrigin?.enabled),
    homeGatewayFingerprintConfigured: Boolean(config.gatewayOrigin?.fingerprint),
    homeGatewayAutomaticReconciliationConfigured: Boolean(config.gatewayOrigin?.reconcileUrl),
    cloudflareSyncConfigured: config.sync.configured,
    cloudflareWriteEnabled: config.sync.writeEnabled,
    automaticPushEnabled: config.sync.autoPush,
    pullIntervalSeconds: config.sync.pullIntervalMs / 1000,
    warnings: [...config.warnings],
  };
}
