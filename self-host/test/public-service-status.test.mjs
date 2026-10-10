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

test('a notification barrier fault is outage while actionable retained work is degraded', () => {
  assert.equal(classifyPublicServiceStatus(localStatus({ scheduler: {
    lastNotificationDelivery: { barrier: 'failed' },
  } }), { nowMs: NOW }).status, 'outage');
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
