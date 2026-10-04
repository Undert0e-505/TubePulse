export function getContentTimestampMs(item, fields) {
  for (const field of fields) {
    const value = item?.[field];
    if (!value) continue;
    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

export function chooseLatestChannelContent(video, post) {
  if (!video && !post) return null;
  if (!video) return post ? { type: 'post', item: post } : null;
  if (!post) return { type: 'video', item: video };

  const videoTime = getContentTimestampMs(video, ['published', 'publishedAt']);
  const postTime = getContentTimestampMs(post, ['publishedAt']);

  if (videoTime != null && postTime != null) {
    return postTime > videoTime
      ? { type: 'post', item: post }
      : { type: 'video', item: video };
  }
  if (videoTime != null) return { type: 'video', item: video };
  if (postTime != null) return { type: 'post', item: post };
  return { type: 'video', item: video };
}

export function sortVideosNewestFirst(videos = []) {
  return [...videos].sort((a, b) => {
    const bTime = getContentTimestampMs(b, ['published', 'publishedAt']) ?? 0;
    const aTime = getContentTimestampMs(a, ['published', 'publishedAt']) ?? 0;
    return bTime - aTime;
  });
}

export function sortPostsNewestFirst(posts = []) {
  return [...posts].sort((a, b) => {
    const bTime = getContentTimestampMs(b, ['publishedAt']) ?? 0;
    const aTime = getContentTimestampMs(a, ['publishedAt']) ?? 0;
    return bTime - aTime;
  });
}

export function getPostSeenId(post) {
  if (!post) return null;
  if (post.id) return post.id;
  return post.activityId ? `post:${post.activityId}` : null;
}

export function formatCompactAge(dateStr, nowMs = Date.now()) {
  if (!dateStr) return '';
  const publishedMs = new Date(dateStr).getTime();
  if (!Number.isFinite(publishedMs)) return '';
  const diff = Math.max(0, nowMs - publishedMs);
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  return `${Math.floor(days / 365)}y`;
}

export function formatViews(views) {
  const n = parseInt(views, 10);
  if (isNaN(n)) return '';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M views`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K views`;
  return `${n} views`;
}

export function formatCompactCount(value) {
  const num = parseInt(value, 10);
  if (isNaN(num)) return '';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${num}`;
}

export function hasKnownMetric(value) {
  return value !== null
    && value !== undefined
    && value !== ''
    && Number.isFinite(Number(value));
}

/**
 * Prefer an explicitly returned server metric, including explicit null.
 * Fall back to cached data only when an older server omitted the field.
 */
export function resolveOptionalMetric(source, field, fallback = null) {
  if (source && Object.prototype.hasOwnProperty.call(source, field)) {
    return hasKnownMetric(source[field]) ? source[field] : null;
  }
  return hasKnownMetric(fallback) ? fallback : null;
}
