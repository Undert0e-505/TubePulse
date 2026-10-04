import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasKnownMetric,
  resolveOptionalMetric,
} from '../src/utils/feedPresentation.js';

test('a real zero count remains known and displayable', () => {
  assert.equal(hasKnownMetric(0), true);
  assert.equal(hasKnownMetric('0'), true);
  assert.equal(resolveOptionalMetric({ likes: '0' }, 'likes'), '0');
});

test('explicit unknown from the server clears a stale cached zero', () => {
  assert.equal(resolveOptionalMetric({ likes: null }, 'likes', '0'), null);
  assert.equal(resolveOptionalMetric({ likes: '' }, 'likes', '0'), null);
  assert.equal(hasKnownMetric(null), false);
});

test('an omitted field from an older server may use last-known cache', () => {
  assert.equal(resolveOptionalMetric({}, 'likes', '17'), '17');
  assert.equal(resolveOptionalMetric({}, 'likes', null), null);
});
