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

function rssFeed({ likes }) {
  const rating = likes == null
    ? ''
    : `<media:starRating count="${likes}" average="5.00" min="1" max="5"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
      <yt:channelId>${CHANNEL_ID}</yt:channelId>
      <author><name>Metrics channel</name></author>
      <entry>
        <yt:videoId>video-latest</yt:videoId>
        <title>Latest video</title>
        <link rel="alternate" href="https://www.youtube.com/watch?v=video-latest"/>
        <published>2026-10-04T07:00:00+00:00</published>
        <updated>2026-10-04T07:30:00+00:00</updated>
        <media:thumbnail url="https://images.test/video.jpg"/>
        <media:statistics views="1234"/>
        ${rating}
      </entry>
    </feed>`;
}

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

async function subscribeWithRss(likes) {
  const kv = new MemoryKV({
    [`device:${DEVICE_ID}:profile`]: { createdAt: 1 },
    [`device:${DEVICE_ID}:channels`]: [],
  });
  const originalFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes('youtube.com/feeds/videos.xml')) {
      return new Response(rssFeed({ likes }), {
        status: 200,
        headers: { 'content-type': 'application/atom+xml' },
      });
    }
    if (requestUrl.startsWith('https://pubsubhubbub.appspot.com/')) {
      return new Response('', { status: 202 });
    }
    throw new Error(`Unexpected fetch in metrics test: ${requestUrl}`);
  };

  try {
    const response = await apiWorker.fetch(
      subscribeRequest(),
      { TUBEPULSE_KV: kv },
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

test('RSS bootstrap preserves a real public like count', async () => {
  const { response, body, stored } = await subscribeWithRss('42');

  assert.equal(response.status, 200);
  assert.equal(body.channel.recent[0].views, '1234');
  assert.equal(body.channel.recent[0].likes, '42');
  assert.equal(stored[0].likes, '42');
  assert.equal(stored[0].dislikes, null);
  assert.equal(Number.isInteger(stored[0].viewsLastCheckedHour), true);
  assert.equal(Number.isInteger(stored[0].likesLastCheckedHour), true);
});

test('RSS bootstrap keeps a hidden or unavailable like count unknown', async () => {
  const { response, body, stored } = await subscribeWithRss(null);

  assert.equal(response.status, 200);
  assert.equal(body.channel.recent[0].likes, null);
  assert.equal(stored[0].likes, null);
  assert.notEqual(stored[0].likes, '0');
});
