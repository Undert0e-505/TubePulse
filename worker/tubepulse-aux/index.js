// tubepulse-aux — nag + prewarn combined worker
// Scheduled every minute. Does ONE bounded job per tick:
//   1. Nag: process up to NAG_BATCH_SIZE entries from nag:active
//   2. Prewarn: if nag didn't run (or ran with budget to spare), check prewarn
//
// Priority: nag first, prewarn second. If the rollback worker directly fires
// any nags, prewarn waits until the next tick. Host-deferred nags do not count
// as fired until the post-publication coordinator actually sends them, so they
// cannot starve prewarn work.
//
// Both jobs are bounded and never scan all channels/subscribers/devices.

import {
  key, getKV, putKV, isDndActive, getNagIntervalMs,
  getCachedFcmAccessToken, sendFCMPush, cleanupDeadDevice,
  removeFromNagActive,
  withKvMutationLock,
  effectiveNotificationSettings, videoNotificationTag,
} from '../tubepulse-cron/shared.mjs';

const NAG_BATCH_SIZE = 5;
const TICK_MS = 5 * 60 * 1000;
const SCHEDULER_MINUTE_MS = 60 * 1000;
const APP_VISIBLE_VIDEO_LIMIT = 3;

// ─── Prewarn constants ──────────────────────────────────────────────────

const DEFAULT_PREWARN_MINUTES = 60;
const PREWARN_OPTIONS_MINUTES = [15, 30, 60, 120, 240, 1440];
const PREWARN_SLACK_MS = 5 * 60 * 1000;
const PREWARN_GRACE_MS = 24 * 60 * 60 * 1000;

function prewarnLabel(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes === 60) return '1 hour';
  if (minutes < 1440) return `${minutes / 60} hours`;
  return '1 day';
}

function currentUpcomingBucket() {
  const d = new Date();
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  return d.toISOString().slice(0, 16);
}

// ─── Main handler ───────────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    if (String(env.TUBEPULSE_ENABLE_FROZEN_KV_ROLLBACK || '').toLowerCase() !== 'true') {
      console.log('[Aux] Frozen KV rollback is not explicitly enabled; no-op.');
      return;
    }
    await runAuxTick(env, ctx, Date.now());
  },
};

export async function runAuxTick(env, ctx, now = Date.now()) {

    // ── 1. Drain stale upcoming buckets (legacy, cheap) ──
    const bucket = currentUpcomingBucket();
    const staleEntries = await getKV(env.TUBEPULSE_KV, key.upcoming(bucket));
    if (staleEntries && staleEntries.length > 0) {
      console.log(`[Aux] Draining ${staleEntries.length} stale bucket entries at ${bucket}`);
      await env.TUBEPULSE_KV.delete(key.upcoming(bucket));
    }

    // ── 2. Nag: process bounded batch from nag:active ──
    const alignedOwner = env.TUBEPULSE_ALIGNED_VIDEO_NOTIFICATIONS_ENABLED === true
      || String(env.TUBEPULSE_ALIGNED_VIDEO_NOTIFICATIONS_ENABLED || '').toLowerCase() === 'true';
    const nagFired = alignedOwner ? 0 : await runNag(env, ctx, now);

    // ── 3. Prewarn: only if nag had nothing to fire ──
    // Prewarn is rarely urgent (events are hours away). If nag fired
    // any pushes, skip prewarn this tick to keep CPU low.
    if (nagFired === 0) {
      await runPrewarn(env, ctx, now);
    }
}

function communityPostsEnabled(env) {
  return ['1', 'true', 'yes'].includes(String(env.TUBEPULSE_ENABLE_COMMUNITY_POSTS || '').trim().toLowerCase());
}

function contentTimestampMs(item, fields) {
  for (const field of fields) {
    const value = item?.[field];
    if (!value) continue;
    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

function latestContentType(video, post) {
  if (!video && !post) return null;
  if (!video) return post ? 'post' : null;
  if (!post) return 'video';
  const videoTime = contentTimestampMs(video, ['published', 'publishedAt']);
  const postTime = contentTimestampMs(post, ['publishedAt']);
  if (videoTime != null && postTime != null) return postTime > videoTime ? 'post' : 'video';
  if (videoTime != null) return 'video';
  if (postTime != null) return 'post';
  return 'video';
}

function newestFirst(items, fields) {
  return [...items].sort((left, right) => (
    (contentTimestampMs(right, fields) ?? 0) - (contentTimestampMs(left, fields) ?? 0)
  ));
}

export function selectNagActiveBatch(nagActive, now, batchSize = NAG_BATCH_SIZE) {
  const entries = Array.isArray(nagActive) ? nagActive : [];
  if (entries.length <= batchSize) return [...entries];
  // Time-derived rotation survives restarts without mutating canonical
  // nag:active solely to remember scheduling progress. Advancing by one whole
  // bounded batch per minute gives every entry a turn.
  const minute = Math.floor(Number(now) / SCHEDULER_MINUTE_MS);
  const start = (minute * batchSize) % entries.length;
  return Array.from({ length: batchSize }, (_, offset) => entries[(start + offset) % entries.length]);
}

export function selectRemindableContent({ state, recent, recentPosts, includeCommunityPosts }) {
  const unwatched = new Set(Array.isArray(state?.unwatched) ? state.unwatched : []);
  const sortedVideos = newestFirst(Array.isArray(recent) ? recent : [], ['published', 'publishedAt']);
  const latestVideo = sortedVideos[0] || null;
  const videos = sortedVideos
    .slice(0, APP_VISIBLE_VIDEO_LIMIT)
    .filter((video) => video?.videoId && unwatched.has(video.videoId));
  const posts = includeCommunityPosts
    ? newestFirst(Array.isArray(recentPosts) ? recentPosts : [], ['publishedAt']).filter((post) => {
      const postId = post?.id || (post?.activityId ? `post:${post.activityId}` : null);
      return postId && unwatched.has(postId) && latestContentType(latestVideo, post) === 'post';
    })
    : [];
  return {
    videos,
    posts,
    contentIds: [
      ...videos.map((video) => video.videoId),
      ...posts.map((post) => post.id || `post:${post.activityId}`),
    ],
  };
}

// ─── Nag ────────────────────────────────────────────────────────────────

async function runNag(env, ctx, now) {
  const nagActive = await getKV(env.TUBEPULSE_KV, key.nagActive()) || [];
  if (nagActive.length === 0) return 0;

  // Process a restart-safe rotating batch without rewriting canonical state.
  const batch = selectNagActiveBatch(nagActive, now);
  let fired = 0;
  let checked = 0;
  const deadTokens = [];

  let accessToken = null;
  let projectId = null;

  for (const entry of batch) {
    const parts = entry.split('|');
    if (parts.length !== 2) continue;
    const [deviceId, channelId] = parts;

    // A new-content push queued earlier in this same Home tick must be
    // delivered (or suppressed by its visibility barrier) before a reminder
    // for the same device/channel can be considered.
    if (env.TUBEPULSE_DEFERRED_NOTIFICATION_PENDING?.(deviceId, channelId)) continue;

    const state = await getKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId));
    if (!state?.unwatched || state.unwatched.length === 0) {
      // Nothing unwatched — remove from index
      await removeFromNagActive(env, deviceId, channelId);
      continue;
    }

    checked++;

    const [profile, settings, override] = await Promise.all([
      getKV(env.TUBEPULSE_KV, key.deviceProfile(deviceId)),
      getKV(env.TUBEPULSE_KV, key.deviceSettings(deviceId)),
      getKV(env.TUBEPULSE_KV, key.deviceOverride(deviceId, channelId)),
    ]);

    if (!profile?.fcmToken) continue;

    const effective = effectiveNotificationSettings(settings, override);

    if (effective.muted) continue;

    const dndActive = effective.dndEnabled && isDndActive(effective.dndStart, effective.dndEnd, effective.dndTimezone);
    if (dndActive && !effective.dndBypass) continue;

    // Tick-aligned interval check
    const intervalMs = getNagIntervalMs(effective, state);
    const lastNagAt = state.lastNagAt || 0;
    const lastNagTick = lastNagAt > 0 ? Math.floor(lastNagAt / TICK_MS) * TICK_MS : 0;
    if (lastNagTick > 0 && (now - lastNagTick) < intervalMs) continue;

    // Build the reminder from what the app can currently represent. Keep the
    // complete state.unwatched array: an older fourth video can become visible
    // again if a newer item is deleted.
    const [meta, recent, recentPosts] = await Promise.all([
      getKV(env.TUBEPULSE_KV, key.channelMeta(channelId)),
      getKV(env.TUBEPULSE_KV, key.channelRecent(channelId)),
      getKV(env.TUBEPULSE_KV, key.channelRecentPosts(channelId)),
    ]);
    const channelName = meta?.name || channelId;
    const remindable = selectRemindableContent({
      state,
      recent,
      recentPosts,
      includeCommunityPosts: communityPostsEnabled(env) && effective.includeCommunityPosts,
    });
    const selectedContentIds = remindable.contentIds;
    if (selectedContentIds.length === 0) continue;
    const postIds = remindable.posts.map((post) => post.id || `post:${post.activityId}`);
    const videoIds = remindable.videos.map((video) => video.videoId);
    const hasPosts = postIds.length > 0;
    const hasVideos = videoIds.length > 0;

    let notifPayload;
    if (selectedContentIds.length === 1) {
      const itemId = selectedContentIds[0];
      if (itemId.startsWith('post:')) {
        const activityId = itemId.slice(5);
        const post = remindable.posts.find((p) => p.activityId === activityId);
        const postLabel = post?.kind === 'poll' ? 'poll'
          : post?.kind === 'image' ? 'image post'
          : 'community post';
        notifPayload = {
          title: `${channelName} - reminder`,
          body: post?.text?.slice(0, 100) || `Unread ${postLabel}`,
          data: {
            type: 'nag', channelId, channelName, activityId,
            postKind: post?.kind || '',
            postLink: `https://www.youtube.com/channel/${channelId}/community`,
            notificationTag: `post-${activityId}`,
          },
          tag: `post-${activityId}`,
        };
      } else {
        const video = remindable.videos.find((v) => v.videoId === itemId);
        notifPayload = {
          title: `${channelName} - reminder`,
          body: video?.title || 'Unwatched video',
          data: {
            videoId: itemId, channelId, channelName,
            videoLink: video?.link || `https://www.youtube.com/watch?v=${itemId}`,
            type: 'nag', notificationTag: videoNotificationTag(channelId),
            tapAction: String(effective.tapAction),
          },
          tag: videoNotificationTag(channelId),
        };
      }
    } else {
      let body;
      if (hasPosts && hasVideos) {
        body = `You have ${videoIds.length} unwatched video${videoIds.length > 1 ? 's' : ''} and ${postIds.length} unread community post${postIds.length > 1 ? 's' : ''}`;
      } else if (hasPosts) {
        body = `You have ${postIds.length} unread community post${postIds.length > 1 ? 's' : ''}`;
      } else {
        body = 'You have videos waiting';
      }
      notifPayload = {
        title: `${channelName} - ${selectedContentIds.length} unread`,
        body,
        data: {
          type: 'batch', count: String(selectedContentIds.length), channelId, channelName,
          contentIds: JSON.stringify(selectedContentIds),
          tapAction: String(effective.tapAction),
        },
        tag: videoNotificationTag(channelId),
      };
    }

    // Get the FCM access token only after finding current remindable content.
    if (!accessToken) {
      try {
        accessToken = await getCachedFcmAccessToken(env);
        const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
        projectId = sa.project_id;
      } catch (err) {
        console.error('[Nag] FCM token error:', err?.message || err);
        break;
      }
    }

    try {
      const result = await sendFCMPush(
        accessToken, projectId, profile.fcmToken, notifPayload, profile.notificationCapability,
      );
      if (result.shadow) {
        const deferred = env.TUBEPULSE_NOTIFICATION_DEFERRED === true;
        await env.TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER?.({
          kind: 'nag',
          channelId,
          ...(deferred ? {
            deviceId,
            projectId,
            fcmToken: profile.fcmToken,
            notificationCapability: profile.notificationCapability || null,
            payload: notifPayload,
            contentIds: [...selectedContentIds],
            dedupeVersion: `${state.lastNagAt || 0}:${state.nagCount || 0}`,
            requireUnwatched: true,
            onResult: async (delivery) => {
              if (delivery?.sent) {
                await withKvMutationLock(env, key.deviceState(deviceId, channelId), async () => {
                  const current = await getKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId)) || state;
                  await putKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId), {
                    ...current,
                    lastNagAt: now,
                    nagCount: (current.nagCount || 0) + 1,
                  });
                });
              } else if (delivery?.deadToken) {
                await cleanupDeadDevice(deviceId, env, 'fcm_unregistered');
              }
            },
          } : {}),
        });
      }
      if (result.sent) {
        fired++;
        state.lastNagAt = now;
        state.nagCount = (state.nagCount || 0) + 1;
        await putKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId), state);
      } else if (result.deadToken) {
        deadTokens.push(deviceId);
      }
    } catch (err) {
      console.error(`[Nag] FCM push failed for ${deviceId}:`, err?.message || err);
    }
  }

  for (const deviceId of [...new Set(deadTokens)]) {
    console.log(`[Nag] Pruning dead device: ${deviceId}`);
    ctx.waitUntil(cleanupDeadDevice(deviceId, env, 'fcm_unregistered'));
  }

  if (fired > 0 || checked > 0) {
    console.log(`[Aux/Nag] batch=${batch.length}/${nagActive.length} checked=${checked} fired=${fired}`);
  }
  return fired;
}

// ─── Prewarn ────────────────────────────────────────────────────────────

async function runPrewarn(env, ctx, now) {
  const events = await getKV(env.TUBEPULSE_KV, key.upcomingEvents()) || [];
  if (events.length === 0) return;

  const stillValid = [];
  let fired = 0;
  let pruned = 0;

  let accessToken = null;
  let projectId = null;

  for (const ev of events) {
    const scheduledFor = new Date(ev.scheduledFor).getTime();
    if (isNaN(scheduledFor)) { pruned++; continue; }

    // Past grace window — prune
    if (now > scheduledFor + PREWARN_GRACE_MS) {
      pruned++;
      const subs = await getKV(env.TUBEPULSE_KV, key.channelSubs(ev.channelId)) || [];
      for (const deviceId of subs) {
        await env.TUBEPULSE_KV.delete(key.prewarnSent(ev.videoId, deviceId));
      }
      continue;
    }

    stillValid.push(ev);

    // Past scheduled time + slack — no prewarn needed
    if (now > scheduledFor + PREWARN_SLACK_MS) continue;

    const meta = await getKV(env.TUBEPULSE_KV, key.channelMeta(ev.channelId));
    const channelName = meta?.name || ev.channelId;
    const subs = await getKV(env.TUBEPULSE_KV, key.channelSubs(ev.channelId)) || [];

    for (const deviceId of subs) {
      const sent = await getKV(env.TUBEPULSE_KV, key.prewarnSent(ev.videoId, deviceId));
      if (sent !== null) continue;

      const [profile, settings, override] = await Promise.all([
        getKV(env.TUBEPULSE_KV, key.deviceProfile(deviceId)),
        getKV(env.TUBEPULSE_KV, key.deviceSettings(deviceId)),
        getKV(env.TUBEPULSE_KV, key.deviceOverride(deviceId, ev.channelId)),
      ]);
      if (!profile?.fcmToken) continue;

      const prewarnMinutes = override?.prewarnMinutes
        ?? settings?.prewarnMinutes
        ?? DEFAULT_PREWARN_MINUTES;
      const effectiveMinutes = PREWARN_OPTIONS_MINUTES.includes(prewarnMinutes)
        ? prewarnMinutes
        : DEFAULT_PREWARN_MINUTES;

      const prewarnTime = scheduledFor - effectiveMinutes * 60 * 1000;
      if (prewarnTime > now) continue;

      const remainingMs = Math.max(0, scheduledFor - now);
      if (remainingMs < 30000) {
        await putKV(env.TUBEPULSE_KV, key.prewarnSent(ev.videoId, deviceId), effectiveMinutes);
        continue;
      }

      if (override?.muted) {
        await putKV(env.TUBEPULSE_KV, key.prewarnSent(ev.videoId, deviceId), effectiveMinutes);
        continue;
      }

      const dndEnabled = settings?.dndEnabled || false;
      const dndStart = settings?.dndStart || '22:00';
      const dndEnd = settings?.dndEnd || '07:00';
      const dndTimezone = settings?.dndTimezone || 'UTC';
      const dndActive = dndEnabled && isDndActive(dndStart, dndEnd, dndTimezone);
      if (dndActive && !override?.dndBypass) {
        if (now > scheduledFor - PREWARN_SLACK_MS) {
          await putKV(env.TUBEPULSE_KV, key.prewarnSent(ev.videoId, deviceId), effectiveMinutes);
        }
        continue;
      }

      // Lazy FCM token
      if (!accessToken) {
        try {
          accessToken = await getCachedFcmAccessToken(env);
          const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
          projectId = sa.project_id;
        } catch (err) {
          console.error('[Prewarn] FCM token error:', err?.message || err);
          break;
        }
      }

      const remainingMinutes = Math.round(remainingMs / 60000);
      const notifPayload = {
        notification: {
          title: `${channelName} going live soon`,
          body: `Scheduled event starting in ${prewarnLabel(remainingMinutes)}`,
        },
        data: {
          type: 'prewarn', videoId: ev.videoId, channelId: ev.channelId,
          channelName, scheduledFor: String(scheduledFor),
          prewarnMinutes: String(effectiveMinutes),
        },
        tag: `video-${ev.videoId}`,
      };

      try {
        const result = await sendFCMPush(
          accessToken, projectId, profile.fcmToken, notifPayload, profile.notificationCapability,
        );
        if (result.shadow) {
          const deferred = env.TUBEPULSE_NOTIFICATION_DEFERRED === true;
          await env.TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER?.({
            kind: 'prewarn',
            channelId: ev.channelId,
            ...(deferred ? {
              deviceId,
              projectId,
              fcmToken: profile.fcmToken,
              notificationCapability: profile.notificationCapability || null,
              payload: notifPayload,
              contentIds: [ev.videoId],
              dedupeVersion: `prewarn:${effectiveMinutes}`,
              requireUnwatched: false,
              onResult: async (delivery) => {
                if (delivery?.sent) {
                  await putKV(env.TUBEPULSE_KV, key.prewarnSent(ev.videoId, deviceId), effectiveMinutes);
                } else if (delivery?.deadToken) {
                  await cleanupDeadDevice(deviceId, env, 'fcm_unregistered');
                  await putKV(env.TUBEPULSE_KV, key.prewarnSent(ev.videoId, deviceId), effectiveMinutes);
                }
              },
            } : {}),
          });
          if (deferred) fired++;
        }
        if (result.sent) {
          fired++;
          await putKV(env.TUBEPULSE_KV, key.prewarnSent(ev.videoId, deviceId), effectiveMinutes);
        } else if (result.deadToken) {
          console.log(`[Prewarn] Pruning dead device: ${deviceId}`);
          ctx.waitUntil(cleanupDeadDevice(deviceId, env, 'fcm_unregistered'));
          await putKV(env.TUBEPULSE_KV, key.prewarnSent(ev.videoId, deviceId), effectiveMinutes);
        }
      } catch (err) {
        console.error(`[Prewarn] FCM push failed for ${deviceId}:`, err?.message || err);
      }
    }
  }

  if (stillValid.length !== events.length) {
    await putKV(env.TUBEPULSE_KV, key.upcomingEvents(), stillValid);
  }

  if (fired > 0 || pruned > 0) {
    console.log(`[Aux/Prewarn] events=${events.length} fired=${fired} pruned=${pruned}`);
  }
}
