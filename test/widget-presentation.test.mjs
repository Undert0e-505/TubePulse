import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { orderChannels } from '../src/utils/channelOrdering.mjs';
import {
  normalizeWidgetVideo,
  projectWidgetOrderingCache,
  selectWidgetChannelPresentation,
} from '../src/utils/widgetPresentation.mjs';

const video = (id, publishedAt, unwatched = true) => ({ videoId: id, publishedAt, unwatched });
const post = (id, publishedAt, unwatched = true) => ({ activityId: id, publishedAt, unwatched });

test('multiple unseen videos produce exactly the newest combined widget item', () => {
  const result = selectWidgetChannelPresentation({
    videos: [video('older', '2026-10-01T00:00:00Z'), video('newest', '2026-10-02T00:00:00Z')],
  });
  assert.equal(result.unseenCount, 2);
  assert.equal(result.selected.type, 'video');
  assert.equal(result.selected.item.videoId, 'newest');
});

test('a newer post beats the newest video', () => {
  const result = selectWidgetChannelPresentation({
    videos: [video('video', '2026-10-01T00:00:00Z')],
    posts: [post('post', '2026-10-03T00:00:00Z')],
  });
  assert.equal(result.selected.type, 'post');
  assert.equal(result.selected.item.activityId, 'post');
});

test('a newer seen item beats an older unseen item without losing unseen count', () => {
  const result = selectWidgetChannelPresentation({
    videos: [video('older-unseen', '2026-10-01T00:00:00Z', true)],
    posts: [post('newer-seen', '2026-10-03T00:00:00Z', false)],
  });
  assert.equal(result.unseenCount, 1);
  assert.equal(result.selected.type, 'post');
  assert.equal(result.selected.seen, true);
});

test('an empty channel is safe and selects no row', () => {
  assert.deepEqual(selectWidgetChannelPresentation(), { selected: null, unseenCount: 0 });
});

test('widget video normalization preserves nullable comment totals including zero', () => {
  assert.equal(normalizeWidgetVideo({ comments: '0' }).comments, '0');
  assert.equal(normalizeWidgetVideo({ comments: '1200' }).comments, '1200');
  assert.equal(normalizeWidgetVideo({ comments: null }).comments, null);
  assert.equal(normalizeWidgetVideo({}).comments, null);
});

test('widget auto-order uses newest cached video or post while off preserves manual order', () => {
  const channels = [{ handle: 'manual-first' }, { handle: 'post-newest' }, { handle: 'video-middle' }];
  const cache = {
    'manual-first': { videos: [video('old', '2026-10-01T00:00:00Z')] },
    'post-newest': { posts: [post('new-post', '2026-10-03T00:00:00Z')] },
    'video-middle': { videos: [video('mid-video', '2026-10-02T00:00:00Z')] },
  };
  const orderingCache = projectWidgetOrderingCache(cache);
  assert.deepEqual(
    orderChannels(channels, orderingCache, true).map((channel) => channel.handle),
    ['post-newest', 'video-middle', 'manual-first'],
  );
  assert.deepEqual(
    orderChannels(channels, orderingCache, false).map((channel) => channel.handle),
    ['manual-first', 'post-newest', 'video-middle'],
  );
});

test('widget uses the proven non-collection container with one selected row per channel', () => {
  const widgetSource = readFileSync(new URL('../src/components/TubePulseWidget.js', import.meta.url), 'utf8');
  const handlerSource = readFileSync(new URL('../src/components/widgetTaskHandler.js', import.meta.url), 'utf8');
  const homeSource = readFileSync(new URL('../src/screens/HomeScreen.js', import.meta.url), 'utf8');
  const channelsSource = readFileSync(new URL('../src/screens/ChannelsScreen.js', import.meta.url), 'utf8');

  assert.equal(widgetSource.includes('ListWidget'), false);
  assert.match(widgetSource, /channels\.map\(\(ch\) => \([\s\S]*<ChannelSection/);
  assert.match(widgetSource, /const item = channel\.videos\[0\][\s\S]*channel\.posts\[0\]/);
  assert.equal((widgetSource.match(/<VideoRow\b/g) || []).length, 1);
  assert.equal((widgetSource.match(/<PostRow\b/g) || []).length, 1);
  assert.match(handlerSource, /selected\?\.type === 'video' \? \[\{/);
  assert.match(handlerSource, /selected\?\.type === 'post' \? \[\{/);
  assert.match(handlerSource, /cached\.videos\.map\(normalizeWidgetVideo\)/);
  assert.match(widgetSource, /const commentLabel = hasKnownMetric\(video\.comments\) \? formatCompactCount\(video\.comments\) : null/);
  assert.match(widgetSource, /likeLabel[\s\S]*THUMB_UP_SVG[\s\S]*commentLabel[\s\S]*COMMENT_SVG[\s\S]*video\.views/);
  assert.match(widgetSource, /video\.timeAgo \|\| video\.views \|\| likeLabel \|\| commentLabel/);
  assert.equal(homeSource.includes('ListWidget'), false);
  assert.equal(homeSource.includes('selectWidgetChannelPresentation'), false);
  assert.match(handlerSource, /orderChannels\([\s\S]*widgetOrderingCache[\s\S]*settings\.autoOrderChannels === true/);
  assert.match(channelsSource, /setAutoOrder[\s\S]*updateWidget\('channel-order-setting'\)/);
});

test('native collection service declaration remains untouched by the fallback', () => {
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(manifest, /RNWidgetCollectionService/);
  assert.match(manifest, /android\.permission\.BIND_REMOTEVIEWS/);
});
