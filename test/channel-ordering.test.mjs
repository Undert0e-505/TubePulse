import assert from 'node:assert/strict';
import test from 'node:test';

import { newestCachedVideoTimestamp, orderChannels } from '../src/utils/channelOrdering.mjs';

const channels = [
  { handle: 'manual-first', channelId: 'one' },
  { handle: 'newest', channelId: 'two' },
  { handle: 'undated', channelId: 'three' },
  { handle: 'tied', channelId: 'four' },
];

test('automatic ordering uses only newest cached video timestamps', () => {
  const cache = {
    'manual-first': {
      videos: [{ videoId: 'old', publishedAt: '2026-10-01T10:00:00Z' }],
      posts: [{ activityId: 'post-new', publishedAt: '2026-10-05T10:00:00Z' }],
    },
    newest: {
      videos: [{ videoId: 'new', published: '2026-10-04T10:00:00Z' }],
    },
    undated: {
      videos: [{ videoId: 'bad', publishedAt: 'not-a-date' }],
      posts: [{ activityId: 'post-newer', publishedAt: '2026-10-06T10:00:00Z' }],
    },
    tied: {
      latestVideo: { videoId: 'tie', publishedAt: '2026-10-01T10:00:00Z' },
    },
  };

  assert.equal(newestCachedVideoTimestamp(channels[0], cache), Date.parse('2026-10-01T10:00:00Z'));
  assert.deepEqual(
    orderChannels(channels, cache, true).map((channel) => channel.handle),
    ['newest', 'manual-first', 'tied', 'undated'],
  );
});

test('manual ordering is returned unchanged when automatic ordering is disabled', () => {
  const ordered = orderChannels(channels, {
    newest: { latestVideo: { publishedAt: '2026-10-05T10:00:00Z' } },
  }, false);
  assert.deepEqual(ordered, channels);
  assert.notEqual(ordered, channels, 'callers receive a display copy and cannot mutate stored order accidentally');
});

test('ties and channels without valid video dates retain deterministic manual order', () => {
  const cache = {
    'manual-first': { latestVideo: { publishedAt: '2026-10-05T10:00:00Z' } },
    newest: { latestVideo: { published: '2026-10-05T10:00:00Z' } },
  };
  assert.deepEqual(
    orderChannels(channels, cache, true).map((channel) => channel.handle),
    ['manual-first', 'newest', 'undated', 'tied'],
  );
});
