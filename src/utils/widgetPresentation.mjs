import {
  chooseLatestChannelContent,
  getPostSeenId,
  sortPostsNewestFirst,
  sortVideosNewestFirst,
} from './feedPresentation.js';

function isVideoUnwatched(video, seenIds) {
  if (video?.unwatched === true) return true;
  if (video?.unwatched === false) return false;
  return Boolean(video?.videoId) && !seenIds.includes(video.videoId);
}

function isPostUnwatched(post, seenIds) {
  if (post?.unwatched === true) return true;
  if (post?.unwatched === false) return false;
  const postKey = getPostSeenId(post);
  return Boolean(postKey) && !seenIds.includes(postKey);
}

export function selectWidgetChannelPresentation({ videos = [], posts = [], seenIds = [] } = {}) {
  const sortedVideos = sortVideosNewestFirst(videos);
  const sortedPosts = sortPostsNewestFirst(posts);
  const selected = chooseLatestChannelContent(sortedVideos[0] || null, sortedPosts[0] || null);
  const unseenCount = sortedVideos.filter((video) => isVideoUnwatched(video, seenIds)).length
    + sortedPosts.filter((post) => isPostUnwatched(post, seenIds)).length;

  if (!selected) return { selected: null, unseenCount };
  const seen = selected.type === 'video'
    ? !isVideoUnwatched(selected.item, seenIds)
    : !isPostUnwatched(selected.item, seenIds);
  return {
    selected: { ...selected, seen },
    unseenCount,
  };
}

export function projectWidgetOrderingCache(cache = {}) {
  return Object.fromEntries(Object.entries(cache || {}).map(([handle, entry = {}]) => {
    const videos = Array.isArray(entry.videos) && entry.videos.length
      ? entry.videos
      : (entry.latestVideo ? [entry.latestVideo] : []);
    const posts = Array.isArray(entry.posts) ? entry.posts : [];
    const { selected } = selectWidgetChannelPresentation({ videos, posts });
    const publishedAt = selected?.type === 'video'
      ? (selected.item.publishedAt || selected.item.published)
      : selected?.item?.publishedAt;
    return [handle, {
      ...entry,
      videos: publishedAt ? [{ publishedAt }] : [],
      latestVideo: null,
    }];
  }));
}
