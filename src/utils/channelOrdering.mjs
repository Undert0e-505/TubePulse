function parseVideoTimestamp(video) {
  const raw = video?.publishedAt ?? video?.published;
  if (!raw) return null;
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}
export function newestCachedVideoTimestamp(channel, cache = {}) {
  const cached = cache?.[channel?.handle] || {};
  const videos = Array.isArray(cached.videos) ? cached.videos : [];
  const candidates = cached.latestVideo ? [...videos, cached.latestVideo] : videos;
  let newest = null;
  for (const video of candidates) {
    const timestamp = parseVideoTimestamp(video);
    if (timestamp !== null && (newest === null || timestamp > newest)) newest = timestamp;
  }
  return newest;
}

export function orderChannels(channels = [], cache = {}, autoOrder = false) {
  const manual = Array.isArray(channels) ? channels : [];
  if (!autoOrder) return [...manual];
  return manual
    .map((channel, manualIndex) => ({
      channel,
      manualIndex,
      timestamp: newestCachedVideoTimestamp(channel, cache),
    }))
    .sort((left, right) => {
      if (left.timestamp === null && right.timestamp !== null) return 1;
      if (left.timestamp !== null && right.timestamp === null) return -1;
      if (left.timestamp !== null && right.timestamp !== null && left.timestamp !== right.timestamp) {
        return right.timestamp - left.timestamp;
      }
      return left.manualIndex - right.manualIndex;
    })
    .map(({ channel }) => channel);
}
