import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runAuxTick,
  selectNagActiveBatch,
  selectRemindableContent,
} from './tubepulse-aux/index.js';
import { ProductionNotificationCoordinator } from '../self-host/src/home-scheduler-notifications.mjs';

class MemoryKv {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
    this.writes = [];
  }

  async get(name, type) {
    const value = this.values.get(name);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }

  async put(name, value) {
    this.values.set(name, value);
    this.writes.push(name);
  }

  async delete(name) {
    this.values.delete(name);
    this.writes.push(name);
  }
}

function json(value) {
  return JSON.stringify(value);
}

test('time-derived nag batches cover entries beyond the first five without state writes', () => {
  const entries = Array.from({ length: 17 }, (_, index) => `device-${index}|channel-${index}`);
  const seen = new Set();
  const base = 60_000 * 1000;
  for (let minute = 0; minute < entries.length; minute++) {
    const batch = selectNagActiveBatch(entries, base + minute * 60_000);
    assert.equal(batch.length, 5);
    for (const entry of batch) seen.add(entry);
  }
  assert.deepEqual([...seen].sort(), [...entries].sort());
  assert.deepEqual(entries, Array.from({ length: 17 }, (_, index) => `device-${index}|channel-${index}`));
});

test('remindable content retains full state but selects only three visible videos and eligible posts', () => {
  const state = { unwatched: ['v1', 'v2', 'v3', 'v4', 'v5', 'post:p1'] };
  const result = selectRemindableContent({
    state,
    recent: ['v1', 'v2', 'v3', 'v4'].map((videoId, index) => ({
      videoId,
      publishedAt: `2026-10-0${4 - index}T00:00:00Z`,
    })),
    recentPosts: [{ id: 'post:p1', activityId: 'p1', publishedAt: '2026-10-05T00:00:00Z' }],
    includeCommunityPosts: true,
  });
  assert.deepEqual(result.contentIds, ['v1', 'v2', 'v3', 'post:p1']);
  assert.deepEqual(state.unwatched, ['v1', 'v2', 'v3', 'v4', 'v5', 'post:p1']);
  assert.deepEqual(selectRemindableContent({
    state,
    recent: ['v1', 'v2', 'v3', 'v4'].map((videoId, index) => ({
      videoId,
      publishedAt: `2026-10-0${4 - index}T00:00:00Z`,
    })),
    recentPosts: [{ id: 'post:p1', activityId: 'p1', publishedAt: '2026-10-05T00:00:00Z' }],
    includeCommunityPosts: false,
  }).contentIds, ['v1', 'v2', 'v3']);
});

test('post reminders mirror Home screen latest-content visibility semantics', () => {
  const state = { unwatched: ['video', 'post:older', 'post:newer', 'post:undated'] };
  const dated = selectRemindableContent({
    state,
    recent: [{ videoId: 'video', publishedAt: '2026-10-05T00:00:00Z' }],
    recentPosts: [
      { id: 'post:older', activityId: 'older', publishedAt: '2026-10-04T00:00:00Z' },
      { id: 'post:newer', activityId: 'newer', publishedAt: '2026-10-06T00:00:00Z' },
      { id: 'post:undated', activityId: 'undated' },
    ],
    includeCommunityPosts: true,
  });
  assert.deepEqual(dated.contentIds, ['video', 'post:newer']);

  const datedPostUndatedVideo = selectRemindableContent({
    state: { unwatched: ['video', 'post:newer'] },
    recent: [{ videoId: 'video' }],
    recentPosts: [{ id: 'post:newer', activityId: 'newer', publishedAt: '2026-10-06T00:00:00Z' }],
    includeCommunityPosts: true,
  });
  assert.deepEqual(datedPostUndatedVideo.contentIds, ['video', 'post:newer']);

  const bothUndated = selectRemindableContent({
    state: { unwatched: ['video', 'post:undated'] },
    recent: [{ videoId: 'video' }],
    recentPosts: [{ id: 'post:undated', activityId: 'undated' }],
    includeCommunityPosts: true,
  });
  assert.deepEqual(bothUndated.contentIds, ['video']);

  const noVideo = selectRemindableContent({
    state: { unwatched: ['post:undated'] },
    recent: [],
    recentPosts: [{ id: 'post:undated', activityId: 'undated' }],
    includeCommunityPosts: true,
  });
  assert.deepEqual(noVideo.contentIds, ['post:undated']);
});

test('host nag is transient, visibility-gated, and advances its watermark exactly once after send', async () => {
  const deviceId = 'device-one';
  const channelId = 'UC-current';
  const stateKey = `device:${deviceId}:state:${channelId}`;
  const unwatched = ['v1', 'v2', 'v3', 'v4', 'post:p1'];
  const kv = new MemoryKv({
    'nag:active': json([`${deviceId}|${channelId}`]),
    [`device:${deviceId}:profile`]: json({ fcmToken: 'fcm-one' }),
    [`device:${deviceId}:settings`]: json({ mode: 'chill', includeCommunityPosts: true }),
    [stateKey]: json({ unwatched, lastNagAt: null, nagCount: 0 }),
    [`channel:${channelId}:meta`]: json({ name: 'Current channel' }),
    [`channel:${channelId}:recent`]: json([
      { videoId: 'v1', title: 'One', publishedAt: '2026-10-04T00:00:00Z' },
      { videoId: 'v2', title: 'Two', publishedAt: '2026-10-03T00:00:00Z' },
      { videoId: 'v3', title: 'Three', publishedAt: '2026-10-02T00:00:00Z' },
      { videoId: 'v4', title: 'Four', publishedAt: '2026-10-01T00:00:00Z' },
    ]),
    [`channel:${channelId}:recent:posts`]: json([{
      id: 'post:p1', activityId: 'p1', text: 'Post', publishedAt: '2026-10-05T00:00:00Z',
    }]),
  });
  const intents = [];
  const now = 1_800_000_000_000;
  const env = {
    TUBEPULSE_KV: kv,
    TUBEPULSE_NOTIFICATION_MODE: 'shadow',
    TUBEPULSE_NOTIFICATION_DEFERRED: true,
    TUBEPULSE_ENABLE_COMMUNITY_POSTS: 'true',
    FIREBASE_SERVICE_ACCOUNT: json({ project_id: 'project-one' }),
    TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER: async (intent) => intents.push(intent),
  };
  await runAuxTick(env, { waitUntil() {} }, now);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, 'nag');
  assert.deepEqual(intents[0].contentIds, ['v1', 'v2', 'v3', 'post:p1']);
  assert.equal(intents[0].payload.data.count, '4');
  assert.deepEqual(JSON.parse(intents[0].payload.data.contentIds), intents[0].contentIds);
  assert.deepEqual(JSON.parse(kv.values.get(stateKey)).unwatched, unwatched);
  assert.equal(kv.writes.includes(stateKey), false, 'queuing a transient nag must not advance state');

  let sendAttempts = 0;
  let sendSucceeds = false;
  const coordinator = new ProductionNotificationCoordinator({
    gatewayConvergenceRequired: false,
    apiBaseUrl: 'https://api.example.test',
    timeoutMs: 1000,
    retryCount: 0,
    retryBackoffMs: 1,
  }, {
    fetchImpl: async () => new Response(json({
      channels: [{
        channelId,
        videos: ['v1', 'v2', 'v3'].map((videoId) => ({ videoId, unwatched: true })),
        posts: [{ activityId: 'p1', unwatched: true }],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    tokenProvider: async () => 'access-token',
    sender: async () => {
      sendAttempts++;
      return { sent: sendSucceeds, deadToken: false };
    },
  });
  const failedDelivery = await coordinator.flush(intents, env);
  assert.equal(failedDelivery.sent, 0);
  assert.equal(failedDelivery.failed, 1);
  assert.equal(JSON.parse(kv.values.get(stateKey)).lastNagAt, null);
  assert.equal(JSON.parse(kv.values.get(stateKey)).nagCount, 0);
  assert.equal((await coordinator.intentStore.summary()).pending, 0);

  sendSucceeds = true;
  const delivery = await coordinator.flush(intents, env);
  assert.equal(delivery.sent, 1);
  assert.equal(sendAttempts, 2);
  assert.equal(delivery.barrier, 'passed');
  assert.equal(delivery.transientExpired, 0);
  assert.equal((await coordinator.intentStore.summary()).pending, 0);
  const updated = JSON.parse(kv.values.get(stateKey));
  assert.equal(updated.lastNagAt, now);
  assert.equal(updated.nagCount, 1);
  assert.deepEqual(updated.unwatched, unwatched);
  assert.equal(kv.writes.filter((name) => name === stateKey).length, 1);
});
