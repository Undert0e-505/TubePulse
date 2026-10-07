import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAggregateMonitoringSafe,
  collectAggregateMonitoring,
  deviceIdFromTerminalKey,
} from '../src/aggregate-monitoring.mjs';

class MemoryAdapter {
  constructor(values) { this.values = new Map(Object.entries(values)); }
  async listKeys() { return [...this.values.keys()].map((name) => ({ name })); }
  async get(name) { return this.values.get(name) ?? null; }
}

test('aggregate monitoring counts profiles and subscriptions without exposing records', async () => {
  const now = Date.parse('2026-10-06T12:00:00.000Z');
  const adapter = new MemoryAdapter({
    'device:private-install-a:profile': JSON.stringify({
      fcmToken: 'private-fcm-token-a', appVersion: '4.0.0',
      createdAt: now - 60_000, lastSeenAt: now - 60_000,
    }),
    'device:private-install-b:profile': JSON.stringify({
      fcmToken: null, appVersion: '3.5.2',
      createdAt: now - 40 * 86_400_000, lastSeenAt: now - 8 * 86_400_000,
    }),
    'device:private-install-a:channels': JSON.stringify(['UCprivateOne', 'UCprivateTwo']),
    'device:private-install-b:channels': JSON.stringify([]),
    'channel:UCprivateOne:subscribers': JSON.stringify(['private-install-a']),
    'channel:UCprivateTwo:subscribers': JSON.stringify(['private-install-a']),
    'channels:active': JSON.stringify(['UCprivateOne', 'UCprivateTwo']),
    'channel:UCprivateOne:recent': JSON.stringify([{ title: 'private title', videoId: 'private-video' }]),
  });
  const payload = await collectAggregateMonitoring({
    adapter,
    nowMs: now,
    config: {
      youtubeDailyQuotaUnits: 10_000, youtubeQuotaReserveUnits: 1_000,
      youtubeStatisticsDailyQuotaUnits: 20_000, youtubeStatisticsReserveUnits: 2_000,
    },
    localStatus: {
      status: 'ready', mode: 'active', authority: { replication: { status: 'current' } },
      scheduler: {
        mode: 'active', lease: { state: 'held' }, lastMinuteJobs: { scheduledAt: now - 10_000 },
        notificationIntents: { pending: 2, overduePending: 1, oldestPendingAgeSeconds: 75 },
        youtubeDataApi: {
          sourceMode: 'youtube-data-api', statsMethod: 'videos.list', lastGoodAt: now - 30_000,
          quota: { general: { units: 12, failures: 1 }, statistics: { units: 4, failures: 0 } },
        },
      },
    },
    remoteStatus: {
      ok: true, replication: { status: 'current' }, pendingBackupKeys: 0,
      backend: { selected: 'd1', ready: true }, quota: {
        estimatedRowsWritten: 10, publicationEstimatedRowsWritten: 8, apiEstimatedRowsWritten: 2,
        limits: { totalEstimatedRows: 50_000, publicationEstimatedRows: 45_000, appReserveEstimatedRows: 5_000 },
      },
    },
  });

  assert.equal(payload.installs.registered, 2);
  assert.equal(payload.installs.new.h24, 1);
  assert.equal(payload.installs.active.h24, 1);
  assert.equal(payload.installs.pushCapable, 1);
  assert.deepEqual(payload.installs.appVersions, [
    { version: '3.5.2', count: 1 }, { version: '4.0.0', count: 1 },
  ]);
  assert.deepEqual(payload.subscriptions.perInstall, { mean: 1, p50: 0, p95: 2, max: 2, zero: 1 });
  assert.equal(payload.subscriptions.configuredMemberships, 2);
  assert.equal(payload.subscriptions.indexedMemberships, 2);
  assert.equal(payload.subscriptions.membershipMismatchCount, 0);
  assert.equal(payload.subscriptions.indexConsistent, true);
  assert.equal(payload.host.ready, true);
  assert.equal(payload.notifications.pending, 2);
  assert.equal(payload.notifications.durableBacklog, 1);
  assert.equal(payload.notifications.oldestPendingAgeSeconds, 75);
  assert.equal(payload.authority.backendReady, true);
  assertAggregateMonitoringSafe(payload);
  const serialized = JSON.stringify(payload);
  for (const secret of ['private-install', 'private-fcm', 'UCprivate', 'private title', 'private-video']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('aggregate monitoring preserves explicit zero and tolerates invalid rows', async () => {
  const payload = await collectAggregateMonitoring({
    adapter: new MemoryAdapter({
      'device:a:profile': '{invalid',
      'device:b:profile': JSON.stringify({ appVersion: 'unsafe version with spaces' }),
      'device:b:channels': 'null',
      'channels:active': 'null',
    }),
    localStatus: {}, remoteStatus: null, nowMs: 0,
  });
  assert.equal(payload.installs.registered, 1);
  assert.deepEqual(payload.installs.appVersions, [{ version: 'unknown', count: 1 }]);
  assert.equal(payload.subscriptions.configuredMemberships, 0);
  assert.equal(payload.subscriptions.indexConsistent, false);
  assert.equal(payload.subscriptions.integrityIssues.malformedDeviceChannelRecords, 1);
  assert.equal(payload.subscriptions.integrityIssues.malformedActiveChannelIndex, 1);
  assert.equal(payload.authority.pendingBackupKeys, 0);
});

test('subscription integrity compares both canonical directions rather than active-channel cardinality', async () => {
  const adapter = new MemoryAdapter({
    'device:install-a:profile': JSON.stringify({ appVersion: '4.0.0' }),
    'device:install-b:profile': JSON.stringify({ appVersion: '4.0.0' }),
    'device:install-a:channels': JSON.stringify(['channel-one']),
    'device:install-b:channels': JSON.stringify(['channel-one']),
    'channel:channel-one:subscribers': JSON.stringify(['install-a', 'install-b']),
    'channels:active': JSON.stringify(['channel-one']),
  });
  const payload = await collectAggregateMonitoring({ adapter, localStatus: {}, nowMs: 0 });

  assert.equal(payload.subscriptions.configuredMemberships, 2);
  assert.equal(payload.subscriptions.indexedMemberships, 2);
  assert.equal(payload.subscriptions.activeChannels, 1);
  assert.equal(payload.subscriptions.indexConsistent, true);
  assert.equal(payload.subscriptions.membershipMismatchCount, 0);
});

test('colon-containing device IDs contribute to every aggregate without leaking identifiers', async () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const installId = 'android:synthetic-install';
  const channels = Array.from({ length: 8 }, (_, index) => `synthetic-channel-${index}`);
  const values = {
    [`device:${installId}:profile`]: JSON.stringify({
      fcmToken: 'synthetic-token', appVersion: '4.0.0', createdAt: now - 60_000, lastSeenAt: now - 60_000,
    }),
    [`device:${installId}:channels`]: JSON.stringify(channels),
    'channels:active': JSON.stringify(channels),
    // This must not be mistaken for a profile just because its key ends that way.
    [`device:${installId}:state:profile`]: JSON.stringify({ unwatched: [] }),
  };
  for (const channel of channels) values[`channel:${channel}:subscribers`] = JSON.stringify([installId]);

  const payload = await collectAggregateMonitoring({
    adapter: new MemoryAdapter(values), localStatus: {}, nowMs: now,
  });
  assert.equal(payload.installs.registered, 1);
  assert.equal(payload.installs.active.h24, 1);
  assert.equal(payload.installs.pushCapable, 1);
  assert.equal(payload.subscriptions.configuredMemberships, 8);
  assert.equal(payload.subscriptions.indexedMemberships, 8);
  assert.equal(payload.subscriptions.indexConsistent, true);
  assert.equal(JSON.stringify(payload).includes(installId), false);
  assert.equal(JSON.stringify(payload).includes('synthetic-token'), false);
});

test('terminal device-key parsing allows colons but rejects other record families', () => {
  assert.equal(deviceIdFromTerminalKey('device:android:synthetic:profile', 'profile'), 'android:synthetic');
  assert.equal(deviceIdFromTerminalKey('device:android:synthetic:channels', 'channels'), 'android:synthetic');
  assert.equal(deviceIdFromTerminalKey('device:android:synthetic:state:profile', 'profile'), null);
  assert.equal(deviceIdFromTerminalKey('device::profile', 'profile'), null);
  assert.equal(deviceIdFromTerminalKey('device:android:synthetic:settings', 'profile'), null);
});

test('subscription integrity exposes anonymous directional and index drift only', async () => {
  const adapter = new MemoryAdapter({
    'device:profiled:profile': JSON.stringify({ appVersion: '4.0.0' }),
    'device:profiled:channels': JSON.stringify(['configured-only', 'duplicated', 'duplicated']),
    'device:missing-profile:channels': JSON.stringify(['orphan-configured']),
    'device:malformed:channels': '{invalid',
    'channel:indexed-only:subscribers': JSON.stringify(['profiled']),
    'channel:duplicated:subscribers': JSON.stringify(['profiled', 'profiled']),
    'channel:orphan-indexed:subscribers': JSON.stringify(['missing-profile']),
    'channel:malformed:subscribers': 'null',
    'channels:active': JSON.stringify(['configured-only', 'active-without-index', 'active-without-index']),
  });
  const payload = await collectAggregateMonitoring({ adapter, localStatus: {}, nowMs: 0 });
  const { subscriptions } = payload;

  assert.equal(subscriptions.indexConsistent, false);
  assert.equal(subscriptions.membershipMismatchCount, 4);
  assert.deepEqual(subscriptions.integrityIssues, {
    missingFromSubscriberIndex: 2,
    missingFromDeviceConfig: 2,
    activeChannelsWithNoSubscriberIndex: 2,
    configuredChannelsAbsentFromActive: 2,
    indexedChannelsAbsentFromActive: 3,
    deviceChannelRecordsWithoutProfile: 2,
    configuredMembershipsMissingProfile: 1,
    subscriberMembershipsMissingProfile: 1,
    duplicateConfiguredMemberships: 1,
    duplicateIndexedMemberships: 1,
    duplicateActiveChannels: 1,
    malformedDeviceChannelRecords: 1,
    malformedSubscriberIndexes: 1,
    malformedActiveChannelIndex: 0,
  });
  const serialized = JSON.stringify(payload);
  for (const identifier of ['profiled', 'configured-only', 'indexed-only', 'missing-profile']) {
    assert.equal(serialized.includes(identifier), false);
  }
});

test('privacy guard rejects identifier-bearing fields and channel-like strings', () => {
  assert.throws(() => assertAggregateMonitoringSafe({ deviceId: 'x' }), /forbidden field/);
  assert.throws(() => assertAggregateMonitoringSafe({ note: `UC${'a'.repeat(22)}` }), /channel identifier/);
});
