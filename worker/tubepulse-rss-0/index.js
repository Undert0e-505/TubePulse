// tubepulse-rss — RSS shard worker (1 channel per invocation)
// Scheduled every five minutes. Each shard processes one channel from its slice.

import {
  key, getKV, putKV, putKVIfChanged, selectRssShardWork,
  fetchChannelRSS, isDndActive,
  getCachedFcmAccessToken, sendFCMPush, cleanupDeadDevice,
  addToNagActive,
  withKvMutationLock,
  seedKnownVideosFromRss, classifyRssVideosForNotification,
  updateKnownVideosAfterPoll, mergeRssUploadsIntoRecentVideos,
} from '../tubepulse-cron/shared.mjs';

const RSS_MAX_SHARDS = 3;

export default {
  async scheduled(event, env, ctx) {
    if (String(env.TUBEPULSE_ENABLE_FROZEN_KV_ROLLBACK || '').toLowerCase() !== 'true') {
      console.log('[RSS] Frozen KV rollback is not explicitly enabled; no-op.');
      return;
    }
    const shardIndex = Number(env.RSS_SHARD_INDEX || 0);
    const maxShards = Number(env.RSS_MAX_SHARDS || RSS_MAX_SHARDS);
    const active = await getKV(env.TUBEPULSE_KV, key.channelsActive()) || [];
    if (active.length === 0) return;

    const fiveMinuteTick = Math.floor((event?.scheduledTime ?? Date.now()) / 300000);
    const work = selectRssShardWork(active, shardIndex, maxShards, fiveMinuteTick);
    if (!work) return;

    console.log(`[RSS] shard=${shardIndex}/${work.activeShardCount} channel=${work.channelId}`);
    await pollSingleRssChannel(env, ctx, work.channelId);
  },
};

export async function pollSingleRssChannel(env, ctx, channelId, options = {}) {
  const feed = await fetchChannelRSS(channelId, {
    throwOnError: options.failOnFetchError,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    quiet: options.quiet,
  });
  if (!feed) {
    return { outcome: 'fetch-failed' };
  }
  if (feed.entries.length === 0) return { outcome: 'empty-feed' };

  const uploads = feed.entries.map((e) => ({
    videoId: e.videoId,
    title: e.title,
    published: e.published,
    thumbnail: e.thumbnail,
    link: e.link,
    channelTitle: feed.channelName,
    views: e.views,
    likes: e.likes,
    dislikes: e.dislikes,
  }));

  return await processChannelUploads(env, ctx, channelId, {
    channelName: feed.channelName,
    uploads,
  }, options);
}

export async function processChannelUploads(env, ctx, channelId, source, options = {}) {
  const kv = env.TUBEPULSE_KV;
  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const uploads = Array.isArray(source?.uploads) ? source.uploads : [];
  const channelName = source?.channelName || null;
  const logPrefix = String(options.logPrefix || 'RSS').replace(/[^A-Za-z0-9 -]/g, '').slice(0, 32) || 'RSS';
  if (uploads.length === 0) return { outcome: 'empty-feed' };

  // Read display cache and durable known/watermark state.
  const prevRecent = await getKV(kv, key.channelRecent(channelId)) || [];
  let known = await getKV(kv, key.channelKnownVideos(channelId));

  // First-run guard: if known:videos is missing, seed it from the current
  // RSS feed and seed the display cache. Never notify on first seed.
  if (!known || !known.highWatermarkAt) {
    const seedResult = seedKnownVideosFromRss(known, uploads, nowIso);
    const seededKnown = seedResult.nextKnown;
    await putKV(kv, key.channelKnownVideos(channelId), seededKnown);

    const subs = await getKV(kv, key.channelSubs(channelId)) || [];
    const seededRecent = mergeRssUploadsIntoRecentVideos(prevRecent, uploads, now);
    await putKVIfChanged(kv, key.channelRecent(channelId), seededRecent, prevRecent);

    const meta = await getKV(kv, key.channelMeta(channelId)) || {};
    let metaChanged = false;
    if (!meta.name && channelName) { meta.name = channelName; metaChanged = true; }
    if (seededRecent.length > 0 && meta.lastVideoId !== seededRecent[0].videoId) {
      meta.lastVideoId = seededRecent[0].videoId;
      metaChanged = true;
    }
    if (metaChanged) await putKVIfChanged(kv, key.channelMeta(channelId), meta);

    console.log(`[${logPrefix}] ${channelId}: first-run seed — ${seededKnown.ids.length} known IDs, highWatermarkAt=${seededKnown.highWatermarkAt}, subs=${subs.length}, no notifications`);
    return { outcome: 'seeded', entryCount: uploads.length };
  }

  // Classify videos using durable watermark: notify only unknown videos
  // strictly newer than the high-watermark timestamp.
  const classified = classifyRssVideosForNotification(known, uploads);
  const newVideos = classified.filter((v) => v.isNew);
  const suppressed = classified.filter((v) => !v.isNew);

  // Always reflect RSS structure while the shared helper enforces metric persistence.
  const mergedRecent = mergeRssUploadsIntoRecentVideos(prevRecent, uploads, now);
  await putKVIfChanged(kv, key.channelRecent(channelId), mergedRecent, prevRecent);

  // Update known/watermark state after every poll — write only on semantic change.
  const knownResult = updateKnownVideosAfterPoll(known, uploads, newVideos, nowIso);
  if (knownResult.changed) {
    await putKV(kv, key.channelKnownVideos(channelId), knownResult.nextKnown);
  }

  if (suppressed.length > 0) {
    console.log(`[${logPrefix}] ${channelId}: suppressed ${suppressed.length} videos (known or below watermark)`);
  }

  if (newVideos.length === 0) return { outcome: 'unchanged', entryCount: uploads.length };

  console.log(`[${logPrefix}] ${channelId}: ${newVideos.length} genuinely new videos above watermark`);

  // Update channel meta
  const meta = await getKV(kv, key.channelMeta(channelId)) || {};
  let metaChanged = false;
  if (!meta.name && channelName) { meta.name = channelName; metaChanged = true; }
  if (metaChanged) await putKVIfChanged(kv, key.channelMeta(channelId), meta);

  // Get subscribers
  const subs = await getKV(kv, key.channelSubs(channelId)) || [];
  if (subs.length === 0) return;

  // Get FCM access token (cached)
  let accessToken;
  try {
    accessToken = await getCachedFcmAccessToken(env);
  } catch (err) {
    console.error(`[${logPrefix}] FCM token error:`, err.message);
    return;
  }
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const projectId = sa.project_id;
  const deadDevices = [];

  for (const deviceId of subs) {
    const [profile, settings, override] = await Promise.all([
      getKV(kv, key.deviceProfile(deviceId)),
      getKV(kv, key.deviceSettings(deviceId)),
      getKV(kv, key.deviceOverride(deviceId, channelId)),
    ]);

    if (!profile?.fcmToken) continue;
    if (override?.muted) continue;

    const effective = {
      mode: override?.mode || settings?.mode || 'chill',
      nagInterval: override?.nagInterval || settings?.nagInterval || 15,
      dndEnabled: settings?.dndEnabled || false,
      dndStart: settings?.dndStart || '22:00',
      dndEnd: settings?.dndEnd || '07:00',
      dndTimezone: settings?.dndTimezone || 'UTC',
      dndBypass: override?.dndBypass || false,
      tapAction: settings?.tapAction || 'video',
    };

    const state = await getKV(kv, key.deviceState(deviceId, channelId)) || {
      unwatched: [], lastNagAt: null, nagCount: 0,
    };

    let shouldNotify = true;
    let stateChanged = false;
    let hadUnwatchedBefore = (state.unwatched || []).length > 0;

    for (const video of newVideos) {
      if (!state.unwatched.includes(video.videoId)) {
        state.unwatched.push(video.videoId);
        stateChanged = true;
      }

      if (video.type === 'live_scheduled') {
        const publishedTime = new Date(video.publishedAt).getTime();
        await withKvMutationLock(env, key.upcomingEvents(), async () => {
          const events = await getKV(kv, key.upcomingEvents()) || [];
          if (!events.some((e) => e.videoId === video.videoId)) {
            events.push({ channelId, videoId: video.videoId, scheduledFor: publishedTime, addedAt: now });
            await putKV(kv, key.upcomingEvents(), events);
          }
        });
        continue;
      }

      const dndActive = effective.dndEnabled && isDndActive(effective.dndStart, effective.dndEnd, effective.dndTimezone);
      const isLivestream = video.type === 'live';
      const bypassesDnd = effective.dndBypass || isLivestream;
      if (dndActive && !bypassesDnd) shouldNotify = false;
    }

    // Add to nag:active only when genuine unread items were added and
    // unwatched transitioned from empty to non-empty.
    if (stateChanged && !hadUnwatchedBefore && (state.unwatched || []).length > 0) {
      await addToNagActive(env, deviceId, channelId);
    }

    if (stateChanged) {
      await putKV(kv, key.deviceState(deviceId, channelId), state);
    }

    // Send FCM
    const notifyEntries = newVideos.filter((v) => v.type !== 'live_scheduled' && shouldNotify);
    if (notifyEntries.length > 0) {
      let notifPayload;
      const channelName = meta.name || channelId;
      if (notifyEntries.length === 1) {
        const v = notifyEntries[0];
        notifPayload = {
          title: `${channelName} uploaded`,
          body: v.title,
          data: {
            videoId: v.videoId, channelId, channelName, videoLink: v.link,
            type: v.type, tapAction: String(effective.tapAction),
          },
          tag: `video-${v.videoId}`,
        };
      } else {
        notifPayload = {
          title: `${channelName} - ${notifyEntries.length} new videos`,
          body: notifyEntries.map((v) => v.title).join('\n'),
          data: {
            type: 'batch', count: String(notifyEntries.length), channelId,
            contentIds: JSON.stringify(notifyEntries.map((v) => v.videoId)),
            tapAction: String(effective.tapAction),
          },
          tag: 'tubepulse-batch',
        };
      }
      const pushResult = await sendFCMPush(
        accessToken, projectId, profile.fcmToken, notifPayload, profile.notificationCapability,
      );
      if (pushResult.shadow) {
        const deferred = env.TUBEPULSE_NOTIFICATION_DEFERRED === true;
        await env.TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER?.({
          kind: 'video',
          channelId,
          ...(deferred ? {
            deviceId,
            projectId,
            fcmToken: profile.fcmToken,
            notificationCapability: profile.notificationCapability || null,
            payload: notifPayload,
            contentIds: notifyEntries.map((video) => video.videoId),
            requireUnwatched: true,
            onResult: async (result) => {
              if (result?.sent) {
                await withKvMutationLock(env, key.deviceState(deviceId, channelId), async () => {
                  const current = await getKV(kv, key.deviceState(deviceId, channelId)) || state;
                  await putKV(kv, key.deviceState(deviceId, channelId), { ...current, lastNagAt: now });
                });
              } else if (result?.deadToken) {
                await cleanupDeadDevice(deviceId, env, 'fcm_unregistered');
              }
            },
          } : {}),
        });
      }
      if (pushResult.deadToken) deadDevices.push(deviceId);
      if (pushResult.sent) {
        state.lastNagAt = now;
        await putKV(kv, key.deviceState(deviceId, channelId), state);
      }
    }
  }

  for (const deviceId of [...new Set(deadDevices)]) {
    console.log(`[${logPrefix}] Pruning dead device: ${deviceId}`);
    ctx.waitUntil(cleanupDeadDevice(deviceId, env, 'fcm_unregistered'));
  }
  return { outcome: 'new-content', entryCount: uploads.length, newVideoCount: newVideos.length };
}
