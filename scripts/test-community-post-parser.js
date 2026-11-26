const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixtureDir = path.join(
  __dirname,
  '..',
  'worker',
  'tubepulse-cron',
  'fixtures',
  'community-posts'
);

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

(async () => {
  const {
    parseLatestCommunityPostFromInnerTubeResponse,
    fetchLatestCommunityPostInnerTube,
    parseInnerTubeRelativeAgeMs,
    estimatePublishedAtFromRelativeText,
    parseCommunityPostCountText,
    parseCommunityPostChannelAllowlist,
    isCommunityPostChannelAllowed,
    isCommunityPostEligible,
    readCommunityPostResponseText,
    CommunityPostResponseTooLargeError,
  } = await import('../worker/tubepulse-cron/community-posts.mjs');

  assert.deepEqual(
    [...parseCommunityPostChannelAllowlist({})],
    []
  );
  assert.deepEqual(
    [...parseCommunityPostChannelAllowlist({
      TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST: '  ',
    })],
    []
  );
  assert.deepEqual(
    [...parseCommunityPostChannelAllowlist({
      TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST: ' UCone , ,UCtwo, UCthree ',
    })],
    ['UCone', 'UCtwo', 'UCthree']
  );

  const allowlistEnv = {
    TUBEPULSE_ENABLE_COMMUNITY_POSTS: 'yes',
    TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST: 'UCeG5VyNPnGZq-8JzHJbSB6A,UCother',
  };
  assert.equal(
    isCommunityPostChannelAllowed('UCeG5VyNPnGZq-8JzHJbSB6A', allowlistEnv),
    true
  );
  assert.equal(isCommunityPostChannelAllowed('UCmissing', allowlistEnv), false);
  assert.equal(
    isCommunityPostEligible('UCeG5VyNPnGZq-8JzHJbSB6A', allowlistEnv),
    true
  );
  assert.equal(
    isCommunityPostEligible('UCeG5VyNPnGZq-8JzHJbSB6A', {
      TUBEPULSE_ENABLE_COMMUNITY_POSTS: '0',
      TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST: 'UCeG5VyNPnGZq-8JzHJbSB6A',
    }),
    false
  );
  assert.equal(
    isCommunityPostEligible('UCeG5VyNPnGZq-8JzHJbSB6A', {
      TUBEPULSE_ENABLE_COMMUNITY_POSTS: 'true',
    }),
    true
  );
  assert.equal(
    isCommunityPostEligible('UCeG5VyNPnGZq-8JzHJbSB6A', {
      TUBEPULSE_ENABLE_COMMUNITY_POSTS: 'true',
      TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST: ' ',
    }),
    true
  );
  assert.equal(isCommunityPostEligible('UCmissing', allowlistEnv), false);

  const parserNow = new Date('2026-06-26T12:00:00.000Z');
  assert.equal(parseInnerTubeRelativeAgeMs('just now'), 0);
  assert.equal(parseInnerTubeRelativeAgeMs('1 minute ago'), 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('42 minutes ago'), 42 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('1 hour ago'), 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('4 hours ago'), 4 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('1 day ago'), 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('4 days ago (edited)'), 4 * 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('1 week ago'), 7 * 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('4 weeks ago'), 4 * 7 * 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('1 month ago'), 30 * 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('6 months ago'), 6 * 30 * 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('1 year ago'), 365 * 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('2 years ago'), 2 * 365 * 24 * 60 * 60 * 1000);
  assert.equal(parseInnerTubeRelativeAgeMs('not a relative time'), null);
  assert.equal(
    estimatePublishedAtFromRelativeText('42 minutes ago', parserNow),
    '2026-06-26T11:18:00.000Z'
  );
  assert.equal(parseCommunityPostCountText('1 like'), 1);
  assert.equal(parseCommunityPostCountText('0 likes'), 0);
  assert.equal(parseCommunityPostCountText('0'), 0);
  assert.equal(parseCommunityPostCountText('42 likes'), 42);
  assert.equal(parseCommunityPostCountText('1.2K likes'), 1200);
  assert.equal(parseCommunityPostCountText('4,321 likes'), 4321);
  assert.equal(parseCommunityPostCountText('No likes'), null);

  const undertoe = parseLatestCommunityPostFromInnerTubeResponse(
    loadFixture('undert0e505-latest.json'),
    { now: parserNow }
  );
  assert.equal(undertoe.id, 'post:UgkxPUnenuIZrE8GB5qHdNDyHWMWFZ56PJ0v');
  assert.equal(undertoe.activityId, 'UgkxPUnenuIZrE8GB5qHdNDyHWMWFZ56PJ0v');
  assert.equal(undertoe.postId, 'UgkxPUnenuIZrE8GB5qHdNDyHWMWFZ56PJ0v');
  assert.equal(
    undertoe.link,
    'https://www.youtube.com/post/UgkxPUnenuIZrE8GB5qHdNDyHWMWFZ56PJ0v'
  );
  assert.equal(undertoe.kind, 'community');
  assert.equal(undertoe.source, 'innertube');
  assert.equal(undertoe.publishedAt, '2026-06-23T12:00:00.000Z');
  assert.equal(undertoe.publishedAtSource, 'estimated_from_relative');
  assert.equal(undertoe.publishedText, '3 days ago (edited)');
  assert.equal(undertoe.fetchedAt, '2026-06-26T12:00:00.000Z');
  assert.equal(undertoe.likeCount, 1);
  assert.equal(undertoe.likeText, '1 like');
  assert.equal(undertoe.viewCount, null);
  assert.equal(undertoe.viewText, null);
  assert.equal(undertoe.authorName, 'Undert0e');
  assert.match(undertoe.text, /ZeroVPN v0\.1 is ready/);
  assert.equal(undertoe.thumbnail, 'https://yt3.ggpht.com/example=s800');

  const textOnly = parseLatestCommunityPostFromInnerTubeResponse(
    loadFixture('youtube-text-only.json'),
    { now: parserNow }
  );
  assert.equal(textOnly.id, 'post:UgkxKC5OZpD2HEJCY6PzDBxuoYNnwXdUQRJ9');
  assert.equal(textOnly.thumbnail, null);
  assert.equal(textOnly.text, "let's run it back, beliebers.");
  assert.equal(textOnly.publishedAt, '2026-06-26T11:00:00.000Z');
  assert.equal(textOnly.publishedAtSource, 'estimated_from_relative');
  assert.equal(textOnly.publishedText, '1 hour ago');
  assert.equal(textOnly.likeCount, null);
  assert.equal(textOnly.likeText, null);
  assert.equal(textOnly.viewCount, null);
  assert.equal(textOnly.viewText, null);

  const missingOptional = parseLatestCommunityPostFromInnerTubeResponse(
    loadFixture('missing-optional-fields.json'),
    { now: parserNow }
  );
  assert.equal(missingOptional.id, 'post:UgkxMissingOptionalFields');
  assert.equal(missingOptional.text, '');
  assert.equal(missingOptional.thumbnail, null);
  assert.equal(missingOptional.publishedAt, null);
  assert.equal(missingOptional.publishedAtSource, 'unknown');
  assert.equal(missingOptional.publishedText, null);
  assert.equal(missingOptional.likeCount, null);
  assert.equal(missingOptional.likeText, null);
  assert.equal(missingOptional.viewCount, null);
  assert.equal(missingOptional.viewText, null);

  const noPosts = parseLatestCommunityPostFromInnerTubeResponse(
    loadFixture('no-posts.json')
  );
  assert.equal(noPosts, null);

  const fetched = await fetchLatestCommunityPostInnerTube('UCtestChannel', {
    fetch: async (url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(url, 'https://www.youtube.com/youtubei/v1/browse');
      assert.equal(request.method, 'POST');
      assert.equal(body.browseId, 'UCtestChannel');
      assert.equal(body.params, 'EgVwb3N0c_IGBAoCSgA%3D');
      assert.equal(body.context.client.clientName, 'WEB');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(loadFixture('youtube-text-only.json')),
      };
    },
    logger: { warn() {} },
    now: parserNow,
  });
  assert.equal(fetched.id, 'post:UgkxKC5OZpD2HEJCY6PzDBxuoYNnwXdUQRJ9');

  const bytes = (size, value = 120) => new Uint8Array(size).fill(value);
  const streamResponse = (chunks, headers = {}) => new Response(new ReadableStream({
    pull(controller) {
      if (chunks.length === 0) return controller.close();
      controller.enqueue(chunks.shift());
    },
  }), { headers });
  assert.equal((await readCommunityPostResponseText(
    streamResponse([bytes(1024 * 1024), bytes(1024 * 1024)]),
    2 * 1024 * 1024,
  )).length, 2 * 1024 * 1024, 'the former 2 MiB boundary remains readable');
  assert.equal((await readCommunityPostResponseText(
    streamResponse([bytes(7_900_000)]),
    10 * 1024 * 1024,
  )).length, 7_900_000, 'the largest observed production response fits');
  assert.equal((await readCommunityPostResponseText(
    streamResponse([bytes((10 * 1024 * 1024) - 1)]),
    10 * 1024 * 1024,
  )).length, (10 * 1024 * 1024) - 1, 'the configured hard boundary is byte accurate');

  let cancelled = false;
  const overLimitBody = new ReadableStream({
    start(controller) { controller.enqueue(bytes(6)); controller.enqueue(bytes(6)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(
    () => readCommunityPostResponseText(new Response(overLimitBody), 10),
    (error) => error instanceof CommunityPostResponseTooLargeError
      && error.code === 'COMMUNITY_POST_RESPONSE_TOO_LARGE',
  );
  assert.equal(cancelled, true, 'chunked over-limit bodies are cancelled immediately');

  let declaredCancelled = false;
  await assert.rejects(
    () => readCommunityPostResponseText({
      headers: { get: () => '10485761' },
      body: { cancel: async () => { declaredCancelled = true; } },
    }, 10 * 1024 * 1024),
    CommunityPostResponseTooLargeError,
  );
  assert.equal(declaredCancelled, true, 'declared oversized bodies are rejected before reading');

  await assert.rejects(
    () => readCommunityPostResponseText({
      headers: { get: () => '1' },
      body: streamResponse([bytes(11)]).body,
    }, 10),
    CommunityPostResponseTooLargeError,
    'a lying Content-Length cannot bypass the streamed byte limit',
  );

  const malformed = await fetchLatestCommunityPostInnerTube('UCtestChannel', {
    fetch: async () => new Response('{not-json'),
    logger: { warn() {} },
  });
  assert.equal(malformed, null, 'malformed JSON remains a non-content result');

  await assert.rejects(() => fetchLatestCommunityPostInnerTube('UCtestChannel', {
    timeoutMs: 5,
    fetch: async (_url, request) => await new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason));
    }),
  }), /abort|timeout/i, 'the request timeout still aborts a stalled response');

  console.log('community post parser checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
