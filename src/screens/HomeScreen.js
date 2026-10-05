import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Image,
  StyleSheet,
  RefreshControl,
  Linking,
  ActivityIndicator,
  AppState,
} from 'react-native';
import { SvgXml } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS } from '../utils/constants';
import { getChannels, getSettings, getLastSeen, saveLastSeen, getChannelCache, saveChannelCache, getChannelDisplaySettings } from '../utils/storage';
import { fetchFeed, markSeen, getDeviceId } from '../utils/api';
import {
  chooseLatestChannelContent,
  formatCompactAge,
  formatCompactCount,
  formatViews,
  getPostSeenId,
  hasKnownMetric,
  resolveOptionalMetric,
  sortPostsNewestFirst,
  sortVideosNewestFirst,
} from '../utils/feedPresentation';
import { updateWidget } from '../components/widgetTaskHandler';
import { IS_TUBEPULSE_PREVIEW } from '../utils/apiEndpointConfig';
import {
  APP_INITIALIZATION_STORAGE_KEY,
  getPreviewHomeConnectionPhase,
  waitForCurrentInitialization,
} from '../utils/appInitialization.mjs';
import { runSeenMutation } from '../utils/seenPersistence.mjs';

const THUMB_UP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#666666" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M7 22V11" />
  <path d="M3 11h4v11H3z" />
  <path d="M7 11l4.5-8.5c.6-.1 1.2.1 1.6.5.4.5.5 1.1.4 1.7L12.5 9H20c.8 0 1.5.7 1.5 1.5l-1.5 9c-.1.7-.7 1.2-1.4 1.2H7" />
</svg>`;

const THUMB_DOWN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#666666" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" transform="rotate(180 12 12)">
  <path d="M7 22V11" />
  <path d="M3 11h4v11H3z" />
  <path d="M7 11l4.5-8.5c.6-.1 1.2.1 1.6.5.4.5.5 1.1.4 1.7L12.5 9H20c.8 0 1.5.7 1.5 1.5l-1.5 9c-.1.7-.7 1.2-1.4 1.2H7" />
</svg>`;

export default function HomeScreen({ navigation, previewInitializationMarker = null }) {
  const [channels, setChannels] = useState([]);
  const [cache, setCache] = useState({});
  const [lastSeen, setLastSeen] = useState({});
  const [settings, setSettings] = useState({ tapAction: 'video' });
  const [channelDisplaySettings, setChannelDisplaySettings] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [previewConnectionError, setPreviewConnectionError] = useState(null);
  const [seenPersistenceError, setSeenPersistenceError] = useState(null);
  const [previewInitializationPending, setPreviewInitializationPending] = useState(IS_TUBEPULSE_PREVIEW);
  const [nowMs, setNowMs] = useState(Date.now());
  // Hold the latest cache in a ref so refresh() can be stable
  // (depending on `cache` directly caused an infinite re-render loop
  //  because setCache -> new refresh -> new useEffect -> new autoFetch -> new setCache)
  const cacheRef = useRef({});
  // Track IDs that were recently marked seen locally, so that refresh()
  // (fired by AppState 'active' or useFocusEffect when returning from
  // YouTube) doesn't overwrite the optimistic clear before markSeen
  // has been processed server-side.
  const recentlySeenRef = useRef(new Set());
  const firstFocusRef = useRef(true);
  const previewInitializationPendingRef = useRef(IS_TUBEPULSE_PREVIEW);

  const loadData = useCallback(async () => {
    const [ch, s, ls, ca, cds] = await Promise.all([
      getChannels(),
      getSettings(),
      getLastSeen(),
      getChannelCache(),
      getChannelDisplaySettings(),
    ]);
    cacheRef.current = ca || {};
    setChannels(ch);
    setSettings(s);
    setLastSeen(ls);
    setCache(ca);
    setChannelDisplaySettings(cds || {});
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    // Focus/AppState events can arrive while the Preview app is still
    // registering. Ignore those refreshes instead of producing a known,
    // short-lived /feed 404 and a misleading red error banner.
    if (IS_TUBEPULSE_PREVIEW && previewInitializationPendingRef.current) return;

    setRefreshing(true);
    // Snapshot the recentlySeenRef at the start of this refresh cycle.
    // At the end of refresh, we clear recentlySeenRef for any IDs where
    // the server confirmed unwatched:false — those are persisted and no
    // longer need the race guard. IDs where the server still says
    // unwatched:true (markSeen still in-flight) are kept for the next
    // cycle. This prevents recentlySeenRef from accumulating stale IDs
    // that suppress blue dots on unrelated refreshes (e.g. mode switch).
    const seenSnapshot = new Set(recentlySeenRef.current);
    try {
      const deviceId = await getDeviceId();
      if (deviceId) {
        const result = await fetchFeed(deviceId);
        if (result.ok && result.channels) {
          setSeenPersistenceError(null);
          if (IS_TUBEPULSE_PREVIEW) setPreviewConnectionError(null);
          // v3 /feed returns { channels: [{ channelId, meta, videos, unwatchedCount }] }
          const [localChannels] = await Promise.all([getChannels()]);
          const newCache = {};
          const normalizedContentByChannelId = new Map();

          for (const serverChannel of result.channels) {
            const ch = localChannels.find((c) => c.channelId === serverChannel.channelId);
            const handle = ch?.handle || serverChannel.channelId;

            // Build a lookup of existing local videos by id so we can fall
            // back to locally-cached views if the server response is missing
            // the field (e.g. for a server response that was prepared by an
            // older worker build, or any other transient gap).
            const existingByVideoId = new Map(
              ((cacheRef.current[handle] || {}).videos || []).map((v) => [v.videoId, v])
            );

            const videos = (serverChannel.videos || []).map((v) => ({
              videoId: v.videoId,
              title: v.title,
              published: v.publishedAt,
              thumbnail: v.thumbnail,
              link: v.link,
              type: v.type,
              // Race guard: if this ID was recently marked seen locally
              // (tap in this session), keep it seen even if the server
              // still reports unwatched (markSeen may still be in-flight).
              // The snapshot is cleared at the end of refresh for IDs the
              // server confirms as seen, so this only affects the immediate
              // post-tap refresh cycle.
              unwatched: seenSnapshot.has(v.videoId) ? false : v.unwatched,
              views: v.views || existingByVideoId.get(v.videoId)?.views || '0',
              likes: resolveOptionalMetric(v, 'likes', existingByVideoId.get(v.videoId)?.likes),
              dislikes: resolveOptionalMetric(v, 'dislikes', existingByVideoId.get(v.videoId)?.dislikes),
            }));

            // Posts come from the server already filtered by the global +
            // per-channel override. Empty array when disabled or absent.
            // Override unwatched for recently-seen posts (race guard).
            const posts = (serverChannel.posts || []).map((p) => ({
              ...p,
              unwatched: seenSnapshot.has(getPostSeenId(p)) ? false : p.unwatched,
            }));
            normalizedContentByChannelId.set(serverChannel.channelId, { videos, posts });

            // Use the ref so this callback stays stable across renders
            const existingEntry = cacheRef.current[handle] || {};
            const localVideos = existingEntry.videos || [];
            // Use server data when available, preserve local-only channels
            const mergedVideos = videos.length > 0 ? videos : localVideos;

            newCache[handle] = {
              name: serverChannel.meta?.name || existingEntry.name,
              avatar: serverChannel.meta?.avatarUrl || existingEntry.avatar || null,
              videos: mergedVideos,
              posts,
              latestVideo: mergedVideos[0] || null,
              channelId: serverChannel.channelId,
              lastChecked: serverChannel.meta?.addedAt ? new Date(serverChannel.meta.addedAt).toISOString() : existingEntry.lastChecked,
            };
          }

          // Preserve channels that exist locally but weren't in server response
          for (const ch of localChannels) {
            if (!newCache[ch.handle] && cacheRef.current[ch.handle]) {
              newCache[ch.handle] = cacheRef.current[ch.handle];
            }
          }

          cacheRef.current = newCache;
          await saveChannelCache(newCache);
          setCache(newCache);

          // Update local lastSeen from server's unwatched data
          const lastSeen = await getLastSeen();
          for (const serverChannel of result.channels) {
            const ch = localChannels.find((c) => c.channelId === serverChannel.channelId);
            const handle = ch?.handle;
            if (!handle) continue;
            const normalized = normalizedContentByChannelId.get(serverChannel.channelId) || {
              videos: [],
              posts: [],
            };

            if (!lastSeen[handle]) lastSeen[handle] = { seenIds: [] };
            const seenIds = new Set(lastSeen[handle].seenIds || []);

            // Videos/posts NOT in unwatched are seen.
            // Use the already-guarded `videos`/`posts` arrays (which had
            // the seenSnapshot guard applied) so lastSeen stays consistent
            // with what the UI shows.
            for (const v of normalized.videos) {
              if (!v.unwatched && v.videoId) {
                seenIds.add(v.videoId);
              }
            }
            for (const p of normalized.posts) {
              if (!p.unwatched && p.activityId) {
                seenIds.add(`post:${p.activityId}`);
              }
            }
            lastSeen[handle].seenIds = [...seenIds];
          }
          await saveLastSeen(lastSeen);
          setLastSeen(lastSeen);

          // Prune recentlySeenRef: remove IDs the server now confirms as
          // seen (unwatched:false). Keep IDs where the server still says
          // unwatched:true — markSeen may still be in-flight.
          // This prevents stale entries from suppressing blue dots on
          // unrelated refreshes (e.g. returning from settings after a
          // mode switch).
          let prunedCount = 0;
          for (const serverChannel of result.channels) {
            for (const v of (serverChannel.videos || [])) {
              if (!v.unwatched && seenSnapshot.has(v.videoId)) {
                recentlySeenRef.current.delete(v.videoId);
                prunedCount++;
              }
            }
            for (const p of (serverChannel.posts || [])) {
              const pid = getPostSeenId(p);
              if (!p.unwatched && pid && seenSnapshot.has(pid)) {
                recentlySeenRef.current.delete(pid);
                prunedCount++;
              }
            }
          }
        } else if (IS_TUBEPULSE_PREVIEW) {
          setPreviewConnectionError(result.error || 'TubePulse Home is unavailable.');
        }
      } else {
        const ca = await getChannelCache();
        cacheRef.current = ca;
        setCache(ca);
      }
    } catch (e) {
      console.warn('Refresh failed:', e);
      if (IS_TUBEPULSE_PREVIEW) setPreviewConnectionError('TubePulse Home is unavailable.');
      const ca = await getChannelCache();
      cacheRef.current = ca;
      setCache(ca);
    }
    setRefreshing(false);

    try { await updateWidget('home-refresh'); } catch {}
  }, []); // stable: no deps, uses cacheRef

  const autoFetch = useCallback(async () => {
    try {
      // Preview Home must not issue /feed until this application mount has
      // finished its register/reconcile/bootstrap sequence. The exact marker
      // rejects both earlier processes and earlier mounts in this process.
      // Production keeps its historical wait semantics unchanged.
      if (IS_TUBEPULSE_PREVIEW) {
        await waitForCurrentInitialization({
          readCompletion: () => AsyncStorage.getItem(APP_INITIALIZATION_STORAGE_KEY),
          expectedMarker: previewInitializationMarker,
        });
      } else {
        const initDone = await AsyncStorage.getItem(APP_INITIALIZATION_STORAGE_KEY);
        if (!initDone) {
          for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const done = await AsyncStorage.getItem(APP_INITIALIZATION_STORAGE_KEY);
            if (done) break;
          }
        }
      }

      // From this point a Preview refresh is authoritative: initialization
      // either completed for this exact mount or the bounded wait expired.
      // A subsequent failure should be shown rather than suppressed.
      if (IS_TUBEPULSE_PREVIEW) previewInitializationPendingRef.current = false;

      // Init has written cache data — re-read everything before refreshing
      const [freshChannels, freshCache, freshLastSeen, freshSettings, freshDisplaySettings] = await Promise.all([
        getChannels(),
        getChannelCache(),
        getLastSeen(),
        getSettings(),
        getChannelDisplaySettings(),
      ]);
      cacheRef.current = freshCache || {};
      setChannels(freshChannels);
      setCache(freshCache);
      setLastSeen(freshLastSeen);
      setSettings(freshSettings);
      setChannelDisplaySettings(freshDisplaySettings || {});
      setLoading(false);

      // Now refresh from server (supplements local cache with live data)
      if (freshChannels.length > 0) {
        await refresh();
      }
    } catch (error) {
      console.warn('Initial Home load failed:', error);
      if (IS_TUBEPULSE_PREVIEW) {
        setPreviewConnectionError('TubePulse Home is unavailable.');
      }
      setLoading(false);
    } finally {
      if (IS_TUBEPULSE_PREVIEW) {
        previewInitializationPendingRef.current = false;
        setPreviewInitializationPending(false);
      }
    }
  }, [previewInitializationMarker, refresh]);

  useFocusEffect(
    useCallback(() => {
      // autoFetch owns the first Preview load and waits for registration.
      // Later focus events retain the normal immediate refresh behaviour.
      if (IS_TUBEPULSE_PREVIEW && firstFocusRef.current) {
        firstFocusRef.current = false;
        return undefined;
      }
      firstFocusRef.current = false;
      loadData().then(() => refresh());
      return undefined;
    }, [loadData, refresh])
  );

  useEffect(() => {
    autoFetch();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        refresh();
        try { updateWidget('app-active'); } catch {}
      }
    });

    return () => sub.remove();
  }, [loadData, refresh, autoFetch]);

  useEffect(() => {
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const getVideos = (handle) => {
    const cached = cache[handle];
    if (!cached) return [];
    const vids = cached.videos?.length ? cached.videos : (cached.latestVideo ? [cached.latestVideo] : []);
    return sortVideosNewestFirst(vids);
  };

  const getPosts = (handle) => {
    const cached = cache[handle];
    if (!cached || !cached.posts) return [];
    return sortPostsNewestFirst(cached.posts);
  };

  const isPostUnwatched = (post) => post?.unwatched === true;

  const selectPersistentLatestContent = (handle) => {
    return chooseLatestChannelContent(getVideos(handle)[0] || null, getPosts(handle)[0] || null);
  };

  const getEffectiveVideoCount = (handle) => {
    const override = channelDisplaySettings[handle]?.latestVideosPerChannel;
    if (override != null) return override;
    return settings.latestVideosPerChannel || 1;
  };

  const getVisiblePosts = (handle) => {
    const posts = getPosts(handle);
    const latestVideo = getVideos(handle)[0] || null;
    const visibleUnseen = posts.filter((post) => (
      isPostUnwatched(post)
      && chooseLatestChannelContent(latestVideo, post)?.type === 'post'
    ));
    if (visibleUnseen.length > 0) return visibleUnseen;
    const persistent = selectPersistentLatestContent(handle);
    if (persistent?.type === 'post') return [persistent.item];
    return [];
  };

  const getUnseenVideos = (handle) => {
    // Source of truth: the server's `unwatched` flag on each video in
    // the cache (populated from the /feed response). The local
    // `seenIds` is a UI cache used elsewhere (e.g. to display the
    // "seen" dot), but it is NOT a reliable filter for unseen videos:
    //   - The loadData sync only ADDS to seenIds (for videos the
    //     server marks as seen), never REMOVES (when the server
    //     later un-sees one, e.g. a missed-tap re-add or a cron
    //     re-classification).
    //   - A previous markSeen for a videoId that's since been
    //     re-classified as unseen server-side would still be in the
    //     local seenIds and would hide the video.
    // Result: filtering by !seenIds.includes() silently drops videos
    // the user genuinely hasn't watched yet, making the home screen
    // fall back to [latestVideo] when seenIds happens to cover
    // everything.
    return getVideos(handle).filter(v => v.unwatched === true);
  };

  const unseenCount = (handle) => getUnseenVideos(handle).length;

  const getCurrentVideo = (handle) => {
    const unseen = getUnseenVideos(handle);
    if (unseen.length > 0) return unseen[unseen.length - 1];
    const persistent = selectPersistentLatestContent(handle);
    return persistent?.type === 'video' ? persistent.item : null;
  };

  // Central helper: mark a single item seen locally + remotely.
  // Used by all tap paths (video mode, channel mode, post tap).
  // - Computes the canonical seen ID
  // - Adds to recentlySeenRef so refresh() doesn't reintroduce it
  // - Optimistically updates local cache (cacheRef + setCache + saveChannelCache)
  // - Awaits markSeen before returning (so caller can open URL after server confirms)
  const markItemSeen = async ({ handle, channelId, item, type }) => {
    const seenId = type === 'post' ? getPostSeenId(item) : item?.videoId;
    if (!seenId) return false;
    const previousCacheEntry = cacheRef.current[handle];
    const wasAlreadyPending = recentlySeenRef.current.has(seenId);

    // 1. Add to recentlySeenRef (guard against refresh overwrite)
    recentlySeenRef.current.add(seenId);

    // 2. Update lastSeen
    const ls = await getLastSeen();
    const previousLastSeenEntry = ls[handle]
      ? { ...ls[handle], seenIds: [...(ls[handle].seenIds || [])] }
      : null;
    if (!ls[handle]) ls[handle] = { seenIds: [] };
    if (!ls[handle].seenIds.includes(seenId)) {
      ls[handle] = { seenIds: [...ls[handle].seenIds, seenId] };
      await saveLastSeen(ls);
      setLastSeen(ls);
    }

    // 3. Optimistically update local cache
    const cached = cacheRef.current[handle];
    if (cached) {
      let updatedCache = { ...cacheRef.current, [handle]: { ...cached } };
      if (type === 'post' && cached.posts) {
        updatedCache[handle] = {
          ...updatedCache[handle],
          posts: cached.posts.map((p) =>
            p.activityId === item.activityId ? { ...p, unwatched: false } : p
          ),
        };
      } else if (cached.videos) {
        updatedCache[handle] = {
          ...updatedCache[handle],
          videos: cached.videos.map((v) =>
            v.videoId === seenId ? { ...v, unwatched: false } : v
          ),
        };
      }
      cacheRef.current = updatedCache;
      setCache(updatedCache);
      try { await saveChannelCache(updatedCache); } catch {}
    }

    // 4. Await markSeen on the server
    const deviceId = await getDeviceId();
    const result = await runSeenMutation({
      persist: () => markSeen(deviceId, channelId, [seenId]),
      rollback: async () => {
        if (!wasAlreadyPending) recentlySeenRef.current.delete(seenId);
        const restoredLastSeen = await getLastSeen();
        if (previousLastSeenEntry) restoredLastSeen[handle] = previousLastSeenEntry;
        else delete restoredLastSeen[handle];
        await saveLastSeen(restoredLastSeen);
        setLastSeen(restoredLastSeen);
        if (previousCacheEntry) {
          const restoredCache = { ...cacheRef.current, [handle]: previousCacheEntry };
          cacheRef.current = restoredCache;
          setCache(restoredCache);
          try { await saveChannelCache(restoredCache); } catch {}
        }
      },
    });
    if (result.ok) {
      setSeenPersistenceError(null);
      return true;
    }
    setSeenPersistenceError('Couldn’t save seen status. Pull to refresh and try again.');
    console.warn('[seen] markSeen failed', seenId, result.error);
    return false;
  };

  // Central helper: mark ALL items for a channel as seen (clearAll).
  // Used by channel-mode taps where we wipe everything and open the channel page.
  const markAllSeen = async ({ handle, channelId }) => {
    const previousCacheEntry = cacheRef.current[handle];
    const newlyPendingIds = [];

    // Add all current video/post IDs to recentlySeenRef
    const allVideos = getVideos(handle);
    const allPosts = getPosts(handle);
    for (const v of allVideos) {
      if (v.videoId) {
        if (!recentlySeenRef.current.has(v.videoId)) newlyPendingIds.push(v.videoId);
        recentlySeenRef.current.add(v.videoId);
      }
    }
    for (const p of allPosts) {
      const pid = getPostSeenId(p);
      if (pid) {
        if (!recentlySeenRef.current.has(pid)) newlyPendingIds.push(pid);
        recentlySeenRef.current.add(pid);
      }
    }

    // Update lastSeen
    const ls = await getLastSeen();
    const previousLastSeenEntry = ls[handle]
      ? { ...ls[handle], seenIds: [...(ls[handle].seenIds || [])] }
      : null;
    if (!ls[handle]) ls[handle] = { seenIds: [] };
    const allIds = [
      ...allVideos.map(v => v.videoId).filter(Boolean),
      ...allPosts.map(getPostSeenId).filter(Boolean),
    ];
    ls[handle] = { seenIds: [...new Set([...(ls[handle].seenIds || []), ...allIds])] };
    await saveLastSeen(ls);
    setLastSeen(ls);

    // Optimistically clear local cache
    const cached = cacheRef.current[handle];
    if (cached) {
      let updatedCache = { ...cacheRef.current, [handle]: { ...cached } };
      let changed = false;
      if (cached.videos?.some((v) => v.unwatched)) {
        updatedCache[handle] = {
          ...updatedCache[handle],
          videos: cached.videos.map((v) => ({ ...v, unwatched: false })),
        };
        changed = true;
      }
      if (cached.posts?.some(isPostUnwatched)) {
        updatedCache[handle] = {
          ...updatedCache[handle],
          posts: cached.posts.map((p) => ({ ...p, unwatched: false })),
        };
        changed = true;
      }
      if (changed) {
        cacheRef.current = updatedCache;
        setCache(updatedCache);
        try { await saveChannelCache(updatedCache); } catch {}
      }
    }

    // Await markSeen clearAll on server
    const deviceId = await getDeviceId();
    const result = await runSeenMutation({
      persist: () => markSeen(deviceId, channelId, [], true),
      rollback: async () => {
        for (const id of newlyPendingIds) recentlySeenRef.current.delete(id);
        const restoredLastSeen = await getLastSeen();
        if (previousLastSeenEntry) restoredLastSeen[handle] = previousLastSeenEntry;
        else delete restoredLastSeen[handle];
        await saveLastSeen(restoredLastSeen);
        setLastSeen(restoredLastSeen);
        if (previousCacheEntry) {
          const restoredCache = { ...cacheRef.current, [handle]: previousCacheEntry };
          cacheRef.current = restoredCache;
          setCache(restoredCache);
          try { await saveChannelCache(restoredCache); } catch {}
        }
      },
    });
    if (result.ok) {
      setSeenPersistenceError(null);
      return true;
    }
    setSeenPersistenceError('Couldn’t save seen status. Pull to refresh and try again.');
    console.warn('[seen] markSeen clearAll failed', channelId, result.error);
    return false;
  };

  const handleChannelOpen = async (channel) => {

    // Mark all items seen (local + server) BEFORE opening YouTube.
    // Awaiting ensures the server has processed clearAll before the
    // app backgrounds and refresh() fires on return.
    await markAllSeen({ handle: channel.handle, channelId: channel.channelId });

    try { await updateWidget('channel-open'); } catch {}

    Linking.openURL(`https://www.youtube.com/@${channel.handle}`);
  };

  const handleTap = async (channel) => {

    if (settings.tapAction === 'channel') {
      await markAllSeen({ handle: channel.handle, channelId: channel.channelId });
    } else {
      const video = getCurrentVideo(channel.handle);
      if (video) {
        await markItemSeen({ handle: channel.handle, channelId: channel.channelId, item: video, type: 'video' });
      }
    }

    try { await updateWidget('handle-tap'); } catch {}

    if (settings.tapAction === 'channel') {
      Linking.openURL(`https://www.youtube.com/@${channel.handle}`);
    } else {
      const video = getCurrentVideo(channel.handle);
      if (video) Linking.openURL(video.link);
    }
  };

  const handleVideoTap = async (channel, video) => {

    if (settings.tapAction === 'channel') {
      handleChannelOpen(channel);
      return;
    }

    await markItemSeen({ handle: channel.handle, channelId: channel.channelId, item: video, type: 'video' });

    try { await updateWidget('video-tap'); } catch {}

    Linking.openURL(video.link);
  };

  const handlePostTap = async (channel, post) => {
    const postKey = getPostSeenId(post);

    if (settings.tapAction === 'channel') {
      handleChannelOpen(channel);
      return;
    }

    if (!postKey) return;

    await markItemSeen({ handle: channel.handle, channelId: channel.channelId, item: post, type: 'post' });

    try { await updateWidget('post-tap'); } catch {}

    Linking.openURL(post.link);
  };

  const getUnseenPosts = (handle) => {
    const latestVideo = getVideos(handle)[0] || null;
    return getPosts(handle).filter((post) => (
      isPostUnwatched(post)
      && chooseLatestChannelContent(latestVideo, post)?.type === 'post'
    ));
  };

  const isNew = (handle) => unseenCount(handle) > 0 || getUnseenPosts(handle).length > 0;

  const timeAgo = (dateStr) => {
    return formatCompactAge(dateStr, nowMs);
  };

  // For likes/dislikes: just the compact number, no "views" suffix
  const formatCount = (n) => {
    return formatCompactCount(n);
  };

  const renderChannel = ({ item }) => {
    const cached = cache[item.handle];
    const hasNew = isNew(item.handle);
    const displayName = cached?.name || item.name || item.handle;
    const effectiveCount = getEffectiveVideoCount(item.handle);
    const allVideos = getVideos(item.handle);
    const persistent = selectPersistentLatestContent(item.handle);

    // Show the N latest videos, newest-first. Seen/unseen state does
    // not affect ordering — blue dots are applied independently per video.
    const videosToShow = allVideos.slice(0, effectiveCount);
    // Fallback: if no videos in cache, use persistent latest (preserves old behaviour)
    if (videosToShow.length === 0 && persistent?.type === 'video') {
      videosToShow = [persistent.item];
    }
    const posts = getVisiblePosts(item.handle);

    return (
      <View style={[styles.channelSection, hasNew && styles.channelSectionNew]}>
        <View style={styles.channelHeaderRow}>
          <TouchableOpacity
            onPress={() => handleChannelOpen(item)}
            style={[styles.avatarContainer, hasNew && styles.avatarGlow]}
            activeOpacity={0.7}
          >
            {cached?.avatar ? (
              <Image source={{ uri: cached.avatar }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarPlaceholder]}>
                <Text style={styles.avatarLetter}>
                  {displayName.charAt(0).toUpperCase()}
                </Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.channelNameBtn} onPress={() => handleChannelOpen(item)} activeOpacity={0.7}>
            <Text style={[styles.channelName, hasNew && styles.channelNameNew]} numberOfLines={1}>
              {displayName}
            </Text>
          </TouchableOpacity>
        </View>

        {posts.length > 0 && (
          <View style={styles.postsGroupHeader}>
            <Text style={styles.postsGroupHeaderText}>Posts</Text>
          </View>
        )}

        {posts.map((post) => {
          // Server-driven: post.unwatched reflects the device's
          // per-channel state. No local seenIds lookup.
          const isSeen = !post.unwatched;
          const likeLabel = post.likeCount != null ? formatCount(post.likeCount) : null;
          const viewLabel = post.viewCount != null ? formatViews(post.viewCount) : (post.viewText || null);
          return (
            <TouchableOpacity
              key={post.activityId}
              style={styles.postRow}
              onPress={() => handlePostTap(item, post)}
              activeOpacity={0.7}
            >
              {post.thumbnail ? (
                <Image source={{ uri: post.thumbnail }} style={styles.postThumbnail} resizeMode="contain" />
              ) : (
                <View style={styles.postPlaceholder}>
                  {cached?.avatar ? (
                    <Image source={{ uri: cached.avatar }} style={styles.postPlaceholderAvatar} />
                  ) : (
                    <View style={[styles.postPlaceholderAvatar, styles.avatarPlaceholder]}>
                      <Text style={styles.postPlaceholderLetter}>
                        {displayName.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                  )}
                  {/* Speech-bubble tail (decorative) */}
                  <View style={styles.postPlaceholderTail} />
                </View>
              )}

              <View style={styles.postInfo}>
                <Text style={styles.postHeader} numberOfLines={1}>
                  {post.kind === 'poll' ? 'Posted a poll' : post.kind === 'image' ? 'Posted an image' : 'Posted'}
                </Text>
                <Text
                  style={[styles.postBody, !isSeen && { color: COLORS.text, fontWeight: '600' }]}
                  numberOfLines={1}
                >
                  {post.text}
                </Text>
                <View style={styles.videoMeta}>
                  <View style={styles.metaLeft}>
                    <Text style={styles.timeAgo}>{post.publishedAt ? timeAgo(post.publishedAt) : (post.publishedText || '')}</Text>
                    {likeLabel && (
                      <View style={styles.metaLikeGroup}>
                        <SvgXml xml={THUMB_UP_SVG} width={12} height={12} style={styles.metaIcon} />
                        <Text style={styles.metaLikeCount}>{likeLabel}</Text>
                      </View>
                    )}
                  </View>
                  {viewLabel && (
                    <Text style={styles.timeAgo}>{viewLabel}</Text>
                  )}
                </View>
              </View>
              {!isSeen && <View style={styles.newDot} />}
            </TouchableOpacity>
          );
        })}

        {videosToShow.map((video) => {
          const isSeen = !getUnseenVideos(item.handle).find(v => v.videoId === video.videoId);
          const hasLikeCount = hasKnownMetric(video.likes);
          const hasDislikeCount = hasKnownMetric(video.dislikes);
          return (
            <TouchableOpacity
              key={video.videoId}
              style={styles.videoRow}
              onPress={() => handleVideoTap(item, video)}
              activeOpacity={0.7}
            >
              {video.thumbnail ? (
                <Image source={{ uri: video.thumbnail }} style={styles.thumbnail} />
              ) : (
                <View style={[styles.thumbnail, styles.thumbnailPlaceholder]} />
              )}

              <View style={styles.videoInfo}>
                <Text style={[styles.videoTitle, !isSeen && { color: COLORS.text, fontWeight: 'bold' }]} numberOfLines={2}>
                  {video.title}
                </Text>
                {(video.published || video.views || video.likes || video.dislikes) && (
                  <View style={styles.videoMeta}>
                    <View style={styles.metaLeft}>
                      {video.published ? <Text style={styles.timeAgo}>{timeAgo(video.published)}</Text> : null}
                      {hasLikeCount && (
                        <View style={styles.metaLikeGroup}>
                          <SvgXml xml={THUMB_UP_SVG} width={12} height={12} style={styles.metaIcon} />
                          <Text style={styles.metaLikeCount}>{formatCount(video.likes)}</Text>
                        </View>
                      )}
                      {hasDislikeCount && String(video.dislikes) !== '0' && (
                        <View style={styles.metaLikeGroup}>
                          <SvgXml xml={THUMB_DOWN_SVG} width={12} height={12} style={styles.metaIcon} />
                          <Text style={styles.metaLikeCount}>{formatCount(video.dislikes)}</Text>
                        </View>
                      )}
                    </View>
                    {video.views && video.views !== '0' && (
                      <Text style={styles.timeAgo}>{formatViews(video.views)}</Text>
                    )}
                  </View>
                )}
              </View>
              {!isSeen && <View style={styles.newDot} />}
            </TouchableOpacity>
          );
        })}
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={COLORS.accent} size="large" />
      </View>
    );
  }

  const previewConnectionPhase = getPreviewHomeConnectionPhase({
    initializationPending: previewInitializationPending,
    connectionError: previewConnectionError,
  });

  return (
    <View style={styles.container}>
      <FlatList
        data={channels}
        keyExtractor={(item) => item.handle}
        renderItem={renderChannel}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={COLORS.accent}
            colors={[COLORS.accent]}
          />
        }
        ListHeaderComponent={seenPersistenceError ? (
          <View style={styles.previewError}>
            <Text style={styles.previewErrorTitle}>Seen status wasn’t saved</Text>
            <Text style={styles.previewErrorText}>{seenPersistenceError}</Text>
          </View>
        ) : IS_TUBEPULSE_PREVIEW && previewConnectionPhase === 'connecting' ? (
          <View style={styles.previewConnecting}>
            <ActivityIndicator color={COLORS.accent} size="small" />
            <Text style={styles.previewConnectingText}>Connecting to Preview server…</Text>
          </View>
        ) : IS_TUBEPULSE_PREVIEW && previewConnectionPhase === 'error' ? (
          <View style={styles.previewError}>
            <Text style={styles.previewErrorTitle}>Preview server unavailable</Text>
            <Text style={styles.previewErrorText}>{previewConnectionError}</Text>
            <View style={styles.previewErrorActions}>
              <TouchableOpacity onPress={refresh} disabled={refreshing}>
                <Text style={styles.previewErrorLink}>{refreshing ? 'Retrying…' : 'Retry'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => navigation.navigate('Settings')}>
                <Text style={styles.previewErrorLink}>Server settings</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No channels added</Text>
            <TouchableOpacity onPress={() => navigation.navigate('Channels')}>
              <Text style={styles.emptyLink}>Add channels</Text>
            </TouchableOpacity>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
    justifyContent: 'center',
  },
  channelSection: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    paddingBottom: 8,
  },
  previewError: {
    backgroundColor: 'rgba(239, 83, 80, 0.12)',
    borderBottomColor: COLORS.danger,
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  previewErrorTitle: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  previewErrorText: { color: COLORS.textDim, fontSize: 12, marginTop: 3 },
  previewErrorActions: { flexDirection: 'row', gap: 20, marginTop: 8 },
  previewErrorLink: { color: COLORS.accent, fontSize: 13, fontWeight: '600' },
  previewConnecting: {
    alignItems: 'center',
    borderBottomColor: COLORS.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  previewConnectingText: { color: COLORS.textDim, fontSize: 13 },
  channelSectionNew: {
    backgroundColor: 'rgba(79, 195, 247, 0.04)',
  },
  channelHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  channelNameBtn: {
    flex: 1,
  },
  videoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 5,
  },
  videoInfo: {
    flex: 1,
    marginLeft: 8,
  },
  avatarContainer: {
    marginRight: 12,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  avatarGlow: {
    borderColor: COLORS.accent,
    shadowColor: COLORS.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 6,
    elevation: 4,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  avatarPlaceholder: {
    backgroundColor: COLORS.surface,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarLetter: {
    color: COLORS.textDim,
    fontSize: 32,
    fontWeight: '700',
  },
  channelName: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '600',
    flex: 1,
    lineHeight: 40,
    marginTop: 5,
  },
  channelNameNew: {
    color: '#FFFFFF',
  },
  videoMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 2,
  },
  metaLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  timeAgo: {
    color: COLORS.textDim,
    fontSize: 12,
  },
  metaIcon: {
    marginRight: 0,
  },
  // Visual group around the thumb + count so we can give the count
  // breathing room from the icon without relying on the icon's
  // own right-margin (which gets eaten by the parent gap).
  metaLikeGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaLikeCount: {
    color: COLORS.textDim,
    fontSize: 12,
    marginLeft: 2,
  },
  videoTitle: {
    color: COLORS.textDim,
    fontSize: 13,
    marginTop: 2,
  },
  thumbnail: {
    width: 85,
    height: 48,
    borderRadius: 4,
  },
  thumbnailPlaceholder: {
    backgroundColor: '#1A1A1A',
  },
  newDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.newDot,
    marginLeft: 8,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 100,
  },
  emptyText: {
    color: COLORS.textDim,
    fontSize: 16,
  },
  emptyLink: {
    color: COLORS.accent,
    fontSize: 14,
    marginTop: 8,
  },
  // Posts
  postsGroupHeader: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 2,
  },
  postsGroupHeaderText: {
    color: COLORS.textDim,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  postRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 5,
  },
  postThumbnail: {
    width: 85,
    height: 48,
    borderRadius: 4,
    backgroundColor: '#111',
  },
  postPlaceholder: {
    width: 85,
    height: 48,
    borderRadius: 4,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  postPlaceholderAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    opacity: 0.6,
  },
  postPlaceholderLetter: {
    color: COLORS.textDim,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 24,
  },
  // Small triangular "tail" in the bottom-left corner of the bubble,
  // giving it the speech-bubble silhouette. Decorative only.
  postPlaceholderTail: {
    position: 'absolute',
    bottom: -1,
    left: 6,
    width: 8,
    height: 8,
    backgroundColor: COLORS.surface,
    borderLeftWidth: 1,
    borderBottomWidth: 1,
    borderColor: COLORS.border,
    transform: [{ rotate: '45deg' }],
  },
  postInfo: {
    flex: 1,
    marginLeft: 8,
  },
  postHeader: {
    color: COLORS.textDim,
    fontSize: 12,
    fontWeight: '500',
  },
  postBody: {
    color: COLORS.textDim,
    fontSize: 13,
    marginTop: 2,
    lineHeight: 17,
  },
});
