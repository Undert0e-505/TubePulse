import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_HOST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ACTIVE_LATCH = 'CLOUDFLARE_SCHEDULES_CONFIRMED_DISABLED';
export const FIVE_MINUTE_POSTS_LATCH = 'YOUTUBE_QUOTA_BUDGET_CONFIRMED';
export const UNIFIED_AUTHORITY_LATCH = 'UNIFIED_LOCAL_AUTHORITY_CONFIRMED';

function readSecret(env, valueName, fileName) {
  const direct = env[valueName];
  if (direct !== undefined && String(direct).length > 0) return String(direct);
  const sourcePath = env[fileName];
  if (!sourcePath) return undefined;
  return fs.readFileSync(path.resolve(String(sourcePath)), 'utf8').trim();
}

function booleanValue(value, fallback, name) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

function positiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function schedulerMode(value) {
  const mode = String(value || 'shadow').trim().toLowerCase();
  if (!['shadow', 'standby', 'active'].includes(mode)) {
    throw new Error('TUBEPULSE_HOME_SCHEDULER_MODE must be shadow, standby, or active');
  }
  return mode;
}

function parsedUrl(value, name, { httpsOnly = false, localAdmin = false } = {}) {
  const text = String(value || '').trim();
  if (!text) return null;
  let url;
  try { url = new URL(text); } catch { throw new Error(`${name} must be a valid URL`); }
  if (httpsOnly && url.protocol !== 'https:') throw new Error(`${name} must use https`);
  if (localAdmin) {
    const localHosts = new Set(['127.0.0.1', 'localhost', 'host.docker.internal']);
    if (!['http:', 'https:'].includes(url.protocol) || !localHosts.has(url.hostname)
      || url.pathname !== '/_tubepulse/admin/gateway/reconcile' || url.search || url.hash) {
      throw new Error(`${name} must target the local gateway reconciliation admin endpoint`);
    }
  }
  return url.toString().replace(/\/$/, '');
}

export function readHomeSchedulerConfig(env = process.env, options = {}) {
  const mode = schedulerMode(env.TUBEPULSE_HOME_SCHEDULER_MODE);
  const dataDir = path.resolve(env.TUBEPULSE_HOME_SCHEDULER_DATA_DIR || path.join(SELF_HOST_DIR, 'data-scheduler'));
  const apiToken = readSecret(env, 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_TOKEN_FILE');
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const namespaceId = String(env.CLOUDFLARE_KV_NAMESPACE_ID || '').trim();
  const syncConfigured = Boolean(accountId && namespaceId && apiToken);
  const remoteWriteEnabled = booleanValue(
    env.TUBEPULSE_HOME_SCHEDULER_REMOTE_WRITE_ENABLED,
    false,
    'TUBEPULSE_HOME_SCHEDULER_REMOTE_WRITE_ENABLED',
  );
  const notificationsEnabled = booleanValue(
    env.TUBEPULSE_HOME_SCHEDULER_NOTIFICATIONS_ENABLED,
    false,
    'TUBEPULSE_HOME_SCHEDULER_NOTIFICATIONS_ENABLED',
  );
  const alignedVideoNotificationsEnabled = booleanValue(
    env.TUBEPULSE_HOME_ALIGNED_VIDEO_NOTIFICATIONS_ENABLED,
    false,
    'TUBEPULSE_HOME_ALIGNED_VIDEO_NOTIFICATIONS_ENABLED',
  );
  const gatewayAdminToken = readSecret(
    env,
    'TUBEPULSE_HOME_SCHEDULER_GATEWAY_ADMIN_TOKEN',
    'TUBEPULSE_HOME_SCHEDULER_GATEWAY_ADMIN_TOKEN_FILE',
  );
  const gatewayAdminUrl = parsedUrl(
    env.TUBEPULSE_HOME_SCHEDULER_GATEWAY_ADMIN_URL,
    'TUBEPULSE_HOME_SCHEDULER_GATEWAY_ADMIN_URL',
    { localAdmin: true },
  );
  const gatewayReconcileUrl = parsedUrl(
    env.TUBEPULSE_HOME_SCHEDULER_GATEWAY_RECONCILE_URL,
    'TUBEPULSE_HOME_SCHEDULER_GATEWAY_RECONCILE_URL',
    { httpsOnly: true },
  );
  const apiBaseUrl = parsedUrl(
    env.TUBEPULSE_HOME_SCHEDULER_API_URL,
    'TUBEPULSE_HOME_SCHEDULER_API_URL',
    { httpsOnly: true },
  );
  const authoritySecret = readSecret(
    env,
    'TUBEPULSE_HOME_AUTHORITY_SECRET',
    'TUBEPULSE_HOME_AUTHORITY_SECRET_FILE',
  );
  const authorityApiUrl = parsedUrl(
    env.TUBEPULSE_HOME_AUTHORITY_API_URL || env.TUBEPULSE_HOME_SCHEDULER_API_URL,
    'TUBEPULSE_HOME_AUTHORITY_API_URL',
    { httpsOnly: true },
  );
  const unifiedAuthorityEnabled = booleanValue(
    env.TUBEPULSE_HOME_UNIFIED_AUTHORITY_ENABLED,
    false,
    'TUBEPULSE_HOME_UNIFIED_AUTHORITY_ENABLED',
  );
  const unifiedAuthorityLatch = String(env.TUBEPULSE_HOME_UNIFIED_AUTHORITY_LATCH || '');
  const gatewayConvergenceRequired = booleanValue(
    env.TUBEPULSE_HOME_SCHEDULER_GATEWAY_CONVERGENCE_REQUIRED,
    false,
    'TUBEPULSE_HOME_SCHEDULER_GATEWAY_CONVERGENCE_REQUIRED',
  );
  const schedulesDisabled = booleanValue(
    env.TUBEPULSE_CLOUDFLARE_SCHEDULES_CONFIRMED_DISABLED,
    false,
    'TUBEPULSE_CLOUDFLARE_SCHEDULES_CONFIRMED_DISABLED',
  );
  const firebaseServiceAccount = readSecret(
    env,
    'FIREBASE_SERVICE_ACCOUNT',
    'FIREBASE_SERVICE_ACCOUNT_FILE',
  );
  const youtubeApiKey = readSecret(env, 'YOUTUBE_API_KEY', 'YOUTUBE_API_KEY_FILE');
  const videoSourceMode = String(env.TUBEPULSE_HOME_SCHEDULER_VIDEO_SOURCE || 'youtube-api').trim().toLowerCase();
  if (!['youtube-api', 'rss-legacy'].includes(videoSourceMode)) {
    throw new Error('TUBEPULSE_HOME_SCHEDULER_VIDEO_SOURCE must be youtube-api or rss-legacy');
  }
  const youtubeApiFallbackRequested = booleanValue(
    env.TUBEPULSE_HOME_SCHEDULER_YOUTUBE_API_FALLBACK_ENABLED,
    true,
    'TUBEPULSE_HOME_SCHEDULER_YOUTUBE_API_FALLBACK_ENABLED',
  );
  const fallbackDailyCapText = String(env.TUBEPULSE_HOME_SCHEDULER_YOUTUBE_FALLBACK_DAILY_CAP ?? '').trim();
  const youtubeFallbackDailyCap = fallbackDailyCapText === ''
    ? null
    : nonNegativeInteger(fallbackDailyCapText, 0, 'TUBEPULSE_HOME_SCHEDULER_YOUTUBE_FALLBACK_DAILY_CAP');
  const activationLatch = String(env.TUBEPULSE_HOME_SCHEDULER_ACTIVATION_LATCH || '');
  const postsCadenceMinutes = positiveInteger(
    env.TUBEPULSE_HOME_SCHEDULER_POSTS_CADENCE_MINUTES,
    60,
    'TUBEPULSE_HOME_SCHEDULER_POSTS_CADENCE_MINUTES',
  );
  if (postsCadenceMinutes % 5 !== 0 || 1440 % postsCadenceMinutes !== 0) {
    throw new Error('Post cadence must be a five-minute multiple that divides evenly into one day');
  }
  const allowFiveMinutePosts = booleanValue(
    env.TUBEPULSE_HOME_SCHEDULER_ALLOW_5M_POSTS,
    false,
    'TUBEPULSE_HOME_SCHEDULER_ALLOW_5M_POSTS',
  );
  const fiveMinutePostsLatch = String(env.TUBEPULSE_HOME_SCHEDULER_5M_POSTS_LATCH || '');
  if (postsCadenceMinutes === 5 && (!allowFiveMinutePosts || fiveMinutePostsLatch !== FIVE_MINUTE_POSTS_LATCH)) {
    throw new Error('Five-minute post sweeps require the explicit quota flag and 5M_POSTS_LATCH');
  }
  const rssCircuitInitialCooldownMinutes = positiveInteger(
    env.TUBEPULSE_HOME_SCHEDULER_RSS_CIRCUIT_INITIAL_COOLDOWN_MINUTES,
    15,
    'TUBEPULSE_HOME_SCHEDULER_RSS_CIRCUIT_INITIAL_COOLDOWN_MINUTES',
  );
  const rssCircuitMaximumCooldownMinutes = positiveInteger(
    env.TUBEPULSE_HOME_SCHEDULER_RSS_CIRCUIT_MAXIMUM_COOLDOWN_MINUTES,
    60,
    'TUBEPULSE_HOME_SCHEDULER_RSS_CIRCUIT_MAXIMUM_COOLDOWN_MINUTES',
  );
  if (rssCircuitMaximumCooldownMinutes < rssCircuitInitialCooldownMinutes) {
    throw new Error('RSS circuit maximum cooldown must be at least the initial cooldown');
  }
  const rssRecoverySuccessesRequired = positiveInteger(
    env.TUBEPULSE_HOME_SCHEDULER_RSS_RECOVERY_SUCCESSES,
    2,
    'TUBEPULSE_HOME_SCHEDULER_RSS_RECOVERY_SUCCESSES',
  );
  if (rssRecoverySuccessesRequired < 2) {
    throw new Error('RSS circuit recovery requires at least two consecutive successes');
  }

  if (!syncConfigured && mode === 'shadow') {
    throw new Error('Shadow scheduler mode requires complete read access to Cloudflare KV');
  }
  if (mode !== 'active' && remoteWriteEnabled) {
    throw new Error('Remote publication is forbidden outside active scheduler mode');
  }
  if (mode !== 'active' && notificationsEnabled) {
    throw new Error('Notifications are forbidden outside active scheduler mode');
  }
  if (mode === 'active') {
    if (!remoteWriteEnabled) throw new Error('Active mode requires remote publication');
    if (!notificationsEnabled) throw new Error('Active mode requires notifications to be explicitly enabled');
    if (!firebaseServiceAccount) throw new Error('Active mode requires a Firebase service account');
    if (!schedulesDisabled) throw new Error('Active mode requires confirmation that all Cloudflare scheduled triggers are disabled');
    if (activationLatch !== ACTIVE_LATCH) {
      throw new Error(`Active mode requires TUBEPULSE_HOME_SCHEDULER_ACTIVATION_LATCH=${ACTIVE_LATCH}`);
    }
    if (!apiBaseUrl) {
      throw new Error('Active mode requires the production API visibility barrier configuration');
    }
    if (!unifiedAuthorityEnabled || unifiedAuthorityLatch !== UNIFIED_AUTHORITY_LATCH) {
      throw new Error(`Active mode requires TUBEPULSE_HOME_UNIFIED_AUTHORITY_LATCH=${UNIFIED_AUTHORITY_LATCH}`);
    }
    if (!authorityApiUrl || !authoritySecret || authoritySecret.length < 32) {
      throw new Error('Active mode requires the signed unified authority API configuration');
    }
    if (videoSourceMode !== 'youtube-api' || !youtubeApiKey) {
      throw new Error('Active mode requires the Home YouTube Data API video source and API key');
    }
    if (gatewayConvergenceRequired && (!gatewayAdminToken || !gatewayAdminUrl || !gatewayReconcileUrl)) {
      throw new Error('Active mode requires gateway reconciliation configuration when gateway convergence is enabled');
    }
  }

  return {
    mode,
    dataDir,
    sync: {
      configured: syncConfigured,
      accountId,
      namespaceId,
      apiToken,
      concurrency: positiveInteger(env.TUBEPULSE_HOME_SCHEDULER_SYNC_CONCURRENCY, 6, 'TUBEPULSE_HOME_SCHEDULER_SYNC_CONCURRENCY'),
    },
    remoteWriteEnabled,
    notificationsEnabled,
    alignedVideoNotificationsEnabled,
    notificationBarrier: {
      configured: Boolean(apiBaseUrl && (!gatewayConvergenceRequired
        || (gatewayAdminToken && gatewayAdminUrl && gatewayReconcileUrl))),
      gatewayConvergenceRequired,
      gatewayAdminToken,
      gatewayAdminUrl,
      gatewayReconcileUrl,
      apiBaseUrl,
      requireHomeAuthorityRoute: mode === 'active' && unifiedAuthorityEnabled,
      timeoutMs: positiveInteger(
        env.TUBEPULSE_HOME_SCHEDULER_NOTIFICATION_BARRIER_TIMEOUT_SECONDS,
        20,
        'TUBEPULSE_HOME_SCHEDULER_NOTIFICATION_BARRIER_TIMEOUT_SECONDS',
      ) * 1000,
      retryCount: nonNegativeInteger(
        env.TUBEPULSE_HOME_SCHEDULER_NOTIFICATION_BARRIER_RETRY_COUNT,
        2,
        'TUBEPULSE_HOME_SCHEDULER_NOTIFICATION_BARRIER_RETRY_COUNT',
      ),
      retryBackoffMs: positiveInteger(
        env.TUBEPULSE_HOME_SCHEDULER_NOTIFICATION_BARRIER_RETRY_BACKOFF_MS,
        1000,
        'TUBEPULSE_HOME_SCHEDULER_NOTIFICATION_BARRIER_RETRY_BACKOFF_MS',
      ),
    },
    authority: {
      enabled: unifiedAuthorityEnabled,
      apiUrl: authorityApiUrl,
      secret: authoritySecret,
      host: String(env.TUBEPULSE_HOME_AUTHORITY_HOST || '0.0.0.0').trim(),
      port: positiveInteger(env.TUBEPULSE_HOME_AUTHORITY_PORT, 8788, 'TUBEPULSE_HOME_AUTHORITY_PORT'),
      timeoutMs: positiveInteger(
        env.TUBEPULSE_HOME_AUTHORITY_TIMEOUT_SECONDS,
        15,
        'TUBEPULSE_HOME_AUTHORITY_TIMEOUT_SECONDS',
      ) * 1000,
    },
    schedulesDisabled,
    concurrency: positiveInteger(env.TUBEPULSE_HOME_SCHEDULER_CONCURRENCY, 6, 'TUBEPULSE_HOME_SCHEDULER_CONCURRENCY'),
    rssChannelTimeoutMs: positiveInteger(
      env.TUBEPULSE_HOME_SCHEDULER_RSS_CHANNEL_TIMEOUT_SECONDS,
      3,
      'TUBEPULSE_HOME_SCHEDULER_RSS_CHANNEL_TIMEOUT_SECONDS',
    ) * 1000,
    rssCircuitInitialCooldownMinutes,
    rssCircuitMaximumCooldownMinutes,
    rssRecoverySuccessesRequired,
    channelTimeoutMs: positiveInteger(env.TUBEPULSE_HOME_SCHEDULER_CHANNEL_TIMEOUT_SECONDS, 25, 'TUBEPULSE_HOME_SCHEDULER_CHANNEL_TIMEOUT_SECONDS') * 1000,
    retryCount: nonNegativeInteger(env.TUBEPULSE_HOME_SCHEDULER_RETRY_COUNT, 2, 'TUBEPULSE_HOME_SCHEDULER_RETRY_COUNT'),
    retryBackoffMs: positiveInteger(env.TUBEPULSE_HOME_SCHEDULER_RETRY_BACKOFF_MS, 1000, 'TUBEPULSE_HOME_SCHEDULER_RETRY_BACKOFF_MS'),
    leaseTtlMs: positiveInteger(env.TUBEPULSE_HOME_SCHEDULER_LEASE_TTL_SECONDS, 180, 'TUBEPULSE_HOME_SCHEDULER_LEASE_TTL_SECONDS') * 1000,
    postsCadenceMinutes,
    postsConcurrency: positiveInteger(env.TUBEPULSE_HOME_SCHEDULER_POSTS_CONCURRENCY, 4, 'TUBEPULSE_HOME_SCHEDULER_POSTS_CONCURRENCY'),
    postsMaxResponseBytes: positiveInteger(
      env.TUBEPULSE_HOME_SCHEDULER_POSTS_MAX_RESPONSE_BYTES,
      2 * 1024 * 1024,
      'TUBEPULSE_HOME_SCHEDULER_POSTS_MAX_RESPONSE_BYTES',
    ),
    youtubeDailyQuotaUnits: positiveInteger(env.TUBEPULSE_YOUTUBE_DAILY_QUOTA_UNITS, 10_000, 'TUBEPULSE_YOUTUBE_DAILY_QUOTA_UNITS'),
    youtubeQuotaReserveUnits: nonNegativeInteger(
      env.TUBEPULSE_HOME_SCHEDULER_YOUTUBE_QUOTA_RESERVE_UNITS,
      1_000,
      'TUBEPULSE_HOME_SCHEDULER_YOUTUBE_QUOTA_RESERVE_UNITS',
    ),
    videoSourceMode,
    youtubeSafetyReconcileHours: positiveInteger(
      env.TUBEPULSE_HOME_SCHEDULER_YOUTUBE_SAFETY_RECONCILE_HOURS,
      6,
      'TUBEPULSE_HOME_SCHEDULER_YOUTUBE_SAFETY_RECONCILE_HOURS',
    ),
    youtubeMaxReconciliationsPerCycle: positiveInteger(
      env.TUBEPULSE_HOME_SCHEDULER_YOUTUBE_MAX_RECONCILIATIONS_PER_CYCLE,
      5,
      'TUBEPULSE_HOME_SCHEDULER_YOUTUBE_MAX_RECONCILIATIONS_PER_CYCLE',
    ),
    youtubeMaxMigrationReconciliationsPerCycle: positiveInteger(
      env.TUBEPULSE_HOME_SCHEDULER_YOUTUBE_MAX_MIGRATION_RECONCILIATIONS_PER_CYCLE,
      100,
      'TUBEPULSE_HOME_SCHEDULER_YOUTUBE_MAX_MIGRATION_RECONCILIATIONS_PER_CYCLE',
    ),
    youtubeMaxPlaylistPages: positiveInteger(
      env.TUBEPULSE_HOME_SCHEDULER_YOUTUBE_MAX_PLAYLIST_PAGES,
      3,
      'TUBEPULSE_HOME_SCHEDULER_YOUTUBE_MAX_PLAYLIST_PAGES',
    ),
    youtubeStatisticsDailyQuotaUnits: positiveInteger(
      env.TUBEPULSE_HOME_SCHEDULER_YOUTUBE_STATISTICS_DAILY_QUOTA_UNITS,
      10_000,
      'TUBEPULSE_HOME_SCHEDULER_YOUTUBE_STATISTICS_DAILY_QUOTA_UNITS',
    ),
    youtubeStatisticsReserveUnits: nonNegativeInteger(
      env.TUBEPULSE_HOME_SCHEDULER_YOUTUBE_STATISTICS_RESERVE_UNITS,
      1_000,
      'TUBEPULSE_HOME_SCHEDULER_YOUTUBE_STATISTICS_RESERVE_UNITS',
    ),
    youtubeApiFallback: {
      enabled: youtubeApiFallbackRequested && Boolean(youtubeApiKey),
      configured: Boolean(youtubeApiKey),
      dailyCap: youtubeFallbackDailyCap,
    },
    allowFiveMinutePosts,
    workerBindings: {
      TUBEPULSE_ENABLE_COMMUNITY_POSTS: String(env.TUBEPULSE_ENABLE_COMMUNITY_POSTS ?? 'true'),
      TUBEPULSE_NOTIFICATION_MODE: mode === 'shadow' ? 'shadow' : 'active',
      TUBEPULSE_ALIGNED_VIDEO_NOTIFICATIONS_ENABLED: alignedVideoNotificationsEnabled,
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
    quiet: options.quiet ?? false,
  };
}

export function publicHomeSchedulerConfig(config) {
  return {
    mode: config.mode,
    dataDir: config.dataDir,
    cloudflareReadConfigured: config.sync.configured,
    remoteWriteEnabled: config.remoteWriteEnabled,
    notificationsEnabled: config.notificationsEnabled,
    alignedVideoNotificationsEnabled: config.alignedVideoNotificationsEnabled,
    notificationBarrierConfigured: Boolean(config.notificationBarrier?.configured),
    gatewayConvergenceRequired: Boolean(config.notificationBarrier?.gatewayConvergenceRequired),
    unifiedAuthorityEnabled: Boolean(config.authority?.enabled),
    authorityApiConfigured: Boolean(config.authority?.apiUrl && config.authority?.secret),
    notificationHomeRouteRequired: Boolean(config.notificationBarrier?.requireHomeAuthorityRoute),
    schedulesDisabledConfirmed: config.schedulesDisabled,
    concurrency: config.concurrency,
    rssChannelTimeoutSeconds: config.rssChannelTimeoutMs / 1000,
    channelTimeoutSeconds: config.channelTimeoutMs / 1000,
    retryCount: config.retryCount,
    rssCircuitInitialCooldownMinutes: config.rssCircuitInitialCooldownMinutes,
    rssCircuitMaximumCooldownMinutes: config.rssCircuitMaximumCooldownMinutes,
    rssRecoverySuccessesRequired: config.rssRecoverySuccessesRequired,
    postsCadenceMinutes: config.postsCadenceMinutes,
    postsConcurrency: config.postsConcurrency,
    postsMaxResponseBytes: config.postsMaxResponseBytes,
    youtubeDailyQuotaUnits: config.youtubeDailyQuotaUnits,
    youtubeQuotaReserveUnits: config.youtubeQuotaReserveUnits,
    videoSourceMode: config.videoSourceMode,
    youtubeSafetyReconcileHours: config.youtubeSafetyReconcileHours,
    youtubeMaxReconciliationsPerCycle: config.youtubeMaxReconciliationsPerCycle,
    youtubeMaxMigrationReconciliationsPerCycle: config.youtubeMaxMigrationReconciliationsPerCycle,
    youtubeMaxPlaylistPages: config.youtubeMaxPlaylistPages,
    youtubeStatisticsDailyQuotaUnits: config.youtubeStatisticsDailyQuotaUnits,
    youtubeStatisticsReserveUnits: config.youtubeStatisticsReserveUnits,
    youtubeApiFallbackConfigured: Boolean(config.youtubeApiFallback?.configured),
    youtubeApiFallbackEnabled: Boolean(config.youtubeApiFallback?.enabled),
    youtubeApiFallbackDailyCap: config.youtubeApiFallback?.dailyCap ?? null,
  };
}
