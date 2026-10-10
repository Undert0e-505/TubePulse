import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  formatCompactCount,
  hasKnownMetric,
  resolveOptionalMetric,
} from '../src/utils/feedPresentation.js';

test('a real zero count remains known and displayable', () => {
  assert.equal(hasKnownMetric(0), true);
  assert.equal(hasKnownMetric('0'), true);
  assert.equal(resolveOptionalMetric({ likes: '0' }, 'likes'), '0');
  assert.equal(resolveOptionalMetric({ comments: '0' }, 'comments'), '0');
  assert.equal(formatCompactCount('0'), '0');
});

test('explicit unknown from the server clears a stale cached zero', () => {
  assert.equal(resolveOptionalMetric({ likes: null }, 'likes', '0'), null);
  assert.equal(resolveOptionalMetric({ likes: '' }, 'likes', '0'), null);
  assert.equal(resolveOptionalMetric({ comments: null }, 'comments', '8'), null);
  assert.equal(hasKnownMetric(null), false);
});

test('an omitted field from an older server may use last-known cache', () => {
  assert.equal(resolveOptionalMetric({}, 'likes', '17'), '17');
  assert.equal(resolveOptionalMetric({}, 'likes', null), null);
  assert.equal(resolveOptionalMetric({}, 'comments', '1200'), '1200');
  assert.equal(formatCompactCount('1200'), '1.2K');
});

test('Home cache normalization and metadata row wire nullable comments after likes', () => {
  const source = readFileSync(new URL('../src/screens/HomeScreen.js', import.meta.url), 'utf8');
  assert.match(source, /comments: resolveOptionalMetric\(v, 'comments', existingByVideoId\.get\(v\.videoId\)\?\.comments\)/);
  assert.match(source, /const hasLikeCount = hasKnownMetric\(video\.likes\);[\s\S]*const hasCommentCount = hasKnownMetric\(video\.comments\);/);
  assert.match(source, /hasLikeCount[\s\S]*THUMB_UP_SVG[\s\S]*hasCommentCount[\s\S]*COMMENT_SVG[\s\S]*video\.views/);
  assert.match(source, /video\.published \|\| video\.views \|\| hasLikeCount \|\| hasCommentCount/);
});
