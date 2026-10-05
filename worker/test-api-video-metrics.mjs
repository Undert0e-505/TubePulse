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

const DEVICE_ID = 'secure:metrics-device';
const CHANNEL_ID = 'UC_metrics_channel';

function subscribeRequest() {
  return new Request('https://pilot.test/subscribe-channel', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DEVICE_ID}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channelId: CHANNEL_ID }),
  });
}

async function subscribeWithDataApi(likes) {
  const kv = new MemoryKV({
    [`device:${DEVICE_ID}:profile`]: { createdAt: 1 },
    [`device:${DEVICE_ID}:channels`]: [],
  });
  const originalFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes('/youtube/v3/channels')) {
      const url = new URL(requestUrl);
      if (url.searchParams.get('part') === 'snippet') return Response.json({ items: [{ id: CHANNEL_ID, snippet: { title: 'Metrics channel' } }] });
      return Response.json({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU_metrics_channel' } } }] });
    }
    if (requestUrl.includes('/youtube/v3/playlistItems')) {
      return Response.json({ items: [{
        snippet: { title: 'Latest video', publishedAt: '2026-10-04T07:00:00Z', thumbnails: { high: { url: 'https://images.test/video.jpg' } } },
        contentDetails: { videoId: 'video-latest', videoPublishedAt: '2026-10-04T07:00:00Z' },
        status: { privacyStatus: 'public' },
      }] });
    }
    if (requestUrl.includes('/youtube/v3/videos')) {
      return Response.json({ items: [{ id: 'video-latest', statistics: { viewCount: '1234', ...(likes == null ? {} : { likeCount: likes }) } }] });
    }
    if (requestUrl.startsWith('https://pubsubhubbub.appspot.com/')) {
      return new Response('', { status: 202 });
    }
    throw new Error(`Unexpected fetch in metrics test: ${requestUrl}`);
  };

  try {
    const response = await apiWorker.fetch(
      subscribeRequest(),
      { TUBEPULSE_KV: kv, YOUTUBE_API_KEY: 'synthetic-key' },
      { waitUntil(promise) { pending.push(promise); } }
    );
    await Promise.all(pending);
    return {
      response,
      body: await response.json(),
      stored: await kv.get(`channel:${CHANNEL_ID}:recent`, 'json'),
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('uploads playlist bootstrap preserves a real public like count', async () => {
  const { response, body, stored } = await subscribeWithDataApi('42');

  assert.equal(response.status, 200);
  assert.equal(body.channel.recent[0].views, '1234');
  assert.equal(body.channel.recent[0].likes, '42');
  assert.equal(stored[0].likes, '42');
  assert.equal(stored[0].dislikes, null);
  assert.equal(Number.isInteger(stored[0].viewsLastCheckedHour), true);
  assert.equal(Number.isInteger(stored[0].likesLastCheckedHour), true);
});

test('uploads playlist bootstrap keeps a hidden or unavailable like count unknown', async () => {
  const { response, body, stored } = await subscribeWithDataApi(null);

  assert.equal(response.status, 200);
  assert.equal(body.channel.recent[0].likes, null);
  assert.equal(stored[0].likes, null);
  assert.notEqual(stored[0].likes, '0');
});
