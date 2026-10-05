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

// Sub-threshold metric movement must produce exactly the persisted value so KV
// write-on-change remains stable.
{
  const upload = makeUpload('latest', { views: '1240', likes: '124', dislikes: '24' });
  const cached = makeCached(upload, { views: '1000', likes: '100', dislikes: '20' });
  const merged = mergeRssUploadsIntoRecentVideos([cached], [upload], NOW_MS);
  assert.deepEqual(merged, [cached]);
}

// A strict greater-than-25% view change refreshes in a later UTC hour.
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

// The 24-hour refresh persists the current value even below the threshold.
{
  const upload = makeUpload('latest', { views: '1100' });
  const cached = makeCached(upload, {
    views: '1000',
    viewsLastCheckedHour: CURRENT_HOUR - 24,
  });
  const [merged] = mergeRssUploadsIntoRecentVideos([cached], [upload], NOW_MS);
  assert.equal(merged.views, '1100');
  assert.equal(merged.viewsLastCheckedHour, CURRENT_HOUR);
}

// Likes/dislikes have their own clock. A >25% change in either member refreshes
// the group even when views are same-hour blocked.
{
  const upload = makeUpload('latest', { views: '5000', likes: '126', dislikes: '21' });
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
  assert.equal(merged.likes, '126');
  assert.equal(merged.dislikes, '21');
  assert.equal(merged.likesLastCheckedHour, CURRENT_HOUR);
}

// Exactly 25% is not beyond the threshold for either engagement metric.
{
  const upload = makeUpload('latest', { likes: '125', dislikes: '25' });
  const cached = makeCached(upload, { likes: '100', dislikes: '20' });
  const merged = mergeRssUploadsIntoRecentVideos([cached], [upload], NOW_MS);
  assert.deepEqual(merged, [cached]);
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
