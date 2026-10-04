// tubepulse-aux — nag + prewarn combined worker
// Scheduled every minute. Does ONE bounded job per tick:
//   1. Nag: process up to NAG_BATCH_SIZE entries from nag:active
//   2. Prewarn: if nag didn't run (or ran with budget to spare), check prewarn
//
// Priority: nag first, prewarn second. If nag fired any pushes, skip
// prewarn this tick (prewarn is rarely urgent — events are usually
// hours away). If nag had nothing to do, run prewarn.
//
// Both jobs are bounded and never scan all channels/subscribers/devices.

import {
  key, getKV, putKV, isDndActive, getNagIntervalMs,
  getCachedFcmAccessToken, sendFCMPush, cleanupDeadDevice,
  removeFromNagActive,
  withKvMutationLock,
} from '../tubepulse-cron/shared.mjs';

const NAG_BATCH_SIZE = 5;
const TICK_MS = 5 * 60 * 1000;

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
    const nagFired = await runNag(env, ctx, now);

    // ── 3. Prewarn: only if nag had nothing to fire ──
    // Prewarn is rarely urgent (events are hours away). If nag fired
    // any pushes, skip prewarn this tick to keep CPU low.
    if (nagFired === 0) {
      await runPrewarn(env, ctx, now);
    }
}

// ─── Nag ────────────────────────────────────────────────────────────────

async function runNag(env, ctx, now) {
  const nagActive = await getKV(env.TUBEPULSE_KV, key.nagActive()) || [];
  if (nagActive.length === 0) return 0;

  // Process at most NAG_BATCH_SIZE entries per tick
  const batch = nagActive.slice(0, NAG_BATCH_SIZE);
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

    const effective = {
      mode: override?.mode || settings?.mode || 'chill',
      nagInterval: override?.nagInterval || settings?.nagInterval || 15,
      dndEnabled: settings?.dndEnabled || false,
      dndStart: settings?.dndStart || '22:00',
      dndEnd: settings?.dndEnd || '07:00',
      dndTimezone: settings?.dndTimezone || 'UTC',
      dndBypass: override?.dndBypass || false,
      muted: override?.muted || false,
    };

    if (effective.muted) continue;

    const dndActive = effective.dndEnabled && isDndActive(effective.dndStart, effective.dndEnd, effective.dndTimezone);
    if (dndActive && !effective.dndBypass) continue;

    // Tick-aligned interval check
    const intervalMs = getNagIntervalMs(effective, state);
    const lastNagAt = state.lastNagAt || 0;
    const lastNagTick = lastNagAt > 0 ? Math.floor(lastNagAt / TICK_MS) * TICK_MS : 0;
    if (lastNagTick > 0 && (now - lastNagTick) < intervalMs) continue;

    // Get FCM access token (lazy — only when we actually need to send)
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

    // Build notification
    const [meta, recent, recentPosts] = await Promise.all([
      getKV(env.TUBEPULSE_KV, key.channelMeta(channelId)),
      getKV(env.TUBEPULSE_KV, key.channelRecent(channelId)),
      getKV(env.TUBEPULSE_KV, key.channelRecentPosts(channelId)),
    ]);
    const channelName = meta?.name || channelId;

    const stillUnwatched = state.unwatched;
    const postIds = stillUnwatched.filter((id) => id.startsWith('post:'));
    const videoIds = stillUnwatched.filter((id) => !id.startsWith('post:'));
    const hasPosts = postIds.length > 0;
    const hasVideos = videoIds.length > 0;

    let notifPayload;
    if (stillUnwatched.length === 1) {
      const itemId = stillUnwatched[0];
      if (itemId.startsWith('post:')) {
        const activityId = itemId.slice(5);
        const post = (recentPosts || []).find((p) => p.activityId === activityId);
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
        const video = (recent || []).find((v) => v.videoId === itemId);
        notifPayload = {
          title: `${channelName} - reminder`,
          body: video?.title || 'Unwatched video',
          data: {
            videoId: itemId, channelId, channelName,
            videoLink: video?.link || `https://www.youtube.com/watch?v=${itemId}`,
            type: 'nag', notificationTag: `video-${itemId}`,
          },
          tag: `video-${itemId}`,
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
        title: `${channelName} - ${stillUnwatched.length} unread`,
        body,
        data: { type: 'batch', count: String(stillUnwatched.length), channelId, channelName },
        tag: `tubepulse-nag-${channelId}`,
      };
    }

    try {
      const result = await sendFCMPush(accessToken, projectId, profile.fcmToken, notifPayload);
      if (result.shadow) {
        const deferred = env.TUBEPULSE_NOTIFICATION_DEFERRED === true;
        await env.TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER?.({
          kind: 'nag',
          channelId,
          ...(deferred ? {
            deviceId,
            projectId,
            fcmToken: profile.fcmToken,
            payload: notifPayload,
            contentIds: [...stillUnwatched],
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
        if (deferred) fired++;
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
        const result = await sendFCMPush(accessToken, projectId, profile.fcmToken, notifPayload);
        if (result.shadow) {
          const deferred = env.TUBEPULSE_NOTIFICATION_DEFERRED === true;
          await env.TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER?.({
            kind: 'prewarn',
            channelId: ev.channelId,
            ...(deferred ? {
              deviceId,
              projectId,
              fcmToken: profile.fcmToken,
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
