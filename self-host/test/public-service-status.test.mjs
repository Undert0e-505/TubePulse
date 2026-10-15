import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPublicServiceStatus } from '../src/public-service-status.mjs';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

function localStatus(overrides = {}) {
  const scheduler = {
    mode: 'active',
    lease: { state: 'held' },
    startedAt: new Date(NOW - 60 * 60_000).toISOString(),
    youtubeDataApi: { lastGoodAt: new Date(NOW - 60_000).toISOString(), lastError: null },
    lastError: null,
    lastNotificationDelivery: { barrier: 'passed' },
    notificationIntents: {
      overduePending: 0, sending: 0, callbackPending: 0, failed: 0,
    },
    preciseLiveWatch: { degraded: false },
    ...(overrides.scheduler || {}),
  };
  return {
    status: 'ready',
    mode: 'active',
    authority: { replication: { status: 'current' } },
    configuration: { notificationsEnabled: true, alignedVideoNotificationsEnabled: true },
    ...overrides,
    scheduler,
  };
}

test('fresh current active authority reports a privacy-safe healthy state', () => {
  const status = classifyPublicServiceStatus(localStatus(), { nowMs: NOW });
  assert.deepEqual(Object.keys(status), ['status', 'message', 'observedAt', 'since']);
  assert.equal(status.status, 'healthy');
  assert.equal(status.since, null);
  assert.equal(JSON.stringify(status).includes('scheduler'), false);
});

test('scheduler progress ages through degraded before outage at wallboard thresholds', () => {
  const withAge = (minutes) => localStatus({
    scheduler: { youtubeDataApi: { lastGoodAt: new Date(NOW - minutes * 60_000).toISOString() } },
  });
  assert.equal(classifyPublicServiceStatus(withAge(10.9), { nowMs: NOW }).status, 'healthy');
  assert.equal(classifyPublicServiceStatus(withAge(11), { nowMs: NOW }).status, 'degraded');
  assert.equal(classifyPublicServiceStatus(withAge(15.9), { nowMs: NOW }).status, 'degraded');
  assert.equal(classifyPublicServiceStatus(withAge(16), { nowMs: NOW }).status, 'outage');
});

test('missing notification capability, current authority, active scheduler or held lease is outage', () => {
  const cases = [
    { status: 'starting' },
    { mode: 'standby' },
    { authority: { replication: { status: 'stale', changedAt: new Date(NOW - 1_000).toISOString() } } },
    { scheduler: { mode: 'standby' } },
    { scheduler: { lease: { state: 'released' } } },
    { configuration: { notificationsEnabled: false, alignedVideoNotificationsEnabled: true } },
    { configuration: { notificationsEnabled: true, alignedVideoNotificationsEnabled: false } },
  ];
  for (const override of cases) {
    assert.equal(classifyPublicServiceStatus(localStatus(override), { nowMs: NOW }).status, 'outage');
  }
});

test('an isolated feed visibility mismatch is degraded while broad or old barrier faults are outages', () => {
  const observedAt = new Date(NOW - 2 * 60_000).toISOString();
  const isolated = classifyPublicServiceStatus(localStatus({ scheduler: {
    lastError: { at: new Date(NOW - 30 * 60_000).toISOString() },
    lastNotificationDelivery: {
      barrier: 'failed', reason: 'feed-not-visible', visibilityBlocked: 1,
      visibilityDevices: 1, visibilityChannels: 1, observedAt,
    },
    notificationIntents: { overduePending: 1, oldestPendingAgeSeconds: 120 },
  } }), { nowMs: NOW });
  assert.equal(isolated.status, 'degraded');
  assert.equal(isolated.since, observedAt, 'a retained unrelated scheduler error cannot date this mismatch');

  assert.equal(classifyPublicServiceStatus(localStatus({ scheduler: {
    lastNotificationDelivery: { barrier: 'failed' },
  } }), { nowMs: NOW }).status, 'outage');
  for (const scheduler of [
    {
      lastNotificationDelivery: {
        barrier: 'failed', reason: 'feed-not-visible', visibilityBlocked: 3,
        visibilityDevices: 1, visibilityChannels: 1,
      },
      notificationIntents: { overduePending: 3, oldestPendingAgeSeconds: 120 },
    },
    {
      lastNotificationDelivery: {
        barrier: 'failed', reason: 'feed-not-visible', visibilityBlocked: 2,
        visibilityDevices: 2, visibilityChannels: 2,
      },
      notificationIntents: { overduePending: 2, oldestPendingAgeSeconds: 120 },
    },
    {
      lastNotificationDelivery: {
        barrier: 'failed', reason: 'feed-not-visible', visibilityBlocked: 1,
        visibilityDevices: 1, visibilityChannels: 1,
      },
      notificationIntents: { overduePending: 1, oldestPendingAgeSeconds: 901 },
    },
  ]) assert.equal(classifyPublicServiceStatus(localStatus({ scheduler }), { nowMs: NOW }).status, 'outage');

  for (const scheduler of [
    { notificationIntents: { overduePending: 1 } },
    { notificationIntents: { sending: 1 } },
    { notificationIntents: { callbackPending: 1 } },
    { notificationIntents: { failed: 1 } },
  ]) {
    assert.equal(classifyPublicServiceStatus(localStatus({ scheduler }), { nowMs: NOW }).status, 'degraded');
  }
});

test('a scheduler error is ignored only after newer successful progress supersedes it', () => {
  const oldError = new Date(NOW - 2 * 60_000).toISOString();
  assert.equal(classifyPublicServiceStatus(localStatus({ scheduler: {
    lastError: { at: oldError },
    youtubeDataApi: { lastGoodAt: new Date(NOW - 60_000).toISOString() },
  } }), { nowMs: NOW }).status, 'healthy');
  assert.equal(classifyPublicServiceStatus(localStatus({ scheduler: {
    lastError: { at: new Date(NOW - 30_000).toISOString() },
    youtubeDataApi: { lastGoodAt: new Date(NOW - 60_000).toISOString() },
  } }), { nowMs: NOW }).status, 'outage');
});

test('a completed minute tick supersedes an older retained recovered lease error', () => {
  const errorAt = '2026-10-10T11:41:00.250Z';
  const completedAt = '2026-10-10T11:42:08.000Z';
  const status = classifyPublicServiceStatus(localStatus({ scheduler: {
    lastError: { at: errorAt, recovery: 'reconciled', recoveredAt: '2026-10-10T11:41:16.000Z' },
    youtubeDataApi: { lastGoodAt: '2026-10-10T11:40:43.000Z', lastError: null },
    lastSweep: { outcome: 'not-due', scheduledAt: '2026-10-10T11:42:00.000Z' },
    lastMinuteJobs: { scheduledAt: '2026-10-10T11:42:00.000Z', posts: { outcome: 'ok' } },
    lastNotificationDelivery: { barrier: 'not-needed', observedAt: completedAt },
  } }), { nowMs: Date.parse('2026-10-10T11:43:00.000Z') });
  assert.equal(status.status, 'healthy');

  const unresolved = classifyPublicServiceStatus(localStatus({ scheduler: {
    lastError: { at: '2026-10-10T11:42:30.000Z', recovery: 'pending' },
    youtubeDataApi: { lastGoodAt: '2026-10-10T11:40:43.000Z', lastError: null },
    lastSweep: { outcome: 'not-due', scheduledAt: '2026-10-10T11:42:00.000Z' },
    lastMinuteJobs: { scheduledAt: '2026-10-10T11:42:00.000Z' },
    lastNotificationDelivery: { barrier: 'not-needed', observedAt: completedAt },
  } }), { nowMs: Date.parse('2026-10-10T11:43:00.000Z') });
  assert.equal(unresolved.status, 'outage');
});

test('precise live degradation degrades the public service without exposing its reason', () => {
  const result = classifyPublicServiceStatus(localStatus({ scheduler: {
    preciseLiveWatch: { degraded: true, degradedReason: 'private-detail' },
  } }), { nowMs: NOW });
  assert.equal(result.status, 'degraded');
  assert.equal(JSON.stringify(result).includes('private-detail'), false);
});

test('a current YouTube detector error degrades until the successful cycle clears it', () => {
  const result = classifyPublicServiceStatus(localStatus({ scheduler: {
    youtubeDataApi: {
      lastGoodAt: new Date(NOW - 60_000).toISOString(),
      lastError: { at: new Date(NOW - 30_000).toISOString(), category: 'private-detail' },
    },
  } }), { nowMs: NOW });
  assert.equal(result.status, 'degraded');
  assert.equal(JSON.stringify(result).includes('private-detail'), false);
});
