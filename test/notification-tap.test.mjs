import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyOptimisticNotificationSeen,
  notificationTapPlan,
  parseNotificationContentIds,
} from '../src/utils/notificationTap.mjs';

test('single video honors valid payload action and falls back to the watch URL', () => {
  assert.deepEqual(notificationTapPlan({
    videoId: 'video-1', channelId: 'channel-1', tapAction: 'video',
  }, { localTapAction: 'channel', handle: 'creator' }), {
    kind: 'video',
    url: 'https://www.youtube.com/watch?v=video-1',
    contentIds: ['video-1'],
    clearAll: false,
  });

  const invalidPayload = notificationTapPlan({
    videoId: 'video-1', channelId: 'channel-1', tapAction: 'invalid',
  }, { localTapAction: 'channel', handle: null });
  assert.equal(invalidPayload.kind, 'channel');
  assert.equal(invalidPayload.url, 'https://www.youtube.com/channel/channel-1');
  assert.equal(invalidPayload.clearAll, true);
});

test('batch notifications always open the channel and parse exact string IDs defensively', () => {
  const plan = notificationTapPlan({
    type: 'batch', count: '2', channelId: 'channel-1',
    contentIds: '["video-1","post:post-2","video-1"]',
  }, { localTapAction: 'video', handle: 'creator' });
  assert.equal(plan.kind, 'batch');
  assert.equal(plan.url, 'https://www.youtube.com/@creator');
  assert.deepEqual(plan.contentIds, ['video-1', 'post:post-2']);
  assert.equal(plan.clearAll, false);

  assert.deepEqual(parseNotificationContentIds({ contentIds: 'not-json', videoIds: '["fallback"]' }), ['fallback']);
  assert.equal(notificationTapPlan({ type: 'batch', channelId: 'channel-1' }).clearAll, true);
  assert.equal(notificationTapPlan({ count: '2', channelId: 'channel-1' }).kind, 'batch');
});

test('optimistic exact seen update covers cached videos, latest video and namespaced posts', () => {
  const originalCache = {
    creator: {
      videos: [
        { videoId: 'video-1', unwatched: true },
        { videoId: 'video-2', unwatched: true },
      ],
      latestVideo: { videoId: 'video-1', unwatched: true },
      posts: [{ activityId: 'post-2', unwatched: true }],
    },
  };
  const result = applyOptimisticNotificationSeen({
    channels: [{ handle: 'creator', channelId: 'channel-1' }],
    cache: originalCache,
    lastSeen: { creator: { seenIds: ['older'] } },
    channelId: 'channel-1',
    contentIds: ['video-1', 'post:post-2'],
  });

  assert.deepEqual(result.lastSeen.creator.seenIds, ['older', 'video-1', 'post:post-2']);
  assert.equal(result.cache.creator.videos[0].unwatched, false);
  assert.equal(result.cache.creator.videos[1].unwatched, true);
  assert.equal(result.cache.creator.latestVideo.unwatched, false);
  assert.equal(result.cache.creator.posts[0].unwatched, false);
  assert.equal(originalCache.creator.videos[0].unwatched, true, 'the pure helper must not mutate cached input');
});

test('legacy clear-all marks every cached content item seen', () => {
  const result = applyOptimisticNotificationSeen({
    channels: [{ handle: 'creator', channelId: 'channel-1' }],
    cache: {
      creator: {
        videos: [{ videoId: 'video-1', unwatched: true }],
        posts: [{ postId: 'post-1', unwatched: true }],
      },
    },
    lastSeen: {},
    channelId: 'channel-1',
    clearAll: true,
  });
  assert.deepEqual(new Set(result.lastSeen.creator.seenIds), new Set(['video-1', 'post:post-1']));
  assert.equal(result.cache.creator.videos[0].unwatched, false);
  assert.equal(result.cache.creator.posts[0].unwatched, false);
});
