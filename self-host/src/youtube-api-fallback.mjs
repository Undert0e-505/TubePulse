const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

export class YouTubeApiFallbackError extends Error {
  constructor(message, { category = 'youtube-api-failed', status = null, retryable = false } = {}) {
    super(message);
    this.name = 'YouTubeApiFallbackError';
    this.category = category;
    this.status = status;
    this.retryable = retryable;
  }
}

export function uploadsPlaylistId(channelId) {
  if (!CHANNEL_ID.test(String(channelId || ''))) throw new Error('Invalid YouTube channel ID');
  return `UU${channelId.slice(2)}`;
}

function bestThumbnail(thumbnails = {}) {
  for (const name of ['maxres', 'standard', 'high', 'medium', 'default']) {
    if (thumbnails[name]?.url) return thumbnails[name].url;
  }
  return null;
}

async function readTextLimited(response, maximumBytes) {
  if (!response.body?.getReader) {
    const body = await response.arrayBuffer();
    if (body.byteLength > maximumBytes) throw new YouTubeApiFallbackError(
      'YouTube API response exceeded the size limit', { category: 'response-too-large' },
    );
    return new TextDecoder().decode(body);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) throw new YouTubeApiFallbackError(
        'YouTube API response exceeded the size limit', { category: 'response-too-large' },
      );
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

export function adaptPlaylistItems(payload) {
  if (!payload || !Array.isArray(payload.items)) {
    throw new YouTubeApiFallbackError('YouTube API response shape was invalid', { category: 'invalid-response' });
  }
  const uploads = [];
  let channelName = null;
  for (const item of payload.items.slice(0, 15)) {
    const snippet = item?.snippet || {};
    const videoId = item?.contentDetails?.videoId || snippet?.resourceId?.videoId;
    const published = item?.contentDetails?.videoPublishedAt || snippet?.publishedAt;
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(String(videoId || '')) || !Number.isFinite(Date.parse(published || ''))) continue;
    channelName ||= snippet.videoOwnerChannelTitle || snippet.channelTitle || null;
    uploads.push({
      videoId,
      title: String(snippet.title || ''),
      published,
      thumbnail: bestThumbnail(snippet.thumbnails),
      link: `https://www.youtube.com/watch?v=${videoId}`,
      channelTitle: channelName,
      views: null,
      likes: null,
      dislikes: null,
    });
  }
  return { channelName, uploads };
}

export async function fetchUploadsPlaylist(channelId, {
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  maxResponseBytes = 512 * 1024,
} = {}) {
  if (!apiKey) throw new YouTubeApiFallbackError('YouTube API key is not configured', { category: 'not-configured' });
  const playlistId = uploadsPlaylistId(channelId);
  const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
  url.searchParams.set('part', 'snippet,contentDetails');
  url.searchParams.set('playlistId', playlistId);
  url.searchParams.set('maxResults', '15');
  url.searchParams.set('key', apiKey);
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new YouTubeApiFallbackError('YouTube API request timed out', { category: 'timeout', retryable: true }));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([expired, (async () => {
      const response = await fetchImpl(url.toString(), { signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        throw new YouTubeApiFallbackError(`YouTube API HTTP ${response.status}`, {
          category: response.status === 403 ? 'quota-or-forbidden' : `http-${response.status}`,
          status: response.status,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        });
      }
      const contentLength = Number(response.headers.get('Content-Length'));
      if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
        throw new YouTubeApiFallbackError('YouTube API response exceeded the size limit', { category: 'response-too-large' });
      }
      const text = await readTextLimited(response, maxResponseBytes);
      let payload;
      try { payload = JSON.parse(text); } catch {
        throw new YouTubeApiFallbackError('YouTube API returned invalid JSON', { category: 'invalid-response' });
      }
      return adaptPlaylistItems(payload);
    })()]);
  } catch (error) {
    if (error instanceof YouTubeApiFallbackError) throw error;
    throw new YouTubeApiFallbackError(
      error?.name === 'AbortError' ? 'YouTube API request timed out' : 'YouTube API network request failed',
      { category: error?.name === 'AbortError' ? 'timeout' : 'network', retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }
}

export const youtubeApiFallbackTestHelpers = { CHANNEL_ID };
