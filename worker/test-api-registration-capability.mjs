import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appWorker,
  touchExistingDeviceActivity,
} from './tubepulse-api/index.js';

const LAST_SEEN_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

class MemoryKV {
  constructor() {
    this.entries = new Map();
    this.puts = 0;
  }
  async get(key, type) {
    const value = this.entries.get(key);
    if (value == null) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) { this.puts++; this.entries.set(key, value); }
  async delete(key) { this.entries.delete(key); }
  async list() { return { keys: [], list_complete: true }; }
}

function registration(body) {
  return new Request('https://api.test/register', {
    method: 'POST',
    headers: { Authorization: 'Bearer secure:test-device', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('register persists only the recognized local renderer capability without repeated writes', async () => {
  const kv = new MemoryKV();
  const env = { TUBEPULSE_KV: kv };
  let response = await appWorker.fetch(registration({
    fcmToken: null,
    platform: 'android',
    appVersion: '4.0.0',
    notificationCapability: 'local-v1',
  }), env, {});
  assert.equal(response.status, 200);
  let profile = await kv.get('device:secure:test-device:profile', 'json');
  assert.equal(profile.notificationCapability, 'local-v1');
  const firstPuts = kv.puts;

  response = await appWorker.fetch(registration({
    fcmToken: null,
    platform: 'android',
    appVersion: '4.0.0',
    notificationCapability: 'local-v1',
  }), env, {});
  assert.equal(response.status, 200);
  assert.equal(kv.puts, firstPuts);

  await appWorker.fetch(registration({
    fcmToken: null,
    platform: 'android',
    appVersion: '4.0.0',
    notificationCapability: 'unknown-v2',
  }), env, {});
  profile = await kv.get('device:secure:test-device:profile', 'json');
  assert.equal(profile.notificationCapability, null);
});

test('released clients without a capability remain explicitly legacy', async () => {
  const kv = new MemoryKV();
  await appWorker.fetch(registration({ fcmToken: null, platform: 'android', appVersion: '4.0.0' }), {
    TUBEPULSE_KV: kv,
  }, {});
  const profile = await kv.get('device:secure:test-device:profile', 'json');
  assert.equal(profile.notificationCapability, null);
});

test('activity touch refreshes only a stale existing profile and preserves every other field', async () => {
  const kv = new MemoryKV();
  const now = 10 * LAST_SEEN_REFRESH_INTERVAL_MS;
  const original = {
    fcmToken: 'synthetic-token', platform: 'android', appVersion: '4.1.0',
    notificationCapability: 'local-v1', createdAt: 123, lastSeenAt: now - LAST_SEEN_REFRESH_INTERVAL_MS,
    futureProfileField: { preserved: true },
  };
  kv.entries.set('device:secure:test-device:profile', JSON.stringify(original));

  const stale = await touchExistingDeviceActivity({ TUBEPULSE_KV: kv }, 'secure:test-device', { now });
  assert.deepEqual(stale, {
    profilePresent: true, touched: true, retryAfterMs: LAST_SEEN_REFRESH_INTERVAL_MS,
  });
  assert.deepEqual(await kv.get('device:secure:test-device:profile', 'json'), { ...original, lastSeenAt: now });
  assert.equal(kv.puts, 1);

  const fresh = await touchExistingDeviceActivity({ TUBEPULSE_KV: kv }, 'secure:test-device', {
    now: now + LAST_SEEN_REFRESH_INTERVAL_MS - 1,
  });
  assert.equal(fresh.touched, false);
  assert.equal(fresh.retryAfterMs, 1);
  assert.equal(kv.puts, 1, 'a profile may be persisted at most once per installation per hour');
});

test('activity touch never creates a missing profile and its internal route is not public', async () => {
  const kv = new MemoryKV();
  const missing = await touchExistingDeviceActivity({ TUBEPULSE_KV: kv }, 'secure:missing-device', { now: 123 });
  assert.deepEqual(missing, { profilePresent: false, touched: false, retryAfterMs: 0 });
  assert.equal(kv.puts, 0);

  const response = await appWorker.fetch(new Request('https://api.test/_tubepulse/activity-touch', {
    method: 'POST', headers: { Authorization: 'Bearer secure:missing-device' }, body: '{}',
  }), { TUBEPULSE_KV: kv }, {});
  assert.equal(response.status, 404);
  assert.equal(kv.puts, 0);
});
