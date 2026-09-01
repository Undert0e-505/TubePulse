// Local simulation for RSS known-video watermark logic.
// Exercises the pure helpers from shared.mjs against the six required scenarios.
// Run with: node worker/tubepulse-rss-0/test-rss-watermark.mjs

import {
  seedKnownVideosFromRss,
  classifyRssVideosForNotification,
  updateKnownVideosAfterPoll,
  boundKnownVideoIds,
} from '../tubepulse-cron/shared.mjs';

function iso(ts) {
  return new Date(ts).toISOString();
}

const t0 = Date.now();
const T = {
  T7: iso(t0 - 7 * 3600_000),
  T8: iso(t0 - 6 * 3600_000),
  T9: iso(t0 - 5 * 3600_000),
  T10: iso(t0 - 4 * 3600_000),
  T11: iso(t0 - 3 * 3600_000),
  T12: iso(t0 - 2 * 3600_000),
};

function video(id, published) {
  return {
    videoId: id,
    title: `Video ${id}`,
    published,
    thumbnail: 'http://thumb',
    link: `https://www.youtube.com/watch?v=${id}`,
    channelTitle: 'Test',
    views: '0',
    likes: null,
    dislikes: null,
  };
}

function assertEq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

let passed = 0;

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err.message);
    process.exitCode = 1;
  }
}

// Scenario 1: Normal no-change.
run('Scenario 1: normal no-change', () => {
  const rss = [video('A', T.T10), video('B', T.T9), video('C', T.T8)];
  let known = seedKnownVideosFromRss(null, rss, T.T10).nextKnown;
  const classified = classifyRssVideosForNotification(known, rss);
  const newVideos = classified.filter((v) => v.isNew);
  assertEq(newVideos.length, 0, 'no new videos on unchanged feed');
  const nextKnown = updateKnownVideosAfterPoll(known, rss, newVideos, T.T10).nextKnown;
  assertEq(nextKnown.highWatermarkAt, T.T10, 'watermark stays at T10');
  assertEq(nextKnown.ids.includes('A'), true, 'A remains known');
});

// Scenario 2: Deletion exposes older video.
run('Scenario 2: deletion exposes older video', () => {
  const rssBefore = [video('A', T.T10), video('B', T.T9), video('C', T.T8)];
  let known = seedKnownVideosFromRss(null, rssBefore, T.T10).nextKnown;

  // A deleted; B/C/D now visible (D was older than the 15-entry window before).
  const rssAfter = [video('B', T.T9), video('C', T.T8), video('D', T.T7)];
  const classified = classifyRssVideosForNotification(known, rssAfter);
  const newVideos = classified.filter((v) => v.isNew);
  assertEq(newVideos.length, 0, 'zero notifications when old videos move up');
  assertEq(classified.find((v) => v.videoId === 'B').reason, 'known-id', 'B is known');
  assertEq(classified.find((v) => v.videoId === 'D').reason, 'at-or-below-watermark', 'D suppressed by watermark');

  const nextKnown = updateKnownVideosAfterPoll(known, rssAfter, newVideos, T.T9).nextKnown;
  assertEq(nextKnown.highWatermarkAt, T.T10, 'watermark must not move backwards');
  assertEq(nextKnown.ids.includes('D'), true, 'D added to known');
});

// Scenario 3: New upload after deletion.
run('Scenario 3: new upload after deletion', () => {
  const rssBefore = [video('A', T.T10), video('B', T.T9)];
  let known = seedKnownVideosFromRss(null, rssBefore, T.T10).nextKnown;

  // A deleted, new X at T11 appears, plus older B/C/D.
  const rssAfter = [video('X', T.T11), video('B', T.T9), video('C', T.T8), video('D', T.T7)];
  const classified = classifyRssVideosForNotification(known, rssAfter);
  const newVideos = classified.filter((v) => v.isNew);
  assertEq(newVideos.map((v) => v.videoId), ['X'], 'only X is genuinely new');

  const nextKnown = updateKnownVideosAfterPoll(known, rssAfter, newVideos, T.T11).nextKnown;
  assertEq(nextKnown.highWatermarkAt, T.T11, 'watermark advances to T11');
  assertEq(nextKnown.ids.includes('X'), true, 'X added to known');
});

// Scenario 4: First-run missing known state.
run('Scenario 4: first-run missing known state', () => {
  const rss = [video('A', T.T10), video('B', T.T9), video('C', T.T8)];
  const known = seedKnownVideosFromRss(null, rss, T.T10).nextKnown;
  assertEq(known.highWatermarkAt, T.T10, 'watermark seeded at max RSS timestamp');
  assertEq(known.ids, ['A', 'B', 'C'], 'all RSS IDs known after seed');

  const classified = classifyRssVideosForNotification(known, rss);
  const newVideos = classified.filter((v) => v.isNew);
  assertEq(newVideos.length, 0, 'seeded state produces zero notifications');
});

// Scenario 5: Older unseen video below watermark enters feed.
run('Scenario 5: older not-known video below watermark', () => {
  const rssBefore = [video('A', T.T10)];
  let known = seedKnownVideosFromRss(null, rssBefore, T.T10).nextKnown;

  // Old Z at T5 appears in feed (was beyond the 15-entry window before).
  const rssAfter = [video('A', T.T10), video('Z', T.T7)];
  const classified = classifyRssVideosForNotification(known, rssAfter);
  const newVideos = classified.filter((v) => v.isNew);
  assertEq(newVideos.length, 0, 'old Z suppressed');
  assertEq(classified.find((v) => v.videoId === 'Z').reason, 'at-or-below-watermark', 'Z reason');

  const nextKnown = updateKnownVideosAfterPoll(known, rssAfter, newVideos, T.T10).nextKnown;
  assertEq(nextKnown.highWatermarkAt, T.T10, 'watermark unchanged');
  assertEq(nextKnown.ids.includes('Z'), true, 'Z added to known');
});

// Scenario 6: Multiple genuinely new videos.
run('Scenario 6: multiple genuinely new videos', () => {
  const rssBefore = [video('A', T.T10)];
  let known = seedKnownVideosFromRss(null, rssBefore, T.T10).nextKnown;

  const rssAfter = [video('X', T.T12), video('Y', T.T11), video('A', T.T10)];
  const classified = classifyRssVideosForNotification(known, rssAfter);
  const newVideos = classified.filter((v) => v.isNew);
  assertEq(newVideos.map((v) => v.videoId), ['X', 'Y'], 'X and Y are new, A is not');

  const nextKnown = updateKnownVideosAfterPoll(known, rssAfter, newVideos, T.T12).nextKnown;
  assertEq(nextKnown.highWatermarkAt, T.T12, 'watermark advances to T12');
});

// Scenario 7: Equal timestamps conservative.
run('Scenario 7: equal timestamps conservative', () => {
  const rss = [video('A', T.T10), video('B', T.T10)];
  let known = seedKnownVideosFromRss(null, rss, T.T10).nextKnown;
  // B was at the watermark on seed. Re-appearing at same timestamp must not notify.
  const classified = classifyRssVideosForNotification(known, [video('B', T.T10)]);
  assertEq(classified.every((v) => !v.isNew), true, 'same-timestamp reappearance suppressed');
});

// Scenario 8: Known ID cap at 500.
run('Scenario 8: 500-ID cap', () => {
  const many = Array.from({ length: 600 }, (_, i) => video(`V${i}`, iso(t0 - i * 60_000)));
  const known = seedKnownVideosFromRss(null, many, iso(t0)).nextKnown;
  assertEq(known.ids.length, 500, 'seed caps at 500 IDs');
  assertEq(boundKnownVideoIds(known.ids).length, 500, 'bound helper also caps at 500');
});

console.log(`\n${passed} scenarios passed.`);
if (process.exitCode) {
  console.error('One or more scenarios failed.');
}
