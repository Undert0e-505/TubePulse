import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupDeadChannel } from './tubepulse-cron/shared.mjs';
import { processChannelUploads } from './tubepulse-rss-0/index.js';
import { appWorker } from './tubepulse-api/index.js';

const DEVICE = 'synthetic-device';
const OTHER_DEVICE = 'synthetic-other-device';
const CHANNEL = 'UC0000000000000000000000';

class MemoryKV {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]));
  }

  async get(key, type) {
    const value = this.entries.get(key);
    if (value == null) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }

  async put(key, value) { this.entries.set(key, String(value)); }
  async delete(key) { this.entries.delete(key); }
  async list() { return { keys: [], list_complete: true }; }
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
