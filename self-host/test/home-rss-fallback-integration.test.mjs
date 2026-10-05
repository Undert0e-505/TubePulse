import assert from 'node:assert/strict';
import test from 'node:test';
import { pollSingleRssChannel, processChannelUploads } from '../../worker/tubepulse-rss-0/index.js';

class MemoryKv {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); this.puts = []; }
  async get(name, type = 'text') {
    const value = this.values.has(name) ? this.values.get(name) : null;
    return type === 'json' && value !== null ? JSON.parse(value) : value;
  }
  async put(name, value) { this.puts.push(name); this.values.set(name, String(value)); }
  async delete(name) { this.values.delete(name); }
}

class Context {
  constructor() { this.pending = []; }
  waitUntil(value) { this.pending.push(Promise.resolve(value)); }
  async flush() { await Promise.all(this.pending); }
}

function upload(videoId, published, title = videoId) {
  return {
    videoId, title, published, thumbnail: null,
    link: `https://www.youtube.com/watch?v=${videoId}`,
    channelTitle: 'Synthetic', views: null, likes: null, dislikes: null,
  };
}

test('explicit RSS 404 is surfaced once without an immediate retry', async () => {
  let calls = 0;
  await assert.rejects(
    () => pollSingleRssChannel({ TUBEPULSE_KV: new MemoryKv() }, new Context(), 'UC0000000000000000000000', {
      failOnFetchError: true,
      fetchImpl: async () => { calls++; return new Response('not found', { status: 404 }); },
    }),
    (error) => error.category === 'http-404' && error.retryable === false,
  );
  assert.equal(calls, 1);
});

test('first API fallback observation seeds a missing watermark and never sends an old-content notification', async () => {
  const channelId = 'UC0000000000000000000000';
  const kv = new MemoryKv({
    [`channel:${channelId}:subscribers`]: JSON.stringify(['device-one']),
    'device:device-one:profile': JSON.stringify({ fcmToken: 'synthetic-token' }),
  });
  const notifications = [];
  const env = {
    TUBEPULSE_KV: kv,
    TUBEPULSE_NOTIFICATION_MODE: 'shadow',
    FIREBASE_SERVICE_ACCOUNT: '{"project_id":"test"}',
    TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER: async (intent) => notifications.push(intent),
  };
  const ctx = new Context();
  const result = await processChannelUploads(env, ctx, channelId, {
    channelName: 'Synthetic',
    uploads: [upload('abcdefghijk', '2026-10-05T01:00:00.000Z')],
  }, { now: Date.parse('2026-10-05T01:05:00.000Z') });
  await ctx.flush();
  assert.equal(result.outcome, 'seeded');
  assert.equal(notifications.length, 0);
  const known = JSON.parse(kv.values.get(`channel:${channelId}:known:videos`));
  assert.deepEqual(known.ids, ['abcdefghijk']);
});

test('API fallback and recovered RSS share one watermark so the same upload cannot push twice', async () => {
  const channelId = 'UC0000000000000000000000';
  const knownKey = `channel:${channelId}:known:videos`;
  const kv = new MemoryKv({
    [knownKey]: JSON.stringify({
      ids: ['oldvideo001'],
      highWatermarkAt: '2026-10-05T00:00:00.000Z',
      highWatermarkIds: ['oldvideo001'],
      seededAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
    }),
    [`channel:${channelId}:recent`]: JSON.stringify([upload('oldvideo001', '2026-10-05T00:00:00.000Z')]),
    [`channel:${channelId}:subscribers`]: JSON.stringify(['device-one']),
    'device:device-one:profile': JSON.stringify({ fcmToken: 'synthetic-token' }),
    'device:device-one:settings': JSON.stringify({ mode: 'chill' }),
    [`device:device-one:state:${channelId}`]: JSON.stringify({ unwatched: [], lastNagAt: null, nagCount: 0 }),
  });
  const notifications = [];
  const env = {
    TUBEPULSE_KV: kv,
    TUBEPULSE_NOTIFICATION_MODE: 'shadow',
    FIREBASE_SERVICE_ACCOUNT: '{"project_id":"test"}',
    TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER: async (intent) => notifications.push(intent),
  };
  const source = {
    channelName: 'Synthetic',
    uploads: [
      upload('newvideo001', '2026-10-05T01:00:00.000Z', 'New upload'),
      upload('oldvideo001', '2026-10-05T00:00:00.000Z', 'Old upload'),
    ],
  };
  let ctx = new Context();
  const apiResult = await processChannelUploads(env, ctx, channelId, source, {
    now: Date.parse('2026-10-05T01:01:00.000Z'),
  });
  await ctx.flush();
  assert.equal(apiResult.outcome, 'new-content');
  assert.equal(notifications.length, 1);

  ctx = new Context();
  const rssResult = await processChannelUploads(env, ctx, channelId, source, {
    now: Date.parse('2026-10-05T01:02:00.000Z'),
  });
  await ctx.flush();
  assert.equal(rssResult.outcome, 'unchanged');
  assert.equal(notifications.length, 1, 'recovered RSS must not emit a duplicate push');
  const state = JSON.parse(kv.values.get(`device:device-one:state:${channelId}`));
  assert.deepEqual(state.unwatched, ['newvideo001']);
});

test('video batch notification carries exact string content IDs and effective tap action', async () => {
  const channelId = 'UC0000000000000000000000';
  const kv = new MemoryKv({
    [`channel:${channelId}:known:videos`]: JSON.stringify({
      ids: ['oldvideo001'], highWatermarkAt: '2026-10-05T00:00:00.000Z',
      highWatermarkIds: ['oldvideo001'], seededAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
    }),
    [`channel:${channelId}:recent`]: JSON.stringify([upload('oldvideo001', '2026-10-05T00:00:00.000Z')]),
    [`channel:${channelId}:subscribers`]: JSON.stringify(['device-one']),
    'device:device-one:profile': JSON.stringify({ fcmToken: 'synthetic-token' }),
    'device:device-one:settings': JSON.stringify({ mode: 'chill', tapAction: 'channel' }),
    [`device:device-one:state:${channelId}`]: JSON.stringify({ unwatched: [], lastNagAt: null, nagCount: 0 }),
  });
  const notifications = [];
  const env = {
    TUBEPULSE_KV: kv,
    TUBEPULSE_NOTIFICATION_MODE: 'shadow',
    TUBEPULSE_NOTIFICATION_DEFERRED: true,
    FIREBASE_SERVICE_ACCOUNT: '{"project_id":"test"}',
    TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER: async (intent) => notifications.push(intent),
  };

  await processChannelUploads(env, new Context(), channelId, {
    channelName: 'Synthetic',
    uploads: [
      upload('newvideo002', '2026-10-05T02:00:00.000Z'),
      upload('newvideo001', '2026-10-05T01:00:00.000Z'),
      upload('oldvideo001', '2026-10-05T00:00:00.000Z'),
    ],
  }, { now: Date.parse('2026-10-05T02:01:00.000Z') });

  assert.equal(notifications.length, 1);
  const data = notifications[0].payload.data;
  assert.equal(data.type, 'batch');
  assert.equal(data.count, '2');
  assert.equal(data.tapAction, 'channel');
  assert.equal(typeof data.contentIds, 'string');
  assert.deepEqual(JSON.parse(data.contentIds), ['newvideo002', 'newvideo001']);
});

test('new upload preserves complete channel metadata instead of rewriting lastVideoId', async () => {
  const channelId = 'UC0000000000000000000000';
  const knownKey = `channel:${channelId}:known:videos`;
  const recentKey = `channel:${channelId}:recent`;
  const metaKey = `channel:${channelId}:meta`;
  const meta = { name: 'Synthetic', avatarUrl: 'https://example.test/avatar.jpg', lastVideoId: 'oldvideo001', addedAt: 1 };
  const kv = new MemoryKv({
    [knownKey]: JSON.stringify({
      ids: ['oldvideo001'], highWatermarkAt: '2026-10-05T00:00:00.000Z',
      highWatermarkIds: ['oldvideo001'], seededAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
    }),
    [recentKey]: JSON.stringify([upload('oldvideo001', '2026-10-05T00:00:00.000Z')]),
    [metaKey]: JSON.stringify(meta),
    [`channel:${channelId}:subscribers`]: '[]',
  });
  await processChannelUploads({ TUBEPULSE_KV: kv }, new Context(), channelId, {
    channelName: 'Synthetic',
    uploads: [
      upload('newvideo001', '2026-10-05T01:00:00.000Z'),
      upload('oldvideo001', '2026-10-05T00:00:00.000Z'),
    ],
  }, { now: Date.parse('2026-10-05T01:01:00.000Z'), logPrefix: 'YouTube API' });
  assert.equal(JSON.parse(kv.values.get(recentKey))[0].videoId, 'newvideo001');
  assert.ok(JSON.parse(kv.values.get(knownKey)).ids.includes('newvideo001'));
  assert.deepEqual(JSON.parse(kv.values.get(metaKey)), meta);
  assert.equal(kv.puts.includes(metaKey), false);
});
