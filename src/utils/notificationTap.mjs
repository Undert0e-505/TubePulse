const VALID_TAP_ACTIONS = new Set(['video', 'channel']);

function asPositiveCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}
function normalizeIds(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))];
}

export function parseNotificationContentIds(data = {}) {
  const contentIds = normalizeIds(data.contentIds);
  if (contentIds.length) return contentIds;
  return normalizeIds(data.videoIds);
}

export function resolveNotificationTapAction(payloadAction, localAction = 'video') {
  if (VALID_TAP_ACTIONS.has(payloadAction)) return payloadAction;
  return VALID_TAP_ACTIONS.has(localAction) ? localAction : 'video';
}

export function isBatchNotification(data = {}) {
  return data.type === 'batch' || asPositiveCount(data.count) > 1;
}

export function channelUrl(channelId, handle, suffix = '') {
  if (handle) return `https://www.youtube.com/@${handle}${suffix}`;
  return channelId ? `https://www.youtube.com/channel/${channelId}${suffix}` : null;
}

export function notificationTapPlan(data = {}, { localTapAction = 'video', handle = null } = {}) {
  const isPost = (data.type === 'post' || (data.type === 'nag' && data.activityId)) && data.activityId;
  if (isPost) {
    return {
      kind: 'post',
      url: data.postLink || channelUrl(data.channelId, handle, '/community'),
      contentIds: [`post:${data.activityId}`],
      clearAll: false,
    };
  }

  if (data.type === 'prewarn' && data.videoId) {
    return {
      kind: 'prewarn',
      url: data.videoLink || `https://www.youtube.com/watch?v=${data.videoId}`,
      contentIds: [],
      clearAll: false,
    };
  }

  if (isBatchNotification(data)) {
    const contentIds = parseNotificationContentIds(data);
    return {
      kind: 'batch',
      url: channelUrl(data.channelId, handle),
      contentIds,
      clearAll: contentIds.length === 0,
    };
  }

  if (!data.videoId) return null;
  const action = resolveNotificationTapAction(data.tapAction, localTapAction);
  if (action === 'channel') {
    return {
      kind: 'channel',
      url: channelUrl(data.channelId, handle),
      contentIds: [],
      clearAll: true,
    };
  }
  return {
    kind: 'video',
    url: data.videoLink || `https://www.youtube.com/watch?v=${data.videoId}`,
    contentIds: [data.videoId],
    clearAll: false,
  };
}

function cachedContentIds(cached = {}) {
  return [
    ...(cached.videos || []).map((video) => video?.videoId),
    cached.latestVideo?.videoId,
    ...(cached.posts || []).map((post) => (
      post?.activityId || post?.postId ? `post:${post.activityId || post.postId}` : null
    )),
  ].filter(Boolean);
}

export function applyOptimisticNotificationSeen({
  channels = [], cache = {}, lastSeen = {}, channelId, contentIds = [], clearAll = false,
}) {
  const channel = channels.find((entry) => entry.channelId === channelId);
  const handle = channel?.handle || null;
  if (!handle) return { cache, lastSeen, handle: null, seenIds: [] };

  const cached = cache[handle] || {};
  const seenIds = clearAll ? cachedContentIds(cached) : normalizeIds(contentIds);
  const seenSet = new Set(seenIds);
  const currentSeen = new Set(lastSeen[handle]?.seenIds || []);
  for (const id of seenSet) currentSeen.add(id);

  const markVideo = (video) => (
    video?.videoId && (clearAll || seenSet.has(video.videoId))
      ? { ...video, unwatched: false }
      : video
  );
  const markPost = (post) => {
    const id = post?.activityId || post?.postId;
    return id && (clearAll || seenSet.has(`post:${id}`))
      ? { ...post, unwatched: false }
      : post;
  };

  return {
    handle,
    seenIds,
    lastSeen: {
      ...lastSeen,
      [handle]: { ...(lastSeen[handle] || {}), seenIds: [...currentSeen] },
    },
    cache: {
      ...cache,
      [handle]: {
        ...cached,
        videos: (cached.videos || []).map(markVideo),
        latestVideo: cached.latestVideo ? markVideo(cached.latestVideo) : cached.latestVideo,
        posts: (cached.posts || []).map(markPost),
      },
    },
  };
}

export function notificationTapDedupeKey(data = {}) {
  return [
    data.type || 'video',
    data.channelId || '',
    data.videoId || '',
    data.activityId || '',
    data.count || '',
    parseNotificationContentIds(data).join(','),
  ].join('|');
}
