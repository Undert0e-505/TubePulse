import assert from 'node:assert/strict';
import test from 'node:test';
import { pollSingleRssChannel } from '../../worker/tubepulse-rss-0/index.js';

class JsonKv {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); }
  async get(name, type = 'text') {
    const value = this.values.has(name) ? this.values.get(name) : null;
    return value !== null && type === 'json' ? JSON.parse(value) : value;
  }
  async put(name, value) { this.values.set(name, String(value)); }
  async delete(name) { this.values.delete(name); }
}

function feed(channelId, videoId, published) {
  return `<?xml version="1.0" encoding="UTF-8"?>
  <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
    <yt:channelId>${channelId}</yt:channelId><author><name>Test Channel</name></author>
    <entry><yt:videoId>${videoId}</yt:videoId><title>New video</title>
      <link rel="alternate" href="https://www.youtube.com/watch?v=${videoId}"/>
      <published>${published}</published><updated>${published}</updated>
      <media:group><media:thumbnail url="https://example.invalid/thumb.jpg"/>
      <media:statistics views="10"/><media:starRating count="2"/></media:group>
    </entry>
  </feed>`;
}

test('imported watermark suppresses old content and a new item is shadow-counted exactly once', async () => {
  const channelId = 'UC0000000000000000000000';
  const deviceId = 'synthetic-device';
  const oldVideo = 'old-video';
  const newVideo = 'new-video';
  const kv = new JsonKv({
    [`channel:${channelId}:known:videos`]: JSON.stringify({
      ids: [oldVideo],
      highWatermarkAt: '2026-10-01T00:00:00.000Z',
      highWatermarkIds: [oldVideo],
      seededAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }),
    [`channel:${channelId}:subscribers`]: JSON.stringify([deviceId]),
    [`device:${deviceId}:profile`]: JSON.stringify({ fcmToken: 'synthetic-fcm' }),
    [`device:${deviceId}:settings`]: JSON.stringify({ mode: 'chill' }),
  });
  let wouldNotify = 0;
  const env = {
    TUBEPULSE_KV: kv,
    TUBEPULSE_NOTIFICATION_MODE: 'shadow',
    FIREBASE_SERVICE_ACCOUNT: '{"project_id":"synthetic"}',
    TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER: () => { wouldNotify++; },
  };
  const ctx = { waitUntil() {} };
  const originalFetch = globalThis.fetch;
  let currentXml = feed(channelId, oldVideo, '2026-10-01T00:00:00.000Z');
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (!String(url).startsWith('https://www.youtube.com/feeds/videos.xml')) {
      throw new Error('Shadow poll attempted an unexpected network request');
    }
    return new Response(currentXml, { status: 200, headers: { 'Content-Type': 'application/xml' } });
  };
  try {
    await pollSingleRssChannel(env, ctx, channelId);
    assert.equal(wouldNotify, 0, 'canonical watermark must suppress existing content');
    currentXml = feed(channelId, newVideo, '2026-10-02T00:00:00.000Z');
    await pollSingleRssChannel(env, ctx, channelId);
    assert.equal(wouldNotify, 1, 'new content should be measured as one would-send');
    await pollSingleRssChannel(env, ctx, channelId);
    assert.equal(wouldNotify, 1, 'durable watermark must suppress a duplicate sweep');
    assert.equal(urls.some((url) => url.includes('fcm.googleapis.com')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
