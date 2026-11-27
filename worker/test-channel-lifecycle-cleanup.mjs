import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cancelDeadDeviceCleanup,
  cleanupDeadChannel,
  cleanupDeadDevice,
  drainDeadDeviceCleanupQueue,
} from './tubepulse-cron/shared.mjs';
import { processChannelUploads } from './tubepulse-rss-0/index.js';
import { appWorker } from './tubepulse-api/index.js';

const DEVICE = 'synthetic-device';
const OTHER_DEVICE = 'synthetic-other-device';
const CHANNEL = 'UC0000000000000000000000';

class MemoryKV {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]));
    this.mutations = [];
  }

  async get(key, type) {
    const value = this.entries.get(key);
    if (value == null) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }

  async put(key, value) { this.entries.set(key, String(value)); this.mutations.push(['put', key]); }
  async delete(key) { this.entries.delete(key); this.mutations.push(['delete', key]); }
  async list(options = {}) {
    const prefix = String(options.prefix || '');
    return {
      keys: [...this.entries.keys()].filter((name) => name.startsWith(prefix)).sort().map((name) => ({ name })),
      list_complete: true,
    };
  }
}

function key(suffix) { return `channel:${CHANNEL}:${suffix}`; }

function unsubscribeRequest() {
  return new Request('https://api.test/unsubscribe', {
    method: 'POST',
    headers: { Authorization: `Bearer ${DEVICE}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channelId: CHANNEL }),
  });
}

async function unsubscribe(kv) {
  const work = [];
  const response = await appWorker.fetch(unsubscribeRequest(), {
    TUBEPULSE_KV: kv,
    TUBEPULSE_DISABLE_WEBSUB: 'true',
  }, { waitUntil(promise) { work.push(promise); } });
  await Promise.all(work);
  return response;
}

function channelEntries(subscribers) {
  return {
    [`device:${DEVICE}:profile`]: { platform: 'android' },
    [`device:${DEVICE}:channels`]: [CHANNEL],
    [`device:${DEVICE}:state:${CHANNEL}`]: { unwatched: ['old-video'] },
    [`device:${DEVICE}:nag-ledger`]: { schemaVersion: 1, channels: { [CHANNEL]: { lastNagAt: 100, nagCount: 1 } } },
    [`device:${DEVICE}:override:${CHANNEL}`]: { mode: 'chill' },
    [key('meta')]: { name: 'Test channel' },
    [key('recent')]: [{ videoId: 'old-video' }],
    [key('known:videos')]: { ids: ['old-video'], highWatermarkAt: '2026-01-01T00:00:00.000Z' },
    [key('subscribers')]: subscribers,
    'channels:active': [CHANNEL],
  };
}

test('last-subscriber API cleanup removes the known-video lifecycle watermark', async () => {
  const kv = new MemoryKV(channelEntries([DEVICE]));
  const response = await unsubscribe(kv);

  assert.equal(response.status, 200);
  assert.equal(await kv.get(key('known:videos'), 'json'), null);
  assert.equal(await kv.get(key('meta'), 'json'), null);
  assert.equal(await kv.get(key('recent'), 'json'), null);
  assert.equal(await kv.get(key('subscribers'), 'json'), null);
  assert.deepEqual(await kv.get('channels:active', 'json'), []);
});

test('unsubscribe preserves shared and active channel state while another subscriber remains', async () => {
  const kv = new MemoryKV(channelEntries([DEVICE, OTHER_DEVICE]));
  const response = await unsubscribe(kv);

  assert.equal(response.status, 200);
  assert.deepEqual(await kv.get(key('known:videos'), 'json'), {
    ids: ['old-video'], highWatermarkAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(await kv.get(key('subscribers'), 'json'), [OTHER_DEVICE]);
  assert.deepEqual(await kv.get('channels:active', 'json'), [CHANNEL]);
  assert.deepEqual(await kv.get(key('meta'), 'json'), { name: 'Test channel' });
  assert.equal(await kv.get(`device:${DEVICE}:state:${CHANNEL}`, 'json'), null);
  assert.deepEqual(await kv.get(`device:${DEVICE}:nag-ledger`, 'json'), { schemaVersion: 1, channels: {} });
});

test('a fully cleaned and re-added channel silently seeds current uploads', async () => {
  const kv = new MemoryKV(channelEntries([DEVICE]));
  await cleanupDeadChannel(CHANNEL, { TUBEPULSE_KV: kv }, 'test-last-subscriber');

  assert.equal(await kv.get(key('known:videos'), 'json'), null);
  // The unsubscribe/dead-device caller owns per-device state cleanup after
  // the shared channel helper has removed the channel lifecycle records.
  await kv.delete(`device:${DEVICE}:state:${CHANNEL}`);

  await kv.put(key('subscribers'), JSON.stringify([DEVICE]));
  await kv.put('channels:active', JSON.stringify([CHANNEL]));
  const uploads = [
    {
      videoId: 'newest-video', title: 'Newest', published: '2026-10-07T19:00:00.000Z',
      publishedAt: '2026-10-07T19:00:00.000Z', thumbnail: null,
      link: 'https://www.youtube.com/watch?v=newest-video', type: 'video',
    },
    {
      videoId: 'older-video', title: 'Older', published: '2026-10-07T18:00:00.000Z',
      publishedAt: '2026-10-07T18:00:00.000Z', thumbnail: null,
      link: 'https://www.youtube.com/watch?v=older-video', type: 'video',
    },
  ];

  const result = await processChannelUploads({ TUBEPULSE_KV: kv }, { waitUntil() {} }, CHANNEL, {
    channelName: 'Test channel', uploads,
  }, { now: Date.parse('2026-10-07T19:01:00.000Z'), logPrefix: 'Test' });

  assert.equal(result.outcome, 'seeded');
  assert.deepEqual((await kv.get(key('known:videos'), 'json')).ids, ['newest-video', 'older-video']);
  assert.equal(await kv.get(`device:${DEVICE}:state:${CHANNEL}`, 'json'), null);
});

test('dead-device cleanup removes every device-scoped notification index without touching another device', async () => {
  const token = 'synthetic-token';
  const kv = new MemoryKV({
    ...channelEntries([DEVICE, OTHER_DEVICE]),
    [`device:${DEVICE}:profile`]: { platform: 'android', fcmToken: token },
    [`fcm:lookup:${token}`]: DEVICE,
    'nag:active': [`${DEVICE}|${CHANNEL}`, `${DEVICE}|other-channel`, `${OTHER_DEVICE}|${CHANNEL}`],
    [`upcoming:prewarn:video-a:${DEVICE}`]: 60,
    [`upcoming:prewarn:video-b:${OTHER_DEVICE}`]: 60,
  });

  const env = { TUBEPULSE_KV: kv };
  await cleanupDeadDevice(DEVICE, env, 'test-fixture');

  assert.equal(await kv.get(`device:${DEVICE}:profile`, 'json'), null);
  assert.deepEqual((await kv.get(`cleanup:dead-device:${DEVICE}`, 'json')).remainingChannels, [CHANNEL]);
  assert.deepEqual(await kv.get(key('subscribers'), 'json'), [DEVICE, OTHER_DEVICE]);

  await drainDeadDeviceCleanupQueue(env);

  assert.equal(await kv.get(`device:${DEVICE}:nag-ledger`, 'json'), null);
  assert.equal(await kv.get(`cleanup:dead-device:${DEVICE}`, 'json'), null);
  assert.equal(await kv.get(`fcm:lookup:${token}`, 'json'), null);
  assert.deepEqual(await kv.get('nag:active', 'json'), [`${OTHER_DEVICE}|${CHANNEL}`]);
  assert.equal(await kv.get(`upcoming:prewarn:video-a:${DEVICE}`, 'json'), null);
  assert.equal(await kv.get(`upcoming:prewarn:video-b:${OTHER_DEVICE}`, 'json'), 60);
  assert.deepEqual(await kv.get(key('subscribers'), 'json'), [OTHER_DEVICE]);
});

test('large dead installations drain in authority-safe bounded batches', async () => {
  const channels = Array.from({ length: 99 }, (_, index) => `UC${String(index).padStart(22, '0')}`);
  const entries = {
    [`device:${DEVICE}:profile`]: { platform: 'android', fcmToken: 'dead-token' },
    [`device:${DEVICE}:settings`]: { mode: 'relentless' },
    [`device:${DEVICE}:channels`]: channels,
    [`device:${DEVICE}:nag-ledger`]: { schemaVersion: 1, channels: {} },
    'fcm:lookup:dead-token': DEVICE,
    'nag:active': channels.map((channelId) => `${DEVICE}|${channelId}`),
    'channels:active': channels,
  };
  for (const channelId of channels) {
    entries[`channel:${channelId}:subscribers`] = [DEVICE];
    entries[`channel:${channelId}:meta`] = { name: channelId };
    entries[`channel:${channelId}:recent`] = [];
    entries[`channel:${channelId}:known:videos`] = { ids: [] };
    entries[`device:${DEVICE}:state:${channelId}`] = { unwatched: ['video'] };
    entries[`device:${DEVICE}:override:${channelId}`] = { mode: 'relentless' };
  }
  const kv = new MemoryKV(entries);
  const env = { TUBEPULSE_KV: kv };

  await cleanupDeadDevice(DEVICE, env);
  assert.equal(await kv.get(`device:${DEVICE}:profile`, 'json'), null);
  assert.equal((await kv.get(`cleanup:dead-device:${DEVICE}`, 'json')).remainingChannels.length, 99);

  let runs = 0;
  while (await kv.get(`cleanup:dead-device:${DEVICE}`, 'json')) {
    kv.mutations = [];
    const result = await drainDeadDeviceCleanupQueue(env);
    assert.ok(result.processedChannels <= 20);
    assert.ok(kv.mutations.length < 250, `cleanup batch used ${kv.mutations.length} mutations`);
    runs++;
    assert.ok(runs <= 5);
  }
  assert.equal(runs, 5);
  assert.equal(await kv.get(`device:${DEVICE}:channels`, 'json'), null);
  assert.deepEqual(await kv.get('channels:active', 'json'), []);
});

test('a returning installation cancels cleanup and restores detached subscriber indexes', async () => {
  const secondChannel = 'UC1111111111111111111111';
  const kv = new MemoryKV({
    ...channelEntries([DEVICE]),
    [`device:${DEVICE}:channels`]: [CHANNEL, secondChannel],
    [`channel:${secondChannel}:subscribers`]: [DEVICE],
    [`channel:${secondChannel}:meta`]: { name: 'Second channel' },
    [`channel:${secondChannel}:recent`]: [],
    [`channel:${secondChannel}:known:videos`]: { ids: [] },
    'channels:active': [CHANNEL, secondChannel],
  });
  const env = { TUBEPULSE_KV: kv };
  await cleanupDeadDevice(DEVICE, env);
  await drainDeadDeviceCleanupQueue(env, { channelLimit: 1 });
  assert.equal(await kv.get(key('subscribers'), 'json'), null);

  await kv.put(`device:${DEVICE}:profile`, JSON.stringify({ platform: 'android', fcmToken: 'new-token' }));
  assert.equal(await cancelDeadDeviceCleanup(DEVICE, env), true);
  assert.equal(await kv.get(`cleanup:dead-device:${DEVICE}`, 'json'), null);
  assert.deepEqual(await kv.get(key('subscribers'), 'json'), [DEVICE]);
  assert.deepEqual(new Set(await kv.get('channels:active', 'json')), new Set([CHANNEL, secondChannel]));
});
