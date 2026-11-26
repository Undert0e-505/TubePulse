const INNERTUBE_BROWSE_URL = 'https://www.youtube.com/youtubei/v1/browse';
const POSTS_TAB_PARAMS = 'EgVwb3N0c_IGBAoCSgA%3D';
const DEFAULT_CLIENT_NAME = 'WEB';
const DEFAULT_CLIENT_VERSION = '2.20240101';
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_REGION = 'GB';
const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;
const MS_PER_MONTH = 30 * MS_PER_DAY;
const MS_PER_YEAR = 365 * MS_PER_DAY;

export class CommunityPostResponseTooLargeError extends Error {
  constructor({ limitBytes, observedBytes = null, declaredBytes = null } = {}) {
    const measured = Number.isFinite(observedBytes) ? `${observedBytes} bytes`
      : Number.isFinite(declaredBytes) ? `${declaredBytes} declared bytes`
      : 'an oversized body';
    super(`InnerTube response too large: ${measured} exceeds ${limitBytes} bytes`);
    this.name = 'CommunityPostResponseTooLargeError';
    this.code = 'COMMUNITY_POST_RESPONSE_TOO_LARGE';
    this.deterministic = true;
    this.limitBytes = limitBytes;
    this.observedBytes = observedBytes;
    this.declaredBytes = declaredBytes;
  }
}

async function cancelBody(body) {
  try { await body?.cancel?.(); } catch {}
}

export async function readCommunityPostResponseText(response, maxResponseBytes) {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error('maxResponseBytes must be a positive safe integer');
  }
  const declaredBytes = Number(response?.headers?.get?.('Content-Length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
    await cancelBody(response.body);
    throw new CommunityPostResponseTooLargeError({ limitBytes: maxResponseBytes, declaredBytes });
  }

  const reader = response?.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    const observedBytes = new TextEncoder().encode(text).byteLength;
    if (observedBytes > maxResponseBytes) {
      await cancelBody(response.body);
      throw new CommunityPostResponseTooLargeError({ limitBytes: maxResponseBytes, observedBytes });
    }
    return text;
  }

  const chunks = [];
  let observedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      observedBytes += chunk.byteLength;
      if (observedBytes > maxResponseBytes) {
        await reader.cancel('community-post-response-limit');
        throw new CommunityPostResponseTooLargeError({ limitBytes: maxResponseBytes, observedBytes });
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }
  const joined = new Uint8Array(observedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export function isCommunityPostsEnabled(env = {}) {
  const value = String(env.TUBEPULSE_ENABLE_COMMUNITY_POSTS || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function parseCommunityPostChannelAllowlist(env = {}) {
  const raw = env.TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST;
  if (raw == null) return new Set();
  return new Set(
    String(raw)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

export function isCommunityPostChannelAllowed(channelId, env = {}) {
  if (!channelId || typeof channelId !== 'string') return false;
  const allowlist = parseCommunityPostChannelAllowlist(env);
  return allowlist.size === 0 || allowlist.has(channelId);
}

export function isCommunityPostEligible(channelId, env = {}) {
  return isCommunityPostsEnabled(env) && isCommunityPostChannelAllowed(channelId, env);
}

function textFromRuns(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.simpleText === 'string') return value.simpleText;
  if (Array.isArray(value.runs)) {
    return value.runs.map((run) => run?.text || '').join('');
  }
  return '';
}

function accessibilityLabel(value) {
  return value?.accessibility?.accessibilityData?.label
    || value?.accessibilityData?.label
    || '';
}

export function parseCommunityPostCountText(value) {
  if (!value || typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const match = text.match(/(\d{1,3}(?:,\d{3})+|\d+(?:[.,]\d+)?)\s*([kmb])?/i);
  if (!match) return null;

  const rawNumber = match[1];
  const suffix = (match[2] || '').toLowerCase();
  const normalized = rawNumber.includes(',') && !rawNumber.includes('.')
    ? rawNumber.replace(/,/g, '')
    : rawNumber.replace(/,/g, '.');
  const base = Number(normalized);
  if (!Number.isFinite(base)) return null;

  const multiplier = suffix === 'k' ? 1000
    : suffix === 'm' ? 1000000
    : suffix === 'b' ? 1000000000
    : 1;
  return Math.round(base * multiplier);
}

function metricFromTextObject(value) {
  const primaryText = textFromRuns(value) || null;
  const label = accessibilityLabel(value) || null;
  const count = parseCommunityPostCountText(label) ?? parseCommunityPostCountText(primaryText);
  return {
    count,
    text: label || primaryText,
  };
}

function findBackstagePostThreads(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) findBackstagePostThreads(item, out);
    return out;
  }
  if (node.backstagePostThreadRenderer) {
    out.push(node.backstagePostThreadRenderer);
  }
  for (const value of Object.values(node)) {
    findBackstagePostThreads(value, out);
  }
  return out;
}

function collectThumbnailUrls(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectThumbnailUrls(item, out);
    return out;
  }
  if (Array.isArray(node.thumbnails)) {
    for (const thumb of node.thumbnails) {
      if (typeof thumb?.url === 'string' && thumb.url) {
        out.push({
          url: thumb.url,
          width: Number(thumb.width) || 0,
          height: Number(thumb.height) || 0,
        });
      }
    }
  }
  for (const value of Object.values(node)) {
    collectThumbnailUrls(value, out);
  }
  return out;
}

function bestThumbnailUrl(attachment) {
  const thumbnails = collectThumbnailUrls(attachment);
  if (thumbnails.length === 0) return null;
  thumbnails.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  return thumbnails[0].url;
}

export function parseInnerTubeRelativeAgeMs(value) {
  if (!value || typeof value !== 'string') return null;
  const text = value
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .trim();
  if (!text) return null;
  if (text === 'just now' || text === 'now') return 0;

  const match = text.match(/(?:^|\s)(\d+|a|an)\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/);
  if (!match) return null;

  const count = match[1] === 'a' || match[1] === 'an'
    ? 1
    : Number(match[1]);
  if (!Number.isFinite(count) || count < 0) return null;

  const unit = match[2];
  if (unit === 'second') return count * 1000;
  if (unit === 'minute') return count * MS_PER_MINUTE;
  if (unit === 'hour') return count * MS_PER_HOUR;
  if (unit === 'day') return count * MS_PER_DAY;
  if (unit === 'week') return count * MS_PER_WEEK;
  if (unit === 'month') return count * MS_PER_MONTH;
  if (unit === 'year') return count * MS_PER_YEAR;
  return null;
}

export function estimatePublishedAtFromRelativeText(publishedText, now = new Date()) {
  const relativeMs = parseInnerTubeRelativeAgeMs(publishedText);
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (relativeMs == null || !Number.isFinite(nowTime)) return null;
  return new Date(nowTime - relativeMs).toISOString();
}

function normalizeBackstagePostRenderer(post, options = {}) {
  if (!post || typeof post !== 'object') return null;
  const postId = post.postId;
  if (!postId || typeof postId !== 'string') return null;
  const fetchedAt = (options.now instanceof Date ? options.now : new Date(options.now || Date.now())).toISOString();
  const publishedText = textFromRuns(post.publishedTimeText) || null;
  const publishedAt = estimatePublishedAtFromRelativeText(publishedText, fetchedAt);
  const likeMetric = metricFromTextObject(post.voteCount || post.voteCountText || post.likeCount || post.likeCountText);
  const viewMetric = metricFromTextObject(post.viewCount || post.viewCountText);
  const authorName = textFromRuns(post.authorText) || null;

  return {
    id: `post:${postId}`,
    activityId: postId,
    postId,
    publishedAt,
    publishedAtSource: publishedAt ? 'estimated_from_relative' : 'unknown',
    publishedText,
    fetchedAt,
    likeCount: likeMetric.count,
    likeText: likeMetric.text,
    viewCount: viewMetric.count,
    viewText: viewMetric.text,
    authorName,
    text: textFromRuns(post.contentText),
    thumbnail: bestThumbnailUrl(post.backstageAttachment),
    kind: 'community',
    link: `https://www.youtube.com/post/${postId}`,
    source: 'innertube',
  };
}

export function parseLatestCommunityPostFromInnerTubeResponse(data, options = {}) {
  const threads = findBackstagePostThreads(data);
  for (const thread of threads) {
    const normalized = normalizeBackstagePostRenderer(
      thread?.post?.backstagePostRenderer,
      options
    );
    if (normalized) return normalized;
  }
  return null;
}

export async function fetchLatestCommunityPostInnerTube(channelId, options = {}) {
  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required');
  }

  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }

  const logger = options.logger || console;
  const language = options.language || DEFAULT_LANGUAGE;
  const region = options.region || DEFAULT_REGION;
  const clientName = options.clientName || DEFAULT_CLIENT_NAME;
  const clientVersion = options.clientVersion || DEFAULT_CLIENT_VERSION;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(INNERTUBE_BROWSE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName,
            clientVersion,
            hl: language,
            gl: region,
          },
        },
        browseId: channelId,
        params: POSTS_TAB_PARAMS,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`InnerTube browse failed: HTTP ${response.status}`);
    }

    const text = await readCommunityPostResponseText(response, maxResponseBytes);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      logger?.warn?.(`[Posts] InnerTube returned invalid JSON for ${channelId}`);
      return null;
    }

    return parseLatestCommunityPostFromInnerTubeResponse(data, { now: options.now });
  } finally {
    clearTimeout(timer);
  }
}
