const CHANNEL_BATCH_SIZE = 50;
const VIDEO_BATCH_SIZE = 50;

export class YouTubeDataApiError extends Error {
  constructor(message, { category = 'youtube-api-failed', status = null, retryable = false } = {}) {
    super(message);
    this.name = 'YouTubeDataApiError';
    this.category = category;
    this.status = status;
    this.retryable = retryable;
  }
}

export function chunked(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

export function pacificQuotaWindow(nowMs = Date.now()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const day = formatter.format(new Date(nowMs));
  let probe = nowMs + 20 * 60 * 60 * 1000;
  while (formatter.format(new Date(probe)) === day) probe += 60 * 60 * 1000;
  let low = probe - 26 * 60 * 60 * 1000;
  let high = probe;
  while (high - low > 1000) {
    const middle = Math.floor((low + high) / 2);
    if (formatter.format(new Date(middle)) === day) low = middle;
    else high = middle;
  }
  return { day, resetsAt: new Date(high).toISOString() };
}

export function normalizeYoutubeDataApiState(value, nowMs = Date.now()) {
  const window = pacificQuotaWindow(nowMs);
  const state = value && typeof value === 'object' ? structuredClone(value) : {};
  state.sourceMode = 'youtube-data-api';
  state.channels = state.channels && typeof state.channels === 'object' ? state.channels : {};
  state.metricPoll = state.metricPoll && typeof state.metricPoll === 'object' ? state.metricPoll : {};
  for (const [videoId, poll] of Object.entries(state.metricPoll)) {
    if (!poll || typeof poll !== 'object' || Array.isArray(poll)) {
      delete state.metricPoll[videoId];
      continue;
    }
    if (poll.commentObservation && typeof poll.commentObservation === 'object') {
      const observedAt = Date.parse(poll.commentObservation.observedAt || '');
      poll.commentObservation = {
        count: poll.commentObservation.count == null ? null : String(poll.commentObservation.count),
        observedAt: Number.isFinite(observedAt)
          ? new Date(observedAt).toISOString()
          : null,
      };
    }
  }
  if (state.quota?.day !== window.day) {
    state.quota = {
      day: window.day,
      resetsAt: window.resetsAt,
      general: { requests: 0, units: 0, failures: 0 },
      statistics: { requests: 0, units: 0, failures: 0 },
    };
  } else {
    state.quota.resetsAt = window.resetsAt;
    for (const bucket of ['general', 'statistics']) {
      state.quota[bucket] ||= {};
      for (const field of ['requests', 'units', 'failures']) {
        state.quota[bucket][field] = Math.max(0, Number(state.quota[bucket][field] || 0));
      }
    }
  }
  state.statsMethod ||= 'batchGetStats';
  state.lastError ||= null;
  return state;
}

async function readJsonResponse(response, maximumBytes) {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new YouTubeDataApiError('YouTube API response exceeded the size limit', { category: 'response-too-large' });
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new YouTubeDataApiError('YouTube API response exceeded the size limit', { category: 'response-too-large' });
  }
  try { return JSON.parse(text); } catch {
    throw new YouTubeDataApiError('YouTube API returned invalid JSON', { category: 'invalid-response' });
  }
}

function requestCategory(status, payload) {
  const reason = payload?.error?.errors?.[0]?.reason;
  if (status === 403 && ['quotaExceeded', 'dailyLimitExceeded'].includes(reason)) return 'quota-exhausted';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  return `http-${status}`;
}

export class YouTubeDataApiClient {
  constructor({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 15_000, maxResponseBytes = 1024 * 1024, reserve }) {
    if (!apiKey) throw new Error('YouTube API key is not configured');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.reserve = reserve || (async () => {});
  }

  async request(path, parameters, { bucket = 'general', priority = 'normal' } = {}) {
    await this.reserve(bucket, 1, priority);
    const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
    for (const [name, value] of Object.entries(parameters)) {
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    }
    url.searchParams.set('key', this.apiKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url.toString(), { signal: controller.signal, redirect: 'error' });
      const payload = await readJsonResponse(response, this.maxResponseBytes);
      if (!response.ok) {
        const category = requestCategory(response.status, payload);
        throw new YouTubeDataApiError(`YouTube API HTTP ${response.status}`, {
          category, status: response.status,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof YouTubeDataApiError) throw error;
      throw new YouTubeDataApiError(
        error?.name === 'AbortError' ? 'YouTube API request timed out' : 'YouTube API network request failed',
        { category: error?.name === 'AbortError' ? 'timeout' : 'network', retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async listChannels(channelIds) {
    if (channelIds.length > CHANNEL_BATCH_SIZE) throw new Error('channels.list supports at most 50 channel IDs');
    return await this.request('channels', {
      part: 'statistics,contentDetails', id: channelIds.join(','), maxResults: CHANNEL_BATCH_SIZE,
      fields: 'items(id,etag,statistics(viewCount,subscriberCount,hiddenSubscriberCount,videoCount),contentDetails(relatedPlaylists(uploads)))',
    }, { priority: 'detector' });
  }

  async listPlaylistItems(playlistId, pageToken = null) {
    return await this.request('playlistItems', {
      part: 'snippet,contentDetails,status', playlistId, maxResults: 50, pageToken,
      fields: 'nextPageToken,items(id,snippet(publishedAt,channelId,channelTitle,title,thumbnails,resourceId,videoOwnerChannelId,videoOwnerChannelTitle),contentDetails(videoId,videoPublishedAt),status(privacyStatus))',
    }, { priority: 'reconcile' });
  }

  async listVideoDetails(videoIds) {
    if (videoIds.length > VIDEO_BATCH_SIZE) throw new Error('videos.list supports at most 50 video IDs');
    return await this.request('videos', {
      part: 'snippet,contentDetails,status,liveStreamingDetails', id: videoIds.join(','), maxResults: 50,
      fields: 'items(id,snippet(publishedAt,channelId,channelTitle,title,thumbnails,liveBroadcastContent),contentDetails(duration),status(privacyStatus,uploadStatus,embeddable,madeForKids),liveStreamingDetails(scheduledStartTime,actualStartTime,actualEndTime,concurrentViewers))',
    }, { priority: 'metadata' });
  }

  async batchGetStats(videoIds, method = 'batchGetStats') {
    if (videoIds.length > VIDEO_BATCH_SIZE) throw new Error('video statistics supports at most 50 video IDs');
    if (method === 'videos.list') {
      return await this.request('videos', {
        part: 'statistics', id: videoIds.join(','), maxResults: 50,
        fields: 'items(id,statistics(viewCount,likeCount,commentCount))',
      }, { bucket: 'general', priority: 'metrics' });
    }
    return await this.request('videos:batchGetStats', {
      part: 'statistics', id: videoIds.join(','),
      fields: 'items(id,statistics(viewCount,likeCount,commentCount)),summary',
    }, { bucket: 'statistics', priority: 'metrics' });
  }
}

function bestThumbnail(thumbnails = {}) {
  for (const name of ['maxres', 'standard', 'high', 'medium', 'default']) {
    if (thumbnails[name]?.url) return thumbnails[name].url;
  }
  return null;
}

function validVideoId(value) {
  return /^[A-Za-z0-9_-]{6,32}$/.test(String(value || ''));
}

function playlistUpload(item) {
  const snippet = item?.snippet || {};
  const videoId = item?.contentDetails?.videoId || snippet?.resourceId?.videoId;
  const published = item?.contentDetails?.videoPublishedAt || snippet?.publishedAt;
  const title = String(snippet.title || '');
  if (!validVideoId(videoId) || !Number.isFinite(Date.parse(published || ''))) return null;
  if (item?.status?.privacyStatus && item.status.privacyStatus !== 'public') return null;
  if (/^(deleted|private) video$/i.test(title.trim())) return null;
  return {
    videoId, title, published, thumbnail: bestThumbnail(snippet.thumbnails),
    link: `https://www.youtube.com/watch?v=${videoId}`,
    channelTitle: snippet.videoOwnerChannelTitle || snippet.channelTitle || null,
    views: null, likes: null, comments: null, dislikes: null,
  };
}

function detailedUpload(item) {
  if (!item?.id || item?.status?.privacyStatus !== 'public' || !item?.snippet) return null;
  const scheduledStartTime = item.liveStreamingDetails?.scheduledStartTime || null;
  const live = item.snippet.liveBroadcastContent;
  return {
    videoId: item.id,
    title: String(item.snippet.title || ''),
    published: item.snippet.publishedAt,
    publishedAt: scheduledStartTime || item.snippet.publishedAt,
    scheduledStartTime,
    type: live === 'upcoming' ? 'live_scheduled' : live === 'live' ? 'live' : 'video',
    thumbnail: bestThumbnail(item.snippet.thumbnails),
    link: `https://www.youtube.com/watch?v=${item.id}`,
    channelTitle: item.snippet.channelTitle || null,
    views: null, likes: null, comments: null, dislikes: null,
  };
}

export async function fetchPlaylistReconciliation({ api, playlistId, knownIds = [], maximumPages = 3 }) {
  const known = new Set(knownIds);
  const items = [];
  let pageToken = null;
  let pageCount = 0;
  let overlap = false;
  do {
    const payload = await api.listPlaylistItems(playlistId, pageToken);
    pageCount++;
    for (const item of payload.items || []) {
      const upload = playlistUpload(item);
      if (!upload) continue;
      if (known.has(upload.videoId)) overlap = true;
      items.push(upload);
    }
    pageToken = payload.nextPageToken || null;
  } while (known.size > 0 && !overlap && pageToken && pageCount < maximumPages);

  const unknownIds = items.filter((item) => !known.has(item.videoId)).map((item) => item.videoId);
  const details = new Map();
  for (const ids of chunked([...new Set(unknownIds)], VIDEO_BATCH_SIZE)) {
    const payload = await api.listVideoDetails(ids);
    for (const item of payload.items || []) {
      const upload = detailedUpload(item);
      if (upload) details.set(upload.videoId, upload);
    }
  }
  const uploads = items
    .filter((item) => known.has(item.videoId) || details.has(item.videoId))
    .map((item) => details.get(item.videoId) || item);
  return { uploads, pageCount, overlap, truncatedWithoutOverlap: known.size > 0 && !overlap && Boolean(pageToken) };
}

export function metricCadenceMinutes(video, pollState, nowMs, newest) {
  if (newest) return 5;
  const age = Math.max(0, nowMs - Date.parse(video?.publishedAt || ''));
  if (!Number.isFinite(age) || age < 24 * 60 * 60 * 1000) return 5;
  if (age < 7 * 24 * 60 * 60 * 1000) return 15;
  if (age < 28 * 24 * 60 * 60 * 1000) return 60;
  return Number(pollState?.staticStreak || 0) >= 4 ? 1440 : 360;
}

export function selectDueMetricVideos(channelRecents, metricPoll, nowMs, { newestOnly = false } = {}) {
  const due = [];
  for (const [channelId, videos] of channelRecents) {
    const limit = newestOnly ? 1 : 3;
    for (let index = 0; index < Math.min(videos.length, limit); index++) {
      const video = videos[index];
      if (!validVideoId(video?.videoId)) continue;
      const prior = metricPoll[video.videoId];
      const cadence = metricCadenceMinutes(video, prior, nowMs, index === 0);
      if (!prior?.lastPolledAt || nowMs - Date.parse(prior.lastPolledAt) >= cadence * 60_000) {
        due.push({ channelId, video, cadence });
      }
    }
  }
  return due;
}

export function pruneMetricPollToVisibleVideos(metricPoll, channelRecents) {
  const visibleVideoIds = new Set();
  for (const videos of channelRecents.values()) {
    for (const video of videos.slice(0, 3)) {
      if (validVideoId(video?.videoId)) visibleVideoIds.add(video.videoId);
    }
  }
  return Object.fromEntries(Object.entries(metricPoll || {})
    .filter(([videoId]) => visibleVideoIds.has(videoId)));
}

export function normalizeStatistics(payload) {
  const result = new Map();
  for (const item of payload?.items || []) {
    if (!validVideoId(item?.id)) continue;
    result.set(item.id, {
      views: item.statistics?.viewCount != null ? String(item.statistics.viewCount) : null,
      likes: item.statistics?.likeCount != null ? String(item.statistics.likeCount) : null,
      comments: item.statistics?.commentCount != null ? String(item.statistics.commentCount) : null,
      dislikes: null,
    });
  }
  return result;
}

export function updateMetricPollObservation(previous, metrics, observedAtMs) {
  const observedAt = new Date(observedAtMs).toISOString();
  // Comment activity is intentionally excluded from the cadence signature:
  // it is retained locally for future work but cannot make older videos look
  // active or influence current view/like polling behavior.
  const cadenceSignature = JSON.stringify({
    views: metrics?.views ?? null,
    likes: metrics?.likes ?? null,
    dislikes: metrics?.dislikes ?? null,
  });
  let previousCadenceSignature = previous?.lastObserved;
  try {
    const parsed = JSON.parse(previousCadenceSignature);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Normalize the pre-local-observation format, whose signature included
      // comments, without resetting an otherwise unchanged static streak.
      previousCadenceSignature = JSON.stringify({
        views: parsed.views ?? null,
        likes: parsed.likes ?? null,
        dislikes: parsed.dislikes ?? null,
      });
    }
  } catch { /* old/malformed signatures simply start a fresh streak */ }
  return {
    lastPolledAt: observedAt,
    lastObserved: cadenceSignature,
    staticStreak: previousCadenceSignature === cadenceSignature
      ? Number(previous.staticStreak || 0) + 1
      : 0,
    commentObservation: {
      count: metrics?.comments == null ? null : String(metrics.comments),
      observedAt,
    },
  };
}

export const youtubeDataApiLimits = { channelBatchSize: CHANNEL_BATCH_SIZE, videoBatchSize: VIDEO_BATCH_SIZE };
