export function collectUnseenContentSnapshot(videos = [], posts = []) {
  return [
    ...videos.filter((video) => video?.unwatched === true).map((video) => video.videoId),
    ...posts.filter((post) => post?.unwatched === true).map((post) => {
      const id = post.activityId || post.postId;
      return id ? `post:${id}` : null;
    }),
  ].filter(Boolean);
}

export function collectChannelUnseenSnapshots(channels = [], getVideos, getPosts) {
  return channels.map((channel) => ({
    handle: channel.handle,
    channelId: channel.channelId,
    contentIds: collectUnseenContentSnapshot(
      getVideos(channel.handle),
      getPosts(channel.handle),
    ),
  })).filter((snapshot) => snapshot.channelId && snapshot.contentIds.length);
}
