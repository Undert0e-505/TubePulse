import assert from 'node:assert/strict';
import { mergeRssUploadsIntoRecentVideos } from './tubepulse-cron/shared.mjs';

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.parse('2026-09-20T12:30:00.000Z');
const CURRENT_HOUR = Math.floor(NOW_MS / HOUR_MS);

function makeUpload(videoId, overrides = {}) {
  return {
    videoId,
    title: `title-${videoId}`,
    published: '2026-09-20T10:00:00.000Z',
    thumbnail: `thumb-${videoId}`,
    link: `https://youtube.com/watch?v=${videoId}`,
    views: '1000',
    likes: '100',
    dislikes: '20',
    ...overrides,
  };
}

function makeCached(upload, overrides = {}) {
  return {
    videoId: upload.videoId,
    title: upload.title,
    publishedAt: upload.published,
    thumbnail: upload.thumbnail,
    type: 'video',
    link: upload.link,
    views: upload.views,
    likes: upload.likes,
    dislikes: upload.dislikes,
    viewsLastCheckedHour: CURRENT_HOUR - 1,
    likesLastCheckedHour: CURRENT_HOUR - 1,
    ...overrides,
  };
}

// Any known metric movement may persist in a later UTC hour, including a
// change that was below the former percentage threshold.
{
  const upload = makeUpload('latest', { views: '1001', likes: '101', dislikes: '20' });
  const cached = makeCached(upload, { views: '1000', likes: '100', dislikes: '20' });
  const [merged] = mergeRssUploadsIntoRecentVideos([cached], [upload], NOW_MS);
  assert.equal(merged.views, '1001');
  assert.equal(merged.likes, '101');
  assert.equal(merged.viewsLastCheckedHour, CURRENT_HOUR);
  assert.equal(merged.likesLastCheckedHour, CURRENT_HOUR);
}

// A large view change also refreshes in a later UTC hour.
{
  const upload = makeUpload('latest', { views: '1251' });
  const cached = makeCached(upload, { views: '1000' });
  const [merged] = mergeRssUploadsIntoRecentVideos([cached], [upload], NOW_MS);
  assert.equal(merged.views, '1251');
  assert.equal(merged.viewsLastCheckedHour, CURRENT_HOUR);
}

// Even a large change cannot refresh twice in the same UTC hour.
{
  const upload = makeUpload('latest', { views: '5000' });
  const cached = makeCached(upload, {
    views: '1000',
    viewsLastCheckedHour: CURRENT_HOUR,
  });
  const merged = mergeRssUploadsIntoRecentVideos([cached], [upload], NOW_MS);
  assert.deepEqual(merged, [cached]);
}

// The 24-hour refresh advances the clock even when the known value is unchanged.
{
  const upload = makeUpload('latest', { views: '1000' });
  const cached = makeCached(upload, {
    views: '1000',
    viewsLastCheckedHour: CURRENT_HOUR - 24,
  });
  const [merged] = mergeRssUploadsIntoRecentVideos([cached], [upload], NOW_MS);
  assert.equal(merged.views, '1000');
  assert.equal(merged.viewsLastCheckedHour, CURRENT_HOUR);
}

// Likes/dislikes have their own clock. A change in either member refreshes
// the group even when views are same-hour blocked.
{
  const upload = makeUpload('latest', { views: '5000', likes: '101', dislikes: '20' });
  const cached = makeCached(upload, {
    views: '1000',
    likes: '100',
    dislikes: '20',
    viewsLastCheckedHour: CURRENT_HOUR,
    likesLastCheckedHour: CURRENT_HOUR - 1,
  });
  const [merged] = mergeRssUploadsIntoRecentVideos([cached], [upload], NOW_MS);
  assert.equal(merged.views, '1000');
  assert.equal(merged.viewsLastCheckedHour, CURRENT_HOUR);
  assert.equal(merged.likes, '101');
  assert.equal(merged.dislikes, '20');
  assert.equal(merged.likesLastCheckedHour, CURRENT_HOUR);
}

// Numerically equivalent decimal strings do not cause a write.
{
  const upload = makeUpload('latest', { views: '01000', likes: '0100', dislikes: '020' });
  const cached = makeCached(upload, { views: '1000', likes: '100', dislikes: '20' });
  const merged = mergeRssUploadsIntoRecentVideos([cached], [upload], NOW_MS);
  assert.deepEqual(merged, [cached]);
}

// A known nonzero value may transition to an explicit public zero in a later
// UTC hour, while an unavailable incoming value preserves the known count.
{
  const zeroUpload = makeUpload('zero-transition', { views: '0', likes: '0', dislikes: null });
  const cached = makeCached(zeroUpload, { views: '1', likes: '1', dislikes: null });
  const [zeroed] = mergeRssUploadsIntoRecentVideos([cached], [zeroUpload], NOW_MS);
  assert.equal(zeroed.views, '0');
  assert.equal(zeroed.likes, '0');
  const repeatedZero = makeUpload('zero-transition', { views: '0', likes: '0', dislikes: null });
  assert.deepEqual(
    mergeRssUploadsIntoRecentVideos([zeroed], [repeatedZero], NOW_MS + HOUR_MS),
    [zeroed],
  );
  const hiddenUpload = makeUpload('hidden-known', { views: null, likes: null, dislikes: null });
  const known = makeCached(hiddenUpload, { views: '7', likes: '3', dislikes: null });
  assert.deepEqual(
    mergeRssUploadsIntoRecentVideos([known], [hiddenUpload], NOW_MS),
    [known],
  );
}

// The app-visible top three may refresh metrics; entries outside the visible
// set retain their persisted metrics even when an upstream count changes.
{
  const latestUpload = makeUpload('latest');
  const olderUpload = makeUpload('older', { views: '9000', likes: '900', dislikes: '90' });
  const thirdUpload = makeUpload('third', { views: '8000', likes: '800', dislikes: '80' });
  const hiddenUpload = makeUpload('hidden', { views: '7000', likes: '700', dislikes: '70' });
  const latestCached = makeCached(latestUpload);
  const olderCached = makeCached(olderUpload, {
    views: '50',
    likes: '5',
    dislikes: '1',
    viewsLastCheckedHour: CURRENT_HOUR - 48,
    likesLastCheckedHour: CURRENT_HOUR - 48,
  });
  const thirdCached = makeCached(thirdUpload, {
    views: '40', likes: '4', dislikes: '1',
    viewsLastCheckedHour: CURRENT_HOUR - 48, likesLastCheckedHour: CURRENT_HOUR - 48,
  });
  const hiddenCached = makeCached(hiddenUpload, {
    views: '30', likes: '3', dislikes: '1',
    viewsLastCheckedHour: CURRENT_HOUR - 48, likesLastCheckedHour: CURRENT_HOUR - 48,
  });
  const merged = mergeRssUploadsIntoRecentVideos(
    [latestCached, olderCached, thirdCached, hiddenCached],
    [latestUpload, olderUpload, thirdUpload, hiddenUpload],
    NOW_MS,
  );
  assert.equal(merged[1].views, '9000');
  assert.equal(merged[2].views, '8000');
  assert.deepEqual(merged[3], hiddenCached);
}

// A newly observed entry seeds every RSS metric and both persistence clocks.
{
  const oldUpload = makeUpload('old');
  const oldCached = makeCached(oldUpload);
  const newUpload = makeUpload('new', { views: '42', likes: '7', dislikes: '2' });
  const [seeded] = mergeRssUploadsIntoRecentVideos(
    [oldCached],
    [newUpload, oldUpload],
    NOW_MS,
  );
  assert.equal(seeded.views, '42');
  assert.equal(seeded.likes, '7');
  assert.equal(seeded.dislikes, '2');
  assert.equal(seeded.viewsLastCheckedHour, CURRENT_HOUR);
  assert.equal(seeded.likesLastCheckedHour, CURRENT_HOUR);
}

// An unavailable/hidden metric is unknown, not a synthetic zero.
{
  const upload = makeUpload('hidden-likes', { likes: null, dislikes: null });
  const [seeded] = mergeRssUploadsIntoRecentVideos([], [upload], NOW_MS);
  assert.equal(seeded.likes, null);
  assert.equal(seeded.dislikes, null);
  assert.equal(seeded.likesLastCheckedHour, CURRENT_HOUR);
}

// Data API discovery writes structure first and enriches statistics in the
// same cycle. A known value must hydrate a cached null once without waiting
// until the next UTC hour.
{
  const discovered = makeUpload('same-hour-hydration', {
    views: null,
    likes: null,
    dislikes: null,
    comments: null,
  });
  const [cached] = mergeRssUploadsIntoRecentVideos([], [discovered], NOW_MS);
  const enriched = makeUpload('same-hour-hydration', {
    views: '42',
    likes: '7',
    dislikes: null,
    comments: '3',
  });
  const [hydrated] = mergeRssUploadsIntoRecentVideos([cached], [enriched], NOW_MS);
  assert.equal(hydrated.views, '42');
  assert.equal(hydrated.likes, '7');
  assert.equal(hydrated.dislikes, null);
  assert.equal(hydrated.comments, '3');
  assert.equal(hydrated.viewsLastCheckedHour, CURRENT_HOUR);
  assert.equal(hydrated.likesLastCheckedHour, CURRENT_HOUR);
  assert.equal(hydrated.commentsLastCheckedHour, CURRENT_HOUR);
  assert.deepEqual(
    mergeRssUploadsIntoRecentVideos([hydrated], [enriched], NOW_MS),
    [hydrated],
  );
}

// A legacy API bootstrap zero without a metric clock is ambiguous. Its first
// scheduled RSS enrichment self-heals to the authoritative unknown value.
{
  const upload = makeUpload('legacy-hidden', { likes: null, dislikes: null });
  const cached = makeCached(upload, { likes: '0', dislikes: '0' });
  delete cached.likesLastCheckedHour;
  const [healed] = mergeRssUploadsIntoRecentVideos([cached], [upload], NOW_MS);
  assert.equal(healed.likes, null);
  assert.equal(healed.dislikes, null);
  assert.equal(healed.likesLastCheckedHour, CURRENT_HOUR);
}

// Comment observations are local-only unless another canonical mutation is
// already due. Even a large comment movement and stale comment clock alone
// must leave the recent-video value byte-for-byte stable.
{
  const upload = makeUpload('comment-only', {
    views: '100', likes: '10', dislikes: null, comments: '99',
  });
  const cached = makeCached(upload, {
    comments: '3',
    viewsLastCheckedHour: CURRENT_HOUR,
    likesLastCheckedHour: CURRENT_HOUR,
    commentsLastCheckedHour: CURRENT_HOUR - 48,
  });
  const merged = mergeRssUploadsIntoRecentVideos([cached], [upload], NOW_MS);
  assert.deepEqual(merged, [cached]);
}

// When views already justify the canonical write, the latest comment count
// and clock piggyback on the same record without adding another KV mutation.
{
  const upload = makeUpload('comment-piggyback', {
    views: '200', likes: '10', dislikes: null, comments: '0',
  });
  const cached = makeCached(upload, {
    views: '100', comments: '9',
    viewsLastCheckedHour: CURRENT_HOUR - 1,
    likesLastCheckedHour: CURRENT_HOUR,
    commentsLastCheckedHour: CURRENT_HOUR - 1,
  });
  const [merged] = mergeRssUploadsIntoRecentVideos([cached], [upload], NOW_MS);
  assert.equal(merged.views, '200');
  assert.equal(merged.comments, '0');
  assert.equal(merged.commentsLastCheckedHour, CURRENT_HOUR);
}

// Some legacy zeros may already have acquired a clock from an older cron
// version. Missing RSS metrics still repair those zeros once, without waiting
// for the 24-hour refresh, and the repaired record is stable thereafter.
{
  const upload = makeUpload('clocked-legacy-hidden', { likes: null, dislikes: null });
  const cached = makeCached(upload, {
    likes: '0',
    dislikes: '0',
    likesLastCheckedHour: CURRENT_HOUR,
  });
  const healed = mergeRssUploadsIntoRecentVideos([cached], [upload], NOW_MS);
  assert.equal(healed[0].likes, null);
  assert.equal(healed[0].dislikes, null);
  assert.equal(healed[0].likesLastCheckedHour, CURRENT_HOUR);
  assert.deepEqual(
    mergeRssUploadsIntoRecentVideos(healed, [upload], NOW_MS),
    healed,
  );
}

// An explicit public zero is still a real count.
{
  const upload = makeUpload('real-zero', { likes: '0', dislikes: null });
  const [seeded] = mergeRssUploadsIntoRecentVideos([], [upload], NOW_MS);
  assert.equal(seeded.likes, '0');
  assert.equal(seeded.dislikes, null);
}

// Feed order, structural edits, and removals remain visible independently of
// metric persistence.
{
  const uploadA = makeUpload('a');
  const uploadB = makeUpload('b');
  const uploadC = makeUpload('c');
  const cached = [uploadA, uploadB, uploadC].map((upload) => makeCached(upload, {
    viewsLastCheckedHour: CURRENT_HOUR,
    likesLastCheckedHour: CURRENT_HOUR,
  }));
  const changedC = {
    ...uploadC,
    title: 'renamed-c',
    thumbnail: 'new-thumb-c',
    link: 'https://youtube.com/watch?v=c&updated=1',
  };
  const merged = mergeRssUploadsIntoRecentVideos(cached, [changedC, uploadA], NOW_MS);
  assert.deepEqual(merged.map((video) => video.videoId), ['c', 'a']);
  assert.equal(merged[0].title, 'renamed-c');
  assert.equal(merged[0].thumbnail, 'new-thumb-c');
  assert.equal(merged[0].link, 'https://youtube.com/watch?v=c&updated=1');
  assert.ok(!merged.some((video) => video.videoId === 'b'));
}

// Legacy entries without clocks migrate once, then remain stable in that hour.
{
  const upload = makeUpload('legacy', { views: '1050', likes: '105', dislikes: '21' });
  const cached = makeCached(upload, { views: '1000', likes: '100', dislikes: '20' });
  delete cached.viewsLastCheckedHour;
  delete cached.likesLastCheckedHour;
  const migrated = mergeRssUploadsIntoRecentVideos([cached], [upload], NOW_MS);
  assert.equal(migrated[0].viewsLastCheckedHour, CURRENT_HOUR);
  assert.equal(migrated[0].likesLastCheckedHour, CURRENT_HOUR);
  assert.deepEqual(
    mergeRssUploadsIntoRecentVideos(migrated, [upload], NOW_MS),
    migrated,
  );
}

console.log('RSS recent-video merge policy: PASS');
