import assert from 'node:assert/strict';
import test from 'node:test';

import { bootstrapTrackedChannel } from '../src/utils/channelBootstrap.mjs';

test('subscribes and retries when bootstrap reports an untracked channel', async () => {
  const calls = [];
  let attempt = 0;
  const result = await bootstrapTrackedChannel({
    deviceId: 'device-a',
    channelId: 'channel-a',
    bootstrapChannel: async (...args) => {
      calls.push(['bootstrap', ...args]);
      attempt += 1;
      return attempt === 1
        ? { ok: false, status: 404, error: 'Channel not tracked by this device' }
        : { ok: true, avatar: 'https://images.test/avatar.jpg', videos: [{ videoId: 'v1' }] };
    },
    subscribeChannel: async (...args) => {
      calls.push(['subscribe', ...args]);
      return { ok: true };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['bootstrap', 'device-a', 'channel-a'],
    ['subscribe', 'device-a', 'channel-a'],
    ['bootstrap', 'device-a', 'channel-a'],
  ]);
});

test('does not subscribe for unrelated bootstrap failures', async () => {
  let subscriptions = 0;
  const expected = { ok: false, status: 404, error: 'Device not registered' };
  const result = await bootstrapTrackedChannel({
    deviceId: 'device-a',
    channelId: 'channel-a',
    bootstrapChannel: async () => expected,
    subscribeChannel: async () => {
      subscriptions += 1;
      return { ok: true };
    },
  });

  assert.equal(result, expected);
  assert.equal(subscriptions, 0);
});

test('returns the original bootstrap failure with subscription diagnostics when repair fails', async () => {
  const result = await bootstrapTrackedChannel({
    deviceId: 'device-a',
    channelId: 'channel-a',
    bootstrapChannel: async () => ({
      ok: false,
      status: 404,
      error: 'Channel not tracked by this device',
    }),
    subscribeChannel: async () => ({ ok: false, error: 'Device not registered' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Channel not tracked by this device');
  assert.equal(result.subscriptionError, 'Device not registered');
});
