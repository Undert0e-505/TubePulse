import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectPendingSeenIds,
  selectEffectiveChannelUnseen,
} from '../src/utils/effectiveUnseen.mjs';
import {
  notifyLocalSeenChanged,
  subscribeLocalSeenChanges,
} from '../src/utils/localSeenEvents.js';

function video(videoId, unwatched = true) {
  return { videoId, unwatched };
}

test('hidden older server-unseen content cannot leave controls visible after every represented dot clears', () => {
  const state = selectEffectiveChannelUnseen({
    videos: [video('v3', false), video('v2', false), video('v1', false), video('hidden-old', true)],
    maxVideos: 3,
  });
  assert.deepEqual(state.videos, []);
  assert.equal(state.hasUnseen, false);
  assert.deepEqual(state.contentIds, []);
});

test('local and pending exact-ID overlays drive dots and controls from the same state', () => {
  const pendingSeenIds = collectPendingSeenIds({
    intents: [{ channelId: 'UC1', contentIds: ['v2'] }],
  });
  const state = selectEffectiveChannelUnseen({
    videos: [video('v3'), video('v2'), video('v1')],
    maxVideos: 3,
    locallySeenIds: ['v3'],
    pendingSeenIds,
  });
  assert.deepEqual(state.videos.map(({ videoId }) => videoId), ['v1']);
  assert.equal(state.hasUnseen, true);
  assert.deepEqual(state.contentIds, ['v1']);
});

test('final channel and final global state follow the same effective selector', () => {
  const channelOne = selectEffectiveChannelUnseen({
    videos: [video('one')], maxVideos: 3, locallySeenIds: ['one'],
  });
  const channelTwo = selectEffectiveChannelUnseen({
    videos: [video('two')], maxVideos: 3, pendingSeenIds: ['two'],
  });
  assert.equal(channelOne.hasUnseen, false);
  assert.equal(channelTwo.hasUnseen, false);
  assert.equal([channelOne, channelTwo].some(({ hasUnseen }) => hasUnseen), false);

  const otherChannelStillUnseen = selectEffectiveChannelUnseen({
    videos: [video('other')], maxVideos: 3,
  });
  assert.equal([channelOne, otherChannelStillUnseen].some(({ hasUnseen }) => hasUnseen), true);
});

test('a newer arrival not represented by an older action remains unseen', () => {
  const state = selectEffectiveChannelUnseen({
    videos: [video('new-arrival'), video('old-represented')],
    maxVideos: 3,
    locallySeenIds: ['old-represented'],
  });
  assert.deepEqual(state.contentIds, ['new-arrival']);
  assert.equal(state.hasUnseen, true);
});

test('offline pending and later successful retry never resurrect the acknowledged item', () => {
  const offline = selectEffectiveChannelUnseen({
    videos: [video('v1')], maxVideos: 3, pendingSeenIds: ['v1'],
  });
  const retryAcceptedAwaitingFeed = selectEffectiveChannelUnseen({
    videos: [video('v1')], maxVideos: 3, locallySeenIds: ['v1'],
  });
  const serverConfirmed = selectEffectiveChannelUnseen({
    videos: [video('v1', false)], maxVideos: 3,
  });
  assert.equal(offline.hasUnseen, false);
  assert.equal(retryAcceptedAwaitingFeed.hasUnseen, false);
  assert.equal(serverConfirmed.hasUnseen, false);
});

test('posts share the exact-ID overlay and representation rule', () => {
  const state = selectEffectiveChannelUnseen({
    posts: [
      { activityId: 'visible', unwatched: true, visible: true },
      { activityId: 'locally-seen', unwatched: true, visible: true },
      { activityId: 'not-represented', unwatched: true, visible: false },
    ],
    locallySeenIds: ['post:locally-seen'],
    isPostRepresented: (post) => post.visible,
  });
  assert.deepEqual(state.contentIds, ['post:visible']);
});

test('a mounted Home subscriber receives the exact optimistic invalidation snapshot', () => {
  const received = [];
  const unsubscribe = subscribeLocalSeenChanges((change) => received.push(change));
  try {
    notifyLocalSeenChanged({ channelId: 'UC1', contentIds: ['v1'] });
  } finally {
    unsubscribe();
  }
  assert.deepEqual(received, [{ channelId: 'UC1', contentIds: ['v1'] }]);
});
