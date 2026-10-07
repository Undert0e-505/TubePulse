import assert from 'node:assert/strict';
import test from 'node:test';
import { appWorker } from './tubepulse-api/index.js';

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
