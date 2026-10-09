import {
  cleanupDeadDevice,
  effectiveNotificationSettings,
  getAlignedNagIntervalMs,
  getCachedFcmAccessToken,
  getKV,
  isDndActive,
  key,
  putKV,
  sendFCMPush,
  videoNotificationTag,
  withKvMutationLock,
} from '../tubepulse-cron/shared.mjs';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const APP_VISIBLE_VIDEO_LIMIT = 3;

function timestamp(item) {
  const value = Date.parse(item?.publishedAt || item?.published || '');
  return Number.isFinite(value) ? value : 0;
}

export function selectAlignedVisibleVideos(state, recent) {
  const unwatched = new Set(Array.isArray(state?.unwatched) ? state.unwatched : []);
  return [...(Array.isArray(recent) ? recent : [])]
    .filter((video) => video?.videoId && video.type !== 'live_scheduled')
    .sort((left, right) => timestamp(right) - timestamp(left))
    .slice(0, APP_VISIBLE_VIDEO_LIMIT)
    .filter((video) => unwatched.has(video.videoId));
}

export function alignedNotificationDecision({
  scheduledTime,
  activationAt,
  state,
  videos,
  effective,
  newlyDetected = false,
}) {
  const raster = Math.floor(Number(scheduledTime) / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  if (!Number.isFinite(raster) || videos.length === 0) return { notify: false, reason: 'no-visible-unseen' };
  const lastNagAt = Number(state?.lastNagAt || 0);
  const anchor = lastNagAt > 0
    ? Math.floor(lastNagAt / FIVE_MINUTES_MS) * FIVE_MINUTES_MS
    : Number(activationAt || raster);
  const hasNewerVisible = videos.some((video) => timestamp(video) > anchor);
  const immediate = Boolean(newlyDetected || hasNewerVisible);
  const intervalMs = getAlignedNagIntervalMs(effective);
  const due = raster - anchor >= intervalMs;
  return {
    notify: immediate || due,
    reason: immediate ? 'new-content' : due ? 'interval-due' : 'not-due',
    // Only content observed in this detector transaction is a durable
    // at-most-once upload intent. State-derived recovery (DND release,
    // restart, or an earlier failed attempt) is recalculated as a transient
    // reminder so a resolved durable record cannot suppress it forever.
    kind: newlyDetected ? 'video' : 'nag',
    raster,
    anchor,
    intervalMs,
  };
}

export function buildAlignedVideoPayload({ channelId, channelName, videos, effective, kind }) {
  const tag = videoNotificationTag(channelId);
  const ids = videos.map((video) => video.videoId);
  if (videos.length === 1) {
    const video = videos[0];
    return {
      title: kind === 'video' ? `${channelName} uploaded` : `${channelName} - reminder`,
      body: video.title || 'Unwatched video',
      data: {
        videoId: video.videoId,
        channelId,
        channelName,
        videoLink: video.link || `https://www.youtube.com/watch?v=${video.videoId}`,
        type: kind === 'video' ? (video.type || 'video') : 'nag',
        tapAction: String(effective.tapAction),
        notificationTag: tag,
      },
      tag,
    };
  }
  return {
    title: `${channelName} - ${videos.length} unread`,
    body: 'You have videos waiting',
    data: {
      type: 'batch',
      count: String(videos.length),
      channelId,
      channelName,
      contentIds: JSON.stringify(ids),
      tapAction: String(effective.tapAction),
      notificationTag: tag,
    },
    tag,
  };
}

export async function runAlignedVideoNotifications(env, ctx, scheduledTime, {
  activationAt = scheduledTime,
  newlyDetectedPairs = new Set(),
} = {}) {
  const kv = env.TUBEPULSE_KV;
  const entries = await getKV(kv, key.nagActive()) || [];
  let checked = 0;
  let queued = 0;
  let accessToken = null;
  let projectId = null;

  for (const entry of [...new Set(entries)].sort()) {
    const separator = entry.indexOf('|');
    if (separator <= 0) continue;
    const deviceId = entry.slice(0, separator);
    const channelId = entry.slice(separator + 1);
    const state = await getKV(kv, key.deviceState(deviceId, channelId));
    if (!Array.isArray(state?.unwatched) || state.unwatched.length === 0) continue;
    checked++;

    const [profile, settings, override, meta, recent] = await Promise.all([
      getKV(kv, key.deviceProfile(deviceId)),
      getKV(kv, key.deviceSettings(deviceId)),
      getKV(kv, key.deviceOverride(deviceId, channelId)),
      getKV(kv, key.channelMeta(channelId)),
      getKV(kv, key.channelRecent(channelId)),
    ]);
    if (!profile?.fcmToken) continue;
    const effective = effectiveNotificationSettings(settings, override);
    if (effective.muted) continue;
    const videos = selectAlignedVisibleVideos(state, recent);
    const newlyDetected = newlyDetectedPairs.has(`${deviceId}|${channelId}`);
    const newVisibleLivestream = newlyDetected && videos.some((video) => video.type === 'live');
    if (effective.dndEnabled
      && isDndActive(effective.dndStart, effective.dndEnd, effective.dndTimezone, scheduledTime)
      && !effective.dndBypass
      && !newVisibleLivestream) continue;

    const decision = alignedNotificationDecision({
      scheduledTime,
      activationAt,
      state,
      videos,
      effective,
      newlyDetected,
    });
    if (!decision.notify) continue;

    if (!accessToken) {
      accessToken = await getCachedFcmAccessToken(env);
      projectId = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT).project_id;
    }
    const channelName = meta?.name || channelId;
    const payload = buildAlignedVideoPayload({ channelId, channelName, videos, effective, kind: decision.kind });
    const contentIds = videos.map((video) => video.videoId);
    const delivery = await sendFCMPush(
      accessToken, projectId, profile.fcmToken, payload, profile.notificationCapability,
    );
    if (delivery.shadow) {
      const deferred = env.TUBEPULSE_NOTIFICATION_DEFERRED === true;
      await env.TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER?.({
        kind: decision.kind,
        channelId,
        ...(deferred ? {
          deviceId,
          projectId,
          fcmToken: profile.fcmToken,
          notificationCapability: profile.notificationCapability || null,
          payload,
          contentIds,
          dedupeVersion: decision.kind === 'nag' ? `${decision.raster}:${state.lastNagAt || 0}` : undefined,
          watermarkAt: decision.raster,
          requireUnwatched: true,
          onResult: async (result) => {
            if (result?.sent) {
              await withKvMutationLock(env, key.deviceState(deviceId, channelId), async () => {
                const current = await getKV(kv, key.deviceState(deviceId, channelId)) || state;
                await putKV(kv, key.deviceState(deviceId, channelId), {
                  ...current,
                  lastNagAt: decision.raster,
                  ...(decision.kind === 'nag'
                    ? { nagCount: Number(current.nagCount || 0) + 1 }
                    : {}),
                });
              });
            } else if (result?.deadToken) {
              await cleanupDeadDevice(deviceId, env, 'fcm_unregistered');
            }
          },
        } : {}),
      });
      queued++;
    } else if (delivery.sent) {
      state.lastNagAt = decision.raster;
      if (decision.kind === 'nag') state.nagCount = Number(state.nagCount || 0) + 1;
      await putKV(kv, key.deviceState(deviceId, channelId), state);
      queued++;
    } else if (delivery.deadToken) {
      ctx.waitUntil(cleanupDeadDevice(deviceId, env, 'fcm_unregistered'));
    }
  }

  return { outcome: 'ok', checked, queued };
}
