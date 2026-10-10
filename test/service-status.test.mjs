import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  SERVICE_STATUS_CACHE_KEY,
  normalizeServiceStatus,
  readCachedServiceStatus,
  serviceStatusPresentation,
  shouldRefreshServiceStatus,
  unavailableServiceStatus,
  writeCachedServiceStatus,
} from '../src/utils/serviceStatus.mjs';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

test('public service status accepts only its small schema and canonical user copy', () => {
  const result = normalizeServiceStatus({
    status: 'healthy',
    message: 'internal host details must not win',
    observedAt: new Date(NOW - 30_000).toISOString(),
    since: null,
    deviceId: 'must-not-survive',
  }, { nowMs: NOW, checkedAt: NOW });
  assert.deepEqual(result, {
    status: 'healthy',
    message: 'Service healthy',
    observedAt: new Date(NOW - 30_000).toISOString(),
    since: null,
    checkedAt: new Date(NOW).toISOString(),
  });
});

test('stale or future observations become unknown instead of preserving any prior state', () => {
  for (const [status, observedAt] of [
    ['healthy', NOW - 17 * 60_000],
    ['outage', NOW - 17 * 60_000],
    ['healthy', NOW + 61_000],
  ]) {
    assert.equal(normalizeServiceStatus({
      status, observedAt: new Date(observedAt).toISOString(), since: null,
    }, { nowMs: NOW, checkedAt: NOW }).status, 'unknown');
  }
});

test('loading is visually blank while known states remain a compact one-line pair', () => {
  assert.deepEqual(serviceStatusPresentation(null, { nowMs: NOW }), {
    status: 'checking', label: '', freshness: '',
  });
  const presentation = serviceStatusPresentation({
    status: 'degraded', observedAt: new Date(NOW - 60_000).toISOString(),
    checkedAt: new Date(NOW - 2 * 60_000).toISOString(), since: null,
  }, { nowMs: NOW });
  assert.deepEqual(presentation, {
    status: 'degraded', label: 'Notifications may be delayed', freshness: 'Checked 2m ago',
  });
});

test('network failure becomes unknown without manufacturing an outage', () => {
  const prior = { checkedAt: new Date(NOW - 5 * 60_000).toISOString() };
  const result = unavailableServiceStatus(prior, { nowMs: NOW });
  assert.equal(result.status, 'unknown');
  assert.equal(result.checkedAt, prior.checkedAt);
  assert.deepEqual(serviceStatusPresentation(result, { nowMs: NOW }), {
    status: 'unknown', label: 'Service status unavailable', freshness: 'Last checked 5m ago',
  });
});

test('cache hydration and refresh TTL are deterministic', async () => {
  const values = new Map();
  const storage = {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
  };
  const value = normalizeServiceStatus({
    status: 'healthy', observedAt: new Date(NOW).toISOString(), since: null,
  }, { nowMs: NOW, checkedAt: NOW });
  await writeCachedServiceStatus(storage, value);
  assert.equal(values.has(SERVICE_STATUS_CACHE_KEY), true);
  assert.deepEqual(await readCachedServiceStatus(storage, { nowMs: NOW + 30_000 }), value);
  assert.equal(shouldRefreshServiceStatus(value, { nowMs: NOW + 59_999 }), false);
  assert.equal(shouldRefreshServiceStatus(value, { nowMs: NOW + 60_000 }), true);
});

test('Settings keeps one fixed quiet row before its first section', () => {
  const source = readFileSync(new URL('../src/screens/SettingsScreen.js', import.meta.url), 'utf8');
  const card = source.indexOf('style={styles.serviceStatusCard}');
  const firstSection = source.indexOf('{/* Tap Action */}');
  assert.ok(card > 0 && card < firstSection);
  assert.match(source, /serviceStatusCard:\s*\{[\s\S]*?height: 38,[\s\S]*?backgroundColor: COLORS\.surface,[\s\S]*?borderColor: COLORS\.border,/);
  assert.match(source, /serviceStatusText:\s*\{[\s\S]*?flex: 1,[\s\S]*?minWidth: 0,[\s\S]*?flexShrink: 1,/);
  assert.match(source, /serviceStatusFreshness:\s*\{[\s\S]*?flexShrink: 0,/);
  assert.match(source, /numberOfLines=\{1\}/g);
  assert.doesNotMatch(source, /serviceStatusCard[^}]*backgroundColor:\s*COLORS\.(?:danger|warning|success)/);
  assert.match(source, /accessible=\{Boolean\(servicePresentation\.label\)\}/);
  assert.match(source, /accessibilityLabel=\{servicePresentation\.label[\s\S]*?: undefined\}/);
  assert.doesNotMatch(source, /'Checking service status'/);
});
