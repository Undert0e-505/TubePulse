import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOUDFLARE_FREE_LIMITS, projectAuthorityDailyUsage } from '../src/authority-quota.mjs';

test('representative unified-authority projection stays below every Free ceiling', () => {
  const result = projectAuthorityDailyUsage();
  assert.equal(result.withinFreeTier, true);
  assert.equal(result.totals.kvReads, 2628);
  assert.equal(result.totals.kvWrites, 950);
  assert.equal(result.totals.kvLists, 145);
  assert.equal(result.totals.durableObjectRequests, 5184);
  assert.equal(result.publicationReserve, 50);
  assert.equal(result.youtubePostUnits, 2400);
  for (const [key, limit] of Object.entries(CLOUDFLARE_FREE_LIMITS)) {
    assert.ok(result.totals[key] < limit, `${key} must retain headroom`);
  }
});

test('scheduler publication projection is bounded by the total write cap', () => {
  const result = projectAuthorityDailyUsage({
    schedulerPublicationCap: 1_200,
    totalWriteCap: 950,
  });
  assert.equal(result.assumptions.schedulerPublicationCap, 950);
  assert.equal(result.assumptions.totalWriteCap, 950);
  assert.equal(result.publicationReserve, 0);
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
