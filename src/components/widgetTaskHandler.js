import React from 'react';
import { Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TubePulseWidget } from './TubePulseWidget';
import { getChannels, getSettings, getLastSeen, saveLastSeen, getChannelCache, saveChannelCache } from '../utils/storage';
import { fetchFeed, getDeviceId, markSeen } from '../utils/api';
import {
  formatCompactAge,
  getPostSeenId,
  resolveOptionalMetric,
} from '../utils/feedPresentation';
import { orderChannels } from '../utils/channelOrdering.mjs';
import { enqueueSeenMutation, flushSeenMutationQueue } from '../utils/seenPersistence.mjs';
import {
  projectWidgetOrderingCache,
  selectWidgetChannelPresentation,
} from '../utils/widgetPresentation.mjs';
const nameToWidget = {
  TubePulseWidget: TubePulseWidget,
};

function normalizeVideo(video = {}) {
  return {
    videoId: video.videoId,
    title: video.title,
    thumbnail: video.thumbnail,
    link: video.link,
    published: video.published || video.publishedAt,
    publishedAt: video.publishedAt || video.published,
    views: video.views || '',
    likes: resolveOptionalMetric(video, 'likes'),
    dislikes: resolveOptionalMetric(video, 'dislikes'),
    unwatched: video.unwatched,
    kind: 'video',
  };
}

function normalizePost(post = {}) {
  return {
    ...post,
    id: post.id || getPostSeenId(post),
    postId: post.postId || post.activityId,
    activityId: post.activityId || post.postId,
    kind: post.kind || 'community',
    type: 'post',
  };
}

function getChannelId(handle, channels, cache) {
  return cache[handle]?.channelId || channels.find((ch) => ch.handle === handle)?.channelId || null;
}

async function updateCachedChannel(handle, updater) {
  const cache = await getChannelCache();
  const current = cache[handle];
  if (!current) return;
  const next = updater(current);
  await saveChannelCache({ ...cache, [handle]: next });
}

async function buildWidgetData(fetchFresh = false) {
  try {
    const [channels, settings, lastSeen, cache] = await Promise.all([
      getChannels(),
      getSettings(),
      getLastSeen(),
      getChannelCache(),
    ]);

    let activeCache = cache;

    // If cache is empty or a fresh fetch is requested, pull from server.
    // We also fetch fresh on WIDGET_UPDATE because the FCM background
    // handler may have updated the cache but the server may have even
    // newer data (e.g. engagement metrics, a second new video that
    // arrived between the push and the widget render).
    const cacheEmpty = Object.keys(cache).length === 0;
    if ((cacheEmpty || fetchFresh) && channels.length > 0) {
      try {
        const deviceId = await getDeviceId();
        if (deviceId) {
          const result = await fetchFeed(deviceId);
          if (result.ok && Array.isArray(result.channels)) {
            const newCache = {};
            const channelById = Object.fromEntries(
              channels.filter(c => c.channelId).map(c => [c.channelId, c])
            );
            for (const feed of result.channels) {
              const local = channelById[feed.channelId];
              const handle = local?.handle;
              if (!handle) continue;
              const videos = (feed.videos || []).map(normalizeVideo);
              const prevEntry = cache[handle] || {};

              // Preserve last-known-good avatar: if the fresh fetch
              // returns no avatarUrl, keep the previously cached one.
              // This prevents partial server responses from wiping
              // widget images that were displaying fine.
              const freshAvatar = feed.meta?.avatarUrl || null;
              const avatar = freshAvatar || prevEntry.avatar || null;

              // Preserve last-known-good thumbnails: merge new videos
              // with old, keeping old thumbnails when new ones are
              // missing.
              const prevVideosById = new Map(
                (prevEntry.videos || []).map(v => [v.videoId, v])
              );
              const mergedVideos = videos.map(v => ({
                ...v,
                thumbnail: v.thumbnail || prevVideosById.get(v.videoId)?.thumbnail || null,
              }));

              newCache[handle] = {
                name: feed.meta?.name || local?.name || prevEntry.name || handle,
                avatar,
                videos: mergedVideos,
                posts: feed.posts || prevEntry.posts || [],
                latestVideo: mergedVideos[0] || null,
                channelId: feed.channelId || prevEntry.channelId,
                lastChecked: new Date().toISOString(),
              };
            }
            // Preserve any local-only channels that weren't in the server response
            for (const ch of channels) {
              if (!newCache[ch.handle] && cache[ch.handle]) {
                newCache[ch.handle] = cache[ch.handle];
              }
            }
            if (Object.keys(newCache).length > 0) {
              await saveChannelCache(newCache);
              activeCache = newCache;
            }
          }
        }
      } catch {
        // Network failed â€” fall through to whatever cache we have
      }
    }

    // Build widget channel data with videos and posts
    const widgetOrderingCache = projectWidgetOrderingCache(activeCache);
    const displayedChannels = orderChannels(
      channels,
      widgetOrderingCache,
      settings.autoOrderChannels === true,
    );
    const widgetChannels = displayedChannels.map((ch) => {
      const cached = activeCache[ch.handle];
      const seenIds = lastSeen[ch.handle]?.seenIds || [];

      const allVideos = cached?.videos?.length
        ? cached.videos.map(normalizeVideo)
        : (cached?.latestVideo ? [normalizeVideo(cached.latestVideo)] : []);
      const allPosts = (cached?.posts || []).map(normalizePost);
      const { selected, unseenCount } = selectWidgetChannelPresentation({
        videos: allVideos,
        posts: allPosts,
        seenIds,
      });
      const hasNew = unseenCount > 0;

      const videoRows = selected?.type === 'video' ? [{
        ...selected.item,
        timeAgo: formatCompactAge(selected.item.published || selected.item.publishedAt),
        seen: selected.seen,
        handle: ch.handle,
      }] : [];
      const postRows = selected?.type === 'post' ? [{
        ...selected.item,
        postId: selected.item.activityId || selected.item.postId,
        timeAgo: selected.item.publishedAt
          ? formatCompactAge(selected.item.publishedAt)
          : (selected.item.publishedText || ''),
        seen: selected.seen,
        handle: ch.handle,
      }] : [];

      return {
        handle: ch.handle,
        name: cached?.name || ch.name || ch.handle,
        avatar: cached?.avatar || null,
        channelId: cached?.channelId || ch.channelId || null,
        hasNew,
        unseenCount,
        tapAction: settings.tapAction || 'video',
        videos: videoRows,
        posts: postRows,
      };
    });

    return { channels: widgetChannels };
  } catch {
    return { channels: [] };
  }
}

async function markAllSeen(handle) {
  const [channels, cache, lastSeen] = await Promise.all([
    getChannels(),
    getChannelCache(),
    getLastSeen(),
  ]);
  const allVideos = cache[handle]?.videos || (cache[handle]?.latestVideo ? [cache[handle].latestVideo] : []);
  const allPosts = cache[handle]?.posts || [];
  const videoIds = allVideos.map(v => v.videoId).filter(Boolean);
  const postIds = allPosts.map(getPostSeenId).filter(Boolean);
  const existing = lastSeen[handle]?.seenIds || [];
  lastSeen[handle] = { seenIds: [...new Set([...existing, ...videoIds, ...postIds])] };
  await saveLastSeen(lastSeen);
  await updateCachedChannel(handle, (current) => ({
    ...current,
    videos: (current.videos || []).map((v) => ({ ...v, unwatched: false })),
    latestVideo: current.latestVideo ? { ...current.latestVideo, unwatched: false } : current.latestVideo,
    posts: (current.posts || []).map((p) => ({ ...p, unwatched: false })),
  }));

  const channelId = getChannelId(handle, channels, cache);
  const deviceId = await getDeviceId();
  if (channelId && [...videoIds, ...postIds].length) {
    await enqueueSeenMutation({
      storage: AsyncStorage, channelId, contentIds: [...videoIds, ...postIds],
    });
    flushSeenMutationQueue({ storage: AsyncStorage, deviceId, persist: markSeen }).catch(() => {});
  }
}

async function markWidgetVideoSeen(handle, videoId) {
  const [channels, cache, lastSeen] = await Promise.all([
    getChannels(),
    getChannelCache(),
    getLastSeen(),
  ]);
  const seenIds = lastSeen[handle]?.seenIds || [];
  if (!seenIds.includes(videoId)) {
    lastSeen[handle] = { seenIds: [...seenIds, videoId] };
    await saveLastSeen(lastSeen);
  }
  await updateCachedChannel(handle, (current) => ({
    ...current,
    videos: (current.videos || []).map((v) => v.videoId === videoId ? { ...v, unwatched: false } : v),
    latestVideo: current.latestVideo?.videoId === videoId ? { ...current.latestVideo, unwatched: false } : current.latestVideo,
  }));

  const channelId = getChannelId(handle, channels, cache);
  const deviceId = await getDeviceId();
  if (channelId) {
    await enqueueSeenMutation({ storage: AsyncStorage, channelId, contentIds: [videoId] });
    flushSeenMutationQueue({ storage: AsyncStorage, deviceId, persist: markSeen }).catch(() => {});
  }
}

async function markWidgetPostSeen(handle, postId) {
  const [channels, cache, lastSeen] = await Promise.all([
    getChannels(),
    getChannelCache(),
    getLastSeen(),
  ]);
  const rawPostId = String(postId || '');
  const postKey = rawPostId.startsWith('post:') ? rawPostId : `post:${rawPostId}`;
  const seenIds = lastSeen[handle]?.seenIds || [];
  if (!seenIds.includes(postKey)) {
    lastSeen[handle] = { seenIds: [...seenIds, postKey] };
    await saveLastSeen(lastSeen);
  }
  await updateCachedChannel(handle, (current) => ({
    ...current,
    posts: (current.posts || []).map((p) => getPostSeenId(p) === postKey ? { ...p, unwatched: false } : p),
  }));

  const channelId = getChannelId(handle, channels, cache);
  const deviceId = await getDeviceId();
  if (channelId) {
    await enqueueSeenMutation({ storage: AsyncStorage, channelId, contentIds: [postKey] });
    flushSeenMutationQueue({ storage: AsyncStorage, deviceId, persist: markSeen }).catch(() => {});
  }
}

export async function widgetTaskHandler(props) {
  const widgetInfo = props.widgetInfo;
  const Widget = nameToWidget[widgetInfo.widgetName];

  if (!Widget) {
    props.renderWidget(<TubePulseWidget channels={[]} />);
    return;
  }

  switch (props.widgetAction) {
    case 'WIDGET_ADDED': {
      // First add: try cache first, fall back to fresh fetch if empty.
      const cacheData = await buildWidgetData(false);
      if (cacheData.channels.length > 0) {
        props.renderWidget(<Widget {...cacheData} />);
      } else {
        const freshData = await buildWidgetData(true);
        props.renderWidget(<Widget {...freshData} />);
      }
      return;
    }
    case 'WIDGET_UPDATE':
    case 'WIDGET_RESIZED': {
      // Cache-first: render from local cache immediately. The cache is
      // kept up-to-date by HomeScreen refresh, FCM background handler,
      // and ChannelsScreen add/remove. A fresh server fetch is slower
      // and can time out, leaving the widget blank.
      const data = await buildWidgetData(false);
      props.renderWidget(<Widget {...data} />);
      return;
    }
    case 'WIDGET_CLICK': {
      // All custom click actions arrive as widgetAction='WIDGET_CLICK'.
      // The specific action name is in props.clickAction, and its
      // data is in props.clickActionData.
      const action = props.clickAction;
      const clickData = props.clickActionData || {};

      if (action === 'CHANNEL_MARK_ALL_CLICK') {
        // Avatar, channel header, or video row when tapAction='channel':
        // mark ALL videos + posts seen, then open channel.
        if (clickData.handle) {
          try {
            await markAllSeen(clickData.handle);
            await Linking.openURL(`https://www.youtube.com/@${clickData.handle}`);
          } catch {}
        }
      } else if (action === 'POST_CLICK') {
        // Post tap â€” mark just this post seen, open community tab.
        if (clickData.postId && clickData.handle) {
          try {
            await markWidgetPostSeen(clickData.handle, clickData.postId);
            if (clickData.link) {
              await Linking.openURL(clickData.link);
            } else {
              await Linking.openURL(`https://www.youtube.com/@${clickData.handle}/community`);
            }
          } catch {}
        }
      } else if (action === 'WIDGET_CLICK') {
        // Video row tap when tapAction='video' (default):
        // mark just this video seen, open the video.
        if (clickData.videoId && clickData.handle) {
          try {
            await markWidgetVideoSeen(clickData.handle, clickData.videoId);
            if (clickData.link) await Linking.openURL(clickData.link);
          } catch {}
        }
      }

      const data = await buildWidgetData();
      props.renderWidget(<Widget {...data} />);
      return;
    }
    case 'WIDGET_DELETED':
      return;
    default:
      props.renderWidget(<TubePulseWidget channels={[]} />);
      return;
  }
}

/**
 * Request widget update from app code (HomeScreen, ChannelsScreen, etc).
 *
 * This wraps react-native-android-widget's requestWidgetUpdate with
 * the correct renderWidget callback. Without the callback, the library
 * finds widget instances but cannot render them — drawWidgetById is
 * never called and the widget doesn't update.
 *
 * @param {string} reason - Brief label for debugging (e.g. 'channel-added')
 */
export async function updateWidget(reason = 'app') {
  try {
    const { requestWidgetUpdate } = require('react-native-android-widget');
    const data = await buildWidgetData(false);
    console.log(`[Widget] updateWidget('${reason}'): ${data.channels.length} channel(s)`);
    await requestWidgetUpdate({
      widgetName: 'TubePulseWidget',
      renderWidget: async () => {
        return <TubePulseWidget {...data} />;
      },
      widgetNotFound: () => {
        console.log(`[Widget] updateWidget('${reason}'): no widget instances on home screen`);
      },
    });
    console.log(`[Widget] updateWidget('${reason}'): done`);
  } catch (e) {
    console.warn(`[Widget] updateWidget('${reason}'): failed`, e?.message || e);
  }
}
