import assert from 'node:assert/strict';
import test from 'node:test';

import apiWorker from './tubepulse-api/index.js';

class MemoryKV {
  constructor(entries = {}) {
    this.entries = new Map(
      Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)])
    );
  }

  async get(key, type) {
    const value = this.entries.get(key);
    if (value == null) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }

  async put(key, value) {
    this.entries.set(key, value);
  }

  async delete(key) {
    this.entries.delete(key);
  }

  async list({ prefix = '' } = {}) {
    return {
      keys: [...this.entries.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
    };
  }
}

const DEVICE_ID = 'secure:test-device';
const CHANNEL_ID = 'UC_test_channel';
const META_KEY = `channel:${CHANNEL_ID}:meta`;
const RECENT = [{ videoId: 'video-1', title: 'Existing video' }];

function youtubeChannelResponse() {
  return new Response(JSON.stringify({
    items: [{
      id: CHANNEL_ID,
      snippet: {
        title: 'Repaired channel name',
        thumbnails: { high: { url: 'https://images.test/repaired-avatar.jpg' } },
      },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function request(path, body) {
  return new Request(`https://pilot.test${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DEVICE_ID}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

test('subscribe repairs a null avatar without replacing cached videos or metadata timestamps', async () => {
  const addedAt = 123456;
  const kv = new MemoryKV({
    [`device:${DEVICE_ID}:profile`]: { createdAt: 1 },
    [`channel:${CHANNEL_ID}:subscribers`]: ['another-device'],
    [META_KEY]: {
      name: 'Cached channel name',
      avatarUrl: null,
      lastVideoId: 'video-1',
      addedAt,
    },
    [`channel:${CHANNEL_ID}:recent`]: RECENT,
  });
  const originalFetch = globalThis.fetch;
  let youtubeCalls = 0;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /www\.googleapis\.com\/youtube\/v3\/channels/);
    youtubeCalls += 1;
    return youtubeChannelResponse();
  };

  try {
    const response = await apiWorker.fetch(
      request('/subscribe-channel', { channelId: CHANNEL_ID }),
      { TUBEPULSE_KV: kv, YOUTUBE_API_KEY: 'test-key' },
      { waitUntil() {} }
    );
    const body = await response.json();
    const storedMeta = await kv.get(META_KEY, 'json');

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.channel.meta.avatarUrl, 'https://images.test/repaired-avatar.jpg');
    assert.deepEqual(body.channel.recent, RECENT);
    assert.equal(storedMeta.addedAt, addedAt);
    assert.equal(storedMeta.lastVideoId, 'video-1');
    assert.equal(youtubeCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('bootstrap repairs incomplete metadata for an already tracked channel', async () => {
  const kv = new MemoryKV({
    [`device:${DEVICE_ID}:profile`]: { createdAt: 1 },
    [`device:${DEVICE_ID}:channels`]: [CHANNEL_ID],
    [META_KEY]: {
      name: 'Cached channel name',
      avatarUrl: null,
      lastVideoId: 'video-1',
      addedAt: 123456,
    },
    [`channel:${CHANNEL_ID}:recent`]: RECENT,
    [`channel:${CHANNEL_ID}:websub`]: { leaseExpiresAt: Date.now() + 10000 },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => youtubeChannelResponse();

  try {
    const response = await apiWorker.fetch(
      request('/bootstrap', { channelId: CHANNEL_ID }),
      { TUBEPULSE_KV: kv, YOUTUBE_API_KEY: 'test-key' },
      { waitUntil() {} }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.avatar, 'https://images.test/repaired-avatar.jpg');
    assert.deepEqual(body.videos, RECENT);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
