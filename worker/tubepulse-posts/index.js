// tubepulse-posts — community post shard worker (1 channel per invocation)
// Scheduled every minute. Rotates through eligible channels so each
// gets polled roughly every 60 minutes.

import {
  isCommunityPostsEnabled,
  parseCommunityPostChannelAllowlist,
  fetchLatestCommunityPostInnerTube,
} from './community-posts.mjs';

import {
  key, getKV, putKV, putKVIfChanged, selectCommunityPostWork,
  isDndActive, getCachedFcmAccessToken, sendFCMPush, cleanupDeadDevice,
  addToNagActive, removeFromNagActive,
  getCommunityPostSeenId, getCachedCommunityPostIds,
  preserveCachedCommunityPostPublishedAt, shouldRefreshCachedCommunityPost,
  formatCommunityPostNotificationTitle,
  normalizeKnownCommunityPostIds, addKnownCommunityPostId,
  removeCachedPostIdsFromSubscriberState,
} from '../tubepulse-cron/shared.mjs';

const COMMUNITY_POSTS_DEBUG_CHANNEL_ID = 'UCeG5VyNPnGZq-8JzHJbSB6A';

function isCommunityPostsDebugEnabled(env) {
  const value = String(env.TUBEPULSE_DEBUG_COMMUNITY_POSTS || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export default {
  async scheduled(event, env, ctx) {
    if (!isCommunityPostsEnabled(env)) return;

    const allowlist = parseCommunityPostChannelAllowlist(env);
    const allowlistEnabled = allowlist.size > 0;
    const active = await getKV(env.TUBEPULSE_KV, key.channelsActive()) || [];
    const minuteSlot = Math.floor(Date.now() / 60000);
    const work = selectCommunityPostWork(
      active.filter((ch) => !allowlistEnabled || allowlist.has(ch)),
      minuteSlot,
    );
    if (!work) return;

    console.log(`[Posts] channel=${work.channelId} (${work.channelIndex + 1}/${work.channelCount}) step=${work.stepMinutes}m`);
    await pollSingleCommunityChannel(env, ctx, work.channelId, isCommunityPostsDebugEnabled(env));
  },
};

async function pollSingleCommunityChannel(env, ctx, channelId, debugEnabled) {
  const kv = env.TUBEPULSE_KV;
  const channelDebug = debugEnabled && channelId === COMMUNITY_POSTS_DEBUG_CHANNEL_ID;

  if (channelDebug) console.log(`[PostsDebug] polling ${channelId}`);

  // First-run guard
  const firstPollAt = await getKV(kv, key.firstPollAtPosts(channelId));

  let latestPost;
  try {
    latestPost = await fetchLatestCommunityPostInnerTube(channelId, { fetch });
  } catch (err) {
    console.error(`[Posts] InnerTube fetch error for ${channelId}:`, err?.message || err);
    return;
  }

  if (!firstPollAt) {
    const latestPostId = getCommunityPostSeenId(latestPost);
    await putKVIfChanged(kv, key.channelRecentPosts(channelId), latestPost ? [latestPost] : []);
    if (latestPostId) {
      await putKVIfChanged(kv, key.channelKnownPosts(channelId), [latestPostId]);
    }
    await putKV(kv, key.firstPollAtPosts(channelId), new Date().toISOString());
    console.log(`[Posts] first run for ${channelId}: seeded, no notifications`);
    return;
  }

  const prevRecent = await getKV(kv, key.channelRecentPosts(channelId)) || [];
  latestPost = preserveCachedCommunityPostPublishedAt(latestPost, prevRecent);
  const cachedPostIds = getCachedCommunityPostIds(prevRecent);
  const cachedActivityIds = new Set(prevRecent.map((p) => p.activityId || p.postId).filter(Boolean));
  const latestPostId = getCommunityPostSeenId(latestPost);

  let knownPostIds = normalizeKnownCommunityPostIds(await getKV(kv, key.channelKnownPosts(channelId)) || []);
  let knownChanged = false;
  for (const cachedPostId of cachedPostIds) {
    if (!knownPostIds.includes(cachedPostId)) {
      knownPostIds = addKnownCommunityPostId(knownPostIds, cachedPostId);
      knownChanged = true;
    }
  }
  if (knownChanged) {
    await putKVIfChanged(kv, key.channelKnownPosts(channelId), knownPostIds);
  }

  if (!latestPost) {
    if (prevRecent.length > 0) {
      await putKVIfChanged(kv, key.channelRecentPosts(channelId), [], prevRecent);
      const removed = await removeCachedPostIdsFromSubscriberState(env, channelId, cachedPostIds);
      console.log(`[Posts] ${channelId}: no latest post, cleared ${cachedPostIds.size} cached, removed=${removed}`);
    }
    return;
  }

  if (cachedActivityIds.has(latestPost.activityId)) {
    if (latestPostId && !knownPostIds.includes(latestPostId)) {
      knownPostIds = addKnownCommunityPostId(knownPostIds, latestPostId);
      await putKVIfChanged(kv, key.channelKnownPosts(channelId), knownPostIds);
    }
    if (shouldRefreshCachedCommunityPost(latestPost, prevRecent)) {
      await putKVIfChanged(kv, key.channelRecentPosts(channelId), [latestPost], prevRecent);
      const stalePostIds = new Set([...cachedPostIds].filter((id) => id !== latestPostId));
      const removed = await removeCachedPostIdsFromSubscriberState(env, channelId, stalePostIds);
      console.log(`[Posts] ${channelId}: unchanged ${latestPost.activityId}, compacted, removed=${removed}`);
    }
    return;
  }

  if (latestPostId && knownPostIds.includes(latestPostId)) {
    await putKVIfChanged(kv, key.channelRecentPosts(channelId), [latestPost], prevRecent);
    const removed = await removeCachedPostIdsFromSubscriberState(env, channelId, cachedPostIds);
    console.log(`[Posts] ${channelId}: known latest ${latestPost.activityId}, suppressed, removed=${removed}`);
    return;
  }

  // New post detected
  await putKVIfChanged(kv, key.channelRecentPosts(channelId), [latestPost], prevRecent);
  knownPostIds = addKnownCommunityPostId(knownPostIds, latestPostId);
  await putKVIfChanged(kv, key.channelKnownPosts(channelId), knownPostIds);
  const removed = await removeCachedPostIdsFromSubscriberState(env, channelId, cachedPostIds);
  console.log(`[Posts] ${channelId}: new post ${latestPost.activityId}, removed=${removed}`);

  // Notify subscribers
  const subs = await getKV(kv, key.channelSubs(channelId)) || [];
  const channelMeta = await getKV(kv, key.channelMeta(channelId)) || {};

  let accessToken;
  try {
    accessToken = await getCachedFcmAccessToken(env);
  } catch (err) {
    console.error('[Posts] FCM token error:', err?.message || err);
    return;
  }
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const projectId = sa.project_id;
  const deadDevices = [];

  for (const deviceId of subs) {
    const profile = await getKV(kv, key.deviceProfile(deviceId));
    if (!profile?.fcmToken) continue;

    const override = await getKV(kv, key.deviceOverride(deviceId, channelId));
    const overrideValue = override?.includeCommunityPosts;
    if (overrideValue === false) continue;
    if (overrideValue !== true) {
      const settings = await getKV(kv, key.deviceSettings(deviceId)) || {};
      if (!settings.includeCommunityPosts) continue;
    }

    const state = await getKV(kv, key.deviceState(deviceId, channelId)) || {
      unwatched: [], nagCount: 0,
    };
    const postKey = latestPost.id || `post:${latestPost.activityId}`;
    if (!state.unwatched.includes(postKey)) {
      state.unwatched.push(postKey);
      await putKV(kv, key.deviceState(deviceId, channelId), state);
      addToNagActive(env, deviceId, channelId);
    }

    const truncated = latestPost.text.length > 100
      ? latestPost.text.slice(0, 97) + '...'
      : latestPost.text;
    const postLabel = latestPost.kind === 'poll' ? 'posted a poll'
      : latestPost.kind === 'image' ? 'posted an image'
      : 'posted';

    const notifPayload = {
      notification: {
        title: formatCommunityPostNotificationTitle({ channelMeta, post: latestPost, profile, channelId, postLabel }),
        body: truncated || '(no text)',
      },
      data: {
        type: 'post',
        channelId,
        activityId: latestPost.activityId,
        postKind: latestPost.kind,
        notificationTag: `post-${latestPost.activityId}`,
      },
      tag: `post-${latestPost.activityId}`,
    };

    try {
      const sendResult = await sendFCMPush(accessToken, projectId, profile.fcmToken, notifPayload);
      if (sendResult.sent) {
        state.lastNagAt = Date.now();
        await putKV(kv, key.deviceState(deviceId, channelId), state);
      }
      if (sendResult.deadToken) {
        deadDevices.push(deviceId);
      }
    } catch (err) {
      console.error(`[Posts] FCM push failed for ${deviceId}:`, err?.message || err);
    }
  }

  for (const deviceId of [...new Set(deadDevices)]) {
    console.log(`[Posts] Pruning dead device: ${deviceId}`);
    ctx.waitUntil(cleanupDeadDevice(deviceId, env, 'fcm_unregistered'));
  }
}
