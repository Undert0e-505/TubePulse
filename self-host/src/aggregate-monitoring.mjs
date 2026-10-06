const DAY_MS = 24 * 60 * 60 * 1000;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function timestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJson(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function parseStringArray(value) {
  if (typeof value !== 'string') return { valid: false, entries: [], values: [] };
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return { valid: false, entries: [], values: [] };
    const entries = parsed.filter((entry) => typeof entry === 'string' && entry.length > 0);
    return { valid: true, entries, values: [...new Set(entries)] };
  } catch {
    return { valid: false, entries: [], values: [] };
  }
}

function membershipKey(installKey, channelKey) {
  return JSON.stringify([installKey, channelKey]);
}

export function deviceIdFromTerminalKey(name, terminal) {
  const prefix = 'device:';
  const suffix = `:${terminal}`;
  if (typeof name !== 'string' || !name.startsWith(prefix) || !name.endsWith(suffix)) return null;
  const deviceId = name.slice(prefix.length, -suffix.length);
  if (
    !deviceId
    || deviceId.includes(':state:')
    || deviceId.endsWith(':state')
    || deviceId.includes(':override:')
    || deviceId.endsWith(':override')
  ) return null;
  return deviceId;
}

function safeVersion(value) {
  const text = String(value || 'unknown').trim();
  return /^[A-Za-z0-9._+-]{1,32}$/.test(text) ? text : 'unknown';
}

async function mapLimit(items, limit, mapper) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

function ageSeconds(value, nowMs) {
  const parsed = timestamp(value);
  return parsed === null ? null : Math.max(0, Math.floor((nowMs - parsed) / 1000));
}

export const FORBIDDEN_AGGREGATE_FIELDS = new Set([
  'deviceId', 'channelId', 'fcmToken', 'token', 'handle', 'title', 'description', 'videoId', 'postId',
]);

export function assertAggregateMonitoringSafe(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertAggregateMonitoringSafe(entry, `${path}[${index}]`));
    return value;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /\bUC[A-Za-z0-9_-]{20,}\b/.test(value)) {
      throw new Error(`Aggregate monitoring payload contains a channel identifier at ${path}`);
    }
    return value;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_AGGREGATE_FIELDS.has(key)) {
      throw new Error(`Aggregate monitoring payload contains forbidden field ${key}`);
    }
    assertAggregateMonitoringSafe(entry, `${path}.${key}`);
  }
  return value;
}

export async function collectAggregateMonitoring({
  adapter,
  localStatus,
  remoteStatus = null,
  config = {},
  nowMs = Date.now(),
  concurrency = 8,
}) {
  const keys = await adapter.listKeys();
  const profileKeys = keys
    .map(({ name }) => ({ name, installKey: deviceIdFromTerminalKey(name, 'profile') }))
    .filter(({ installKey }) => installKey !== null);
  const channelKeys = keys
    .map(({ name }) => ({ name, installKey: deviceIdFromTerminalKey(name, 'channels') }))
    .filter(({ installKey }) => installKey !== null);
  const subscriberKeys = keys.filter(({ name }) => /^channel:[^:]+:subscribers$/.test(name));
  const [profiles, channelRows, subscriberRows, activeRaw] = await Promise.all([
    mapLimit(profileKeys, concurrency, async ({ name, installKey }) => ({
      installKey,
      profile: parseJson(await adapter.get(name), null),
    })),
    mapLimit(channelKeys, concurrency, async ({ name, installKey }) => ({
      installKey,
      ...parseStringArray(await adapter.get(name)),
    })),
    mapLimit(subscriberKeys, concurrency, async ({ name }) => ({
      channelKey: name.slice('channel:'.length, -':subscribers'.length),
      ...parseStringArray(await adapter.get(name)),
    })),
    adapter.get('channels:active'),
  ]);

  const channelsByInstall = new Map(channelRows.map(({ installKey, values }) => [
    installKey,
    values.length,
  ]));
  const validProfiles = profiles.filter(({ profile }) => profile && typeof profile === 'object' && !Array.isArray(profile));
  const validProfileKeys = new Set(validProfiles.map(({ installKey }) => installKey));
  const counts = validProfiles.map(({ installKey }) => channelsByInstall.get(installKey) || 0).sort((a, b) => a - b);
  const versionCounts = new Map();
  let pushCapable = 0;
  const created = [];
  const active = [];
  for (const { profile } of validProfiles) {
    const version = safeVersion(profile.appVersion);
    versionCounts.set(version, (versionCounts.get(version) || 0) + 1);
    if (typeof profile.fcmToken === 'string' && profile.fcmToken.length > 0) pushCapable++;
    created.push(timestamp(profile.createdAt));
    active.push(timestamp(profile.lastSeenAt));
  }
  const within = (values, days) => values.filter((value) => value !== null && nowMs - value >= 0 && nowMs - value <= days * DAY_MS).length;
  const totalSubscriptions = counts.reduce((sum, count) => sum + count, 0);
  const activeRecord = parseStringArray(activeRaw);
  const activeChannelKeys = new Set(activeRecord.values);
  const configuredPairs = new Set();
  const configuredChannelKeys = new Set();
  let configuredMembershipEntries = 0;
  for (const row of channelRows) {
    configuredMembershipEntries += row.entries.length;
    for (const channelKey of row.values) {
      configuredPairs.add(membershipKey(row.installKey, channelKey));
      configuredChannelKeys.add(channelKey);
    }
  }
  const indexedPairs = new Set();
  const indexedChannelKeys = new Set();
  let indexedMembershipEntries = 0;
  for (const row of subscriberRows) {
    indexedMembershipEntries += row.entries.length;
    if (row.values.length > 0) indexedChannelKeys.add(row.channelKey);
    for (const installKey of row.values) indexedPairs.add(membershipKey(installKey, row.channelKey));
  }
  const missingFromSubscriberIndex = [...configuredPairs].filter((pair) => !indexedPairs.has(pair)).length;
  const missingFromDeviceConfig = [...indexedPairs].filter((pair) => !configuredPairs.has(pair)).length;
  const subscriberCounts = new Map(subscriberRows.map((row) => [row.channelKey, row.values.length]));
  const activeChannelsWithNoSubscriberIndex = [...activeChannelKeys]
    .filter((channelKey) => !subscriberCounts.get(channelKey)).length;
  const configuredChannelsAbsentFromActive = [...configuredChannelKeys]
    .filter((channelKey) => !activeChannelKeys.has(channelKey)).length;
  const indexedChannelsAbsentFromActive = [...indexedChannelKeys]
    .filter((channelKey) => !activeChannelKeys.has(channelKey)).length;
  const deviceChannelRecordsWithoutProfile = channelRows
    .filter(({ installKey }) => !validProfileKeys.has(installKey)).length;
  const configuredMembershipsMissingProfile = channelRows
    .filter(({ installKey }) => !validProfileKeys.has(installKey))
    .reduce((sum, row) => sum + row.values.length, 0);
  const subscriberMembershipsMissingProfile = subscriberRows.reduce((sum, row) => (
    sum + row.values.filter((installKey) => !validProfileKeys.has(installKey)).length
  ), 0);
  const integrityIssues = {
    missingFromSubscriberIndex,
    missingFromDeviceConfig,
    activeChannelsWithNoSubscriberIndex,
    configuredChannelsAbsentFromActive,
    indexedChannelsAbsentFromActive,
    deviceChannelRecordsWithoutProfile,
    configuredMembershipsMissingProfile,
    subscriberMembershipsMissingProfile,
    duplicateConfiguredMemberships: configuredMembershipEntries - configuredPairs.size,
    duplicateIndexedMemberships: indexedMembershipEntries - indexedPairs.size,
    duplicateActiveChannels: activeRecord.entries.length - activeChannelKeys.size,
    malformedDeviceChannelRecords: channelRows.filter(({ valid }) => !valid).length,
    malformedSubscriberIndexes: subscriberRows.filter(({ valid }) => !valid).length,
    malformedActiveChannelIndex: activeRecord.valid ? 0 : 1,
  };
  const membershipMismatchCount = missingFromSubscriberIndex + missingFromDeviceConfig;
  const subscriptionIndexConsistent = Object.values(integrityIssues).every((count) => count === 0);

  const scheduler = localStatus?.scheduler || {};
  const youtube = scheduler.youtubeDataApi || {};
  const youtubeQuota = youtube.quota || {};
  const lastDelivery = scheduler.lastNotificationDelivery || {};
  const notificationIntents = scheduler.notificationIntents || {};
  const lastCycle = youtube.lastCycle || {};
  const lastSweep = scheduler.lastSweep || {};
  const remoteQuota = remoteStatus?.quota || {};
  const remoteLimits = remoteQuota.limits || {};
  const progressAt = youtube.lastGoodAt || lastCycle.finishedAt || scheduler.lastMinuteJobs?.scheduledAt || scheduler.startedAt;
  const schedulerErrorAt = timestamp(scheduler.lastError?.at);
  const schedulerProgressAt = timestamp(progressAt);

  const payload = {
    schemaVersion: 2,
    collectedAt: new Date(nowMs).toISOString(),
    privacy: 'aggregate-only',
    installs: {
      registered: validProfiles.length,
      new: { h24: within(created, 1), d7: within(created, 7), d30: within(created, 30) },
      active: { h24: within(active, 1), d7: within(active, 7), d30: within(active, 30) },
      pushCapable,
      appVersions: [...versionCounts.entries()]
        .map(([version, count]) => ({ version, count }))
        .sort((left, right) => left.version.localeCompare(right.version)),
    },
    subscriptions: {
      activeChannels: activeChannelKeys.size,
      configuredMemberships: configuredPairs.size,
      indexedMemberships: indexedPairs.size,
      configuredMembershipEntries,
      indexedMembershipEntries,
      membershipMismatchCount,
      indexConsistent: subscriptionIndexConsistent,
      integrityIssues,
      perInstall: {
        mean: counts.length ? totalSubscriptions / counts.length : 0,
        p50: percentile(counts, 0.50),
        p95: percentile(counts, 0.95),
        max: counts.at(-1) || 0,
        zero: counts.filter((count) => count === 0).length,
      },
    },
    host: {
      ready: localStatus?.status === 'ready',
      current: localStatus?.authority?.replication?.status === 'current',
      mode: String(localStatus?.mode || 'unknown'),
      schedulerActive: scheduler.mode === 'active',
      schedulerLeaseHeld: scheduler.lease?.state === 'held',
      schedulerProgressAgeSeconds: ageSeconds(progressAt, nowMs),
      schedulerOutcome: String(lastSweep.outcome || 'unknown'),
      currentSweep: Boolean(scheduler.currentSweep),
      // lastError is retained as incident history. Count it as current only
      // until newer successful scheduler progress supersedes it.
      lastErrorPresent: Boolean(scheduler.lastError)
        && (schedulerProgressAt === null || schedulerErrorAt === null || schedulerErrorAt >= schedulerProgressAt),
    },
    youtube: {
      sourceMode: String(youtube.sourceMode || localStatus?.configuration?.videoSourceMode || 'unknown'),
      statsMethod: String(youtube.statsMethod || 'unknown'),
      lastGoodAgeSeconds: ageSeconds(youtube.lastGoodAt, nowMs),
      lastErrorPresent: Boolean(youtube.lastError),
      general: {
        used: finite(youtubeQuota.general?.units),
        failures: finite(youtubeQuota.general?.failures),
        limit: finite(config.youtubeDailyQuotaUnits, 10_000),
        reserve: finite(config.youtubeQuotaReserveUnits, 1_000),
      },
      statistics: {
        used: finite(youtubeQuota.statistics?.units),
        failures: finite(youtubeQuota.statistics?.failures),
        limit: finite(config.youtubeStatisticsDailyQuotaUnits, 10_000),
        reserve: finite(config.youtubeStatisticsReserveUnits, 1_000),
      },
      resetsAt: youtubeQuota.general?.resetsAt || youtubeQuota.resetsAt || null,
    },
    notifications: {
      queued: finite(lastDelivery.queued),
      sent: finite(lastDelivery.sent),
      failed: finite(lastDelivery.failed),
      suppressed: finite(lastDelivery.suppressed),
      recovered: finite(lastDelivery.recovered),
      deduplicated: finite(lastDelivery.deduplicated),
      barrierHealthy: ['passed', 'not-required', 'not-needed'].includes(lastDelivery.barrier),
      durableBacklog: finite(notificationIntents.pending),
      ambiguousSending: finite(notificationIntents.sending),
      callbackPending: finite(notificationIntents.callbackPending),
      retainedFailures: finite(notificationIntents.failed),
      retainedDeadTokens: finite(notificationIntents.deadToken),
      transientNagsExpired: finite(notificationIntents.transientExpired),
    },
    authority: {
      remoteAvailable: Boolean(remoteStatus?.ok),
      current: remoteStatus?.replication?.status === 'current',
      pendingBackupKeys: finite(remoteStatus?.pendingBackupKeys),
      transactionActive: Boolean(remoteStatus?.transaction),
      leaseActive: Boolean(remoteStatus?.lease),
      backendReady: remoteStatus?.backend?.selected === 'd1' && remoteStatus?.backend?.ready === true,
      estimatedRows: {
        total: finite(remoteQuota.estimatedRowsWritten),
        publication: finite(remoteQuota.publicationEstimatedRowsWritten),
        api: finite(remoteQuota.apiEstimatedRowsWritten),
      },
      limits: {
        total: finite(remoteLimits.totalEstimatedRows),
        publication: finite(remoteLimits.publicationEstimatedRows),
        appReserve: finite(remoteLimits.appReserveEstimatedRows),
      },
      resetsAt: remoteQuota.resetsAt || null,
    },
  };
  return assertAggregateMonitoringSafe(payload);
}
