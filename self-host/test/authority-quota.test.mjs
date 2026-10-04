import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOUDFLARE_FREE_LIMITS, projectAuthorityDailyUsage } from '../src/authority-quota.mjs';

test('current six-user/85-channel unified-authority projection stays below every Free ceiling', () => {
  const result = projectAuthorityDailyUsage();
  assert.equal(result.withinFreeTier, true);
  assert.equal(result.totals.kvReads, 2628);
  assert.equal(result.totals.kvWrites, 950);
  assert.equal(result.totals.kvLists, 145);
  assert.equal(result.totals.durableObjectRequests, 5184);
  assert.equal(result.publicationReserve, 300);
  assert.equal(result.youtubePostUnits, 2040);
  for (const [key, limit] of Object.entries(CLOUDFLARE_FREE_LIMITS)) {
    assert.ok(result.totals[key] < limit, `${key} must retain headroom`);
  }
});

test('projection counts fallback feeds and one exact Worker-binding seed read per key', () => {
  const result = projectAuthorityDailyUsage({
    canonicalKeyCount: 1200,
    fallbackFeedFraction: 1,
    feedRequestsPerUser: 10,
    averageFallbackFeedReads: 8,
  });
  assert.equal(result.initialSeed.kvReads, 1200);
  assert.equal(result.initialSeed.kvLists, 2);
  assert.equal(result.steady.kvReads, 6 * 24 * 12 + 6 * 10 * 8);
});
