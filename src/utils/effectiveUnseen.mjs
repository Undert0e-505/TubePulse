function normalizeIds(values) {
  return new Set(Array.from(values || [])
    .map((value) => String(value || '').trim())
    .filter(Boolean));
}

export function effectiveContentId(item, type) {
  if (type === 'post') {
    const id = item?.id || item?.activityId || item?.postId;
    if (!id) return null;
    return String(id).startsWith('post:') ? String(id) : `post:${id}`;
  }
  return item?.videoId ? String(item.videoId) : null;
}

export function collectPendingSeenIds(queue) {
  const ids = [];
  for (const intent of (queue?.intents || [])) {
    for (const id of (intent?.contentIds || [])) ids.push(id);
  }
  return normalizeIds(ids);
}

export function selectEffectiveChannelUnseen({
  videos = [],
  posts = [],
  maxVideos = videos.length,
  locallySeenIds = [],
  pendingSeenIds = [],
  isPostRepresented = () => true,
} = {}) {
  const overlay = normalizeIds([...locallySeenIds, ...pendingSeenIds]);
  const representedVideos = videos.slice(0, Math.max(0, Number(maxVideos) || 0));
  const unseenVideos = representedVideos.filter((video) => {
    const id = effectiveContentId(video, 'video');
    return video?.unwatched === true && id && !overlay.has(id);
  });
  const unseenPosts = posts.filter((post) => {
    const id = effectiveContentId(post, 'post');
    return post?.unwatched === true && id && !overlay.has(id) && isPostRepresented(post);
  });
  const contentIds = [
    ...unseenVideos.map((video) => effectiveContentId(video, 'video')),
    ...unseenPosts.map((post) => effectiveContentId(post, 'post')),
  ];
  return {
    videos: unseenVideos,
    posts: unseenPosts,
    contentIds,
    hasUnseen: contentIds.length > 0,
  };
}
