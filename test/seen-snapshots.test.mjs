import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectChannelUnseenSnapshots,
  collectUnseenContentSnapshot,
} from '../src/utils/seenSnapshots.mjs';

test('channel/global Home actions capture only the current unseen video and post IDs', () => {
  const videos = [
    { videoId: 'v-new', unwatched: true },
    { videoId: 'v-seen', unwatched: false },
  ];
  const posts = [
    { activityId: 'p-new', unwatched: true },
    { activityId: 'p-seen', unwatched: false },
  ];
  const snapshot = collectUnseenContentSnapshot(videos, posts);
  assert.deepEqual(snapshot, ['v-new', 'post:p-new']);

  videos.unshift({ videoId: 'later-arrival', unwatched: true });
  assert.deepEqual(snapshot, ['v-new', 'post:p-new']);
  assert.deepEqual(collectUnseenContentSnapshot(videos, posts), [
    'later-arrival', 'v-new', 'post:p-new',
  ]);
});

test('global Home snapshot freezes every channel before asynchronous processing begins', () => {
  const state = new Map([
    ['one', [{ videoId: 'one-old', unwatched: true }]],
    ['two', [{ videoId: 'two-old', unwatched: true }]],
  ]);
  const snapshots = collectChannelUnseenSnapshots([
    { handle: 'one', channelId: 'UC1' },
    { handle: 'two', channelId: 'UC2' },
  ], (handle) => state.get(handle), () => []);

  state.get('two').unshift({ videoId: 'two-after-tap', unwatched: true });
  assert.deepEqual(snapshots, [
    { handle: 'one', channelId: 'UC1', contentIds: ['one-old'] },
    { handle: 'two', channelId: 'UC2', contentIds: ['two-old'] },
  ]);
});
