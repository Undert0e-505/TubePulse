import { createGatewayWorker } from './gateway.mjs';
import { createAuthorityWorker, TubePulseAuthorityCoordinator } from './authority.mjs';
import {
  buildFcmMessage,
  normalizeNotificationCapability,
} from '../tubepulse-cron/shared.mjs';

export { TubePulseAuthorityCoordinator };

/**
 * TubePulse API Worker — v3.0 (channel-first architecture)
 *
 * REST API for the TubePulse app + WebSub callback endpoint.
 *
 * Architecture: channel-first. Every operation starts from the channel,
 * then fans out to subscribers. No KV.list() calls anywhere.
 *
 * Endpoints:
 *   POST /register          — Register/update device profile (FCM token)
 *   POST /subscribe-channel — Add a channel to this device
 *   POST /unsubscribe       — Remove a channel from this device
 *   POST /seen              — Mark video(s) as watched
 *   GET  /feed              — Get current feed data for all tracked channels
 *   GET  /resolve           — Handle → channelId resolution
 *   POST /bootstrap         — Fetch RSS + avatar for a new channel (sync)
 *   POST /settings          — Update device-level notification settings
 *   POST /channel-override  — Set/update per-channel notification override
 *   GET  /websub            — WebSub verification handshake
 *   POST /websub            — WebSub push from YouTube
 */

// ─── Helpers ────────────────────────────────────────────────────────────

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function errorResponse(message, status = 400) {
  return json({ error: message }, status);
}

// ─── Auth ───────────────────────────────────────────────────────────────

function getDeviceId(request) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

// ─── KV helpers ─────────────────────────────────────────────────────────

// Key builders — single source of truth for key schema
const key = {
  channelMeta:      (channelId) => `channel:${channelId}:meta`,
  channelSubs:      (channelId) => `channel:${channelId}:subscribers`,
  channelWebsub:    (channelId) => `channel:${channelId}:websub`,
  channelRecent:    (channelId) => `channel:${channelId}:recent`,
  channelRecentPosts: (channelId) => `channel:${channelId}:recent:posts`,
  firstPollAtPosts: (channelId) => `channel:${channelId}:firstPollAt:posts`,
  channelKnownPosts: (channelId) => `channel:${channelId}:known:posts`,
  channelKnownVideos: (channelId) => `channel:${channelId}:known:videos`,
  deviceProfile:    (deviceId)  => `device:${deviceId}:profile`,
  deviceSettings:   (deviceId)  => `device:${deviceId}:settings`,
  deviceChannels:   (deviceId)  => `device:${deviceId}:channels`,
  deviceOverride:   (deviceId, channelId) => `device:${deviceId}:override:${channelId}`,
  deviceState:      (deviceId, channelId) => `device:${deviceId}:state:${channelId}`,
  // FCM-token → deviceId index. Written on every /register that includes
  // a real FCM token, deleted when the device is cleaned up. Used to
  // detect "same install, new deviceId" events (e.g. v3.0.18 UUID-based
  // deviceId → v3.0.19 Android-ID-based deviceId) and migrate state.
  fcmLookup:        (fcmToken)  => `fcm:lookup:${fcmToken}`,
  upcoming:         (bucket)    => `upcoming:${bucket}`,
  nag:              (bucket)    => `nag:${bucket}`,
  channelsActive:   ()          => `channels:active`,
  handle:           (lc)        => `handle:${lc}`,
  // List of all currently-scheduled live events. Append-only on
  // detection in this worker; the cron's runPrewarnCron reads it and
  // prunes events past their scheduledFor + 24h.
  upcomingEvents:   ()          => `upcoming:events:list`,
  // nag:active — array of "deviceId|channelId" entries tracking which
  // device+channel pairs have unwatched items and need nag processing.
  nagActive:         ()          => `nag:active`,
  // Per-user prewarn tracking.
  prewarnSent:       (videoId, deviceId) => `upcoming:prewarn:${videoId}:${deviceId}`,
};

async function getKV(kv, k) { return await kv.get(k, 'json'); }
async function putKV(kv, k, value) { await kv.put(k, JSON.stringify(value)); }
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}
function jsonEqual(a, b) {
  return stableJson(a) === stableJson(b);
}
async function putKVIfChanged(kv, k, value, existingValue) {
  const existing = arguments.length >= 4 ? existingValue : await getKV(kv, k);
  if (jsonEqual(existing, value)) return false;
  await putKV(kv, k, value);
  return true;
}

const LAST_SEEN_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export async function touchExistingDeviceActivity(env, deviceId, { now = Date.now() } = {}) {
  if (!deviceId) return { profilePresent: false, touched: false, retryAfterMs: 0 };
  const profileKey = key.deviceProfile(deviceId);
  const existing = await getKV(env.TUBEPULSE_KV, profileKey);
  if (!existing || Array.isArray(existing) || typeof existing !== 'object') {
    return { profilePresent: false, touched: false, retryAfterMs: 0 };
  }

  const lastSeenAt = Number(existing.lastSeenAt);
  if (Number.isFinite(lastSeenAt)) {
    const ageMs = Math.max(0, now - lastSeenAt);
    if (ageMs < LAST_SEEN_REFRESH_INTERVAL_MS) {
      return {
        profilePresent: true,
        touched: false,
        retryAfterMs: LAST_SEEN_REFRESH_INTERVAL_MS - ageMs,
      };
    }
  }

  const touched = await putKVIfChanged(env.TUBEPULSE_KV, profileKey, { ...existing, lastSeenAt: now }, existing);
  return {
    profilePresent: true,
    touched,
    retryAfterMs: LAST_SEEN_REFRESH_INTERVAL_MS,
  };
}
async function deleteKVIfExists(kv, k) {
  const existing = await getKV(kv, k);
  if (existing === null) return false;
  await kv.delete(k);
  return true;
}

function isCommunityPostsEnabled(env) {
  const value = String(env.TUBEPULSE_ENABLE_COMMUNITY_POSTS || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

// ─── Cleanup helpers ────────────────────────────────────────────────────
//
// These remove state for channels/devices that no longer need it. Both
// run on a single worker, so KV ops are not double-counted elsewhere.
//
// Idempotent: kv.delete() on a missing key is a no-op. If two workers
// race to clean up the same dead device, we just log the duplicate and
// move on — no state corruption, just a small amount of wasted ops.
//
// Logging convention: every cleanup emits a single console.log with
// deviceId/channelId + reason + counts. Watch for sudden spikes in
// cleanup volume (likely an app-version bug or mass uninstall event).

/**
 * Remove a channel's cached state once it has zero subscribers.
 * Idempotent. Safe to call even if the channel was never cached.
 *
 * Returns a promise that resolves with the cleanup result. The caller
 * decides whether to await it (blocking) or wrap it in ctx.waitUntil
 * (fire-and-forget) depending on the request lifecycle.
 *
 * @param {string} channelId
 * @param {object} env
 * @param {string} [reason='unsubscribe_last'] — for logs
 * @returns {Promise<{deletedKeys: number, removedFromActive: boolean}>}
 */
async function cleanupDeadChannel(channelId, env, reason = 'unsubscribe_last') {
  const kv = env.TUBEPULSE_KV;
  let deletedKeys = 0;

  await kv.delete(key.channelMeta(channelId));
  deletedKeys++;
  await kv.delete(key.channelRecent(channelId));
  deletedKeys++;
  await kv.delete(key.channelRecentPosts(channelId));
  deletedKeys++;
  await kv.delete(key.firstPollAtPosts(channelId));
  deletedKeys++;
  await kv.delete(key.channelKnownPosts(channelId));
  deletedKeys++;
  // A known-video watermark belongs to one active-subscription lifecycle.
  // Retaining it after the final subscriber leaves turns a later re-add into
  // a historical catch-up notification rather than a silent first seed.
  await kv.delete(key.channelKnownVideos(channelId));
  deletedKeys++;
  await kv.delete(key.channelWebsub(channelId));
  deletedKeys++;
  // Also delete the subscribers list. The list was already empty (or
  // about to be — this helper is called when the last subscriber just
  // left), and leaving it as an empty `[]` orphans a key in KV. Cost:
  // one extra delete per channel cleanup, which is fine — the cleanup
  // is rare (event-driven, only on last-subscriber-leaves or FCM
  // UNREGISTERED).
  await kv.delete(key.channelSubs(channelId));
  deletedKeys++;

  const active = await getKV(kv, key.channelsActive()) || [];
  const filtered = active.filter((id) => id !== channelId);
  const removedFromActive = filtered.length !== active.length;
  if (removedFromActive) {
    await putKV(kv, key.channelsActive(), filtered);
  }

  console.log(`[Cleanup] channel ${channelId}: reason=${reason} deletedKeys=${deletedKeys} removedFromActive=${removedFromActive}`);
  return { deletedKeys, removedFromActive };
}

/**
 * Remove a device's full state once FCM has reported it dead (UNREGISTERED).
 * Also cleans up every channel the device was subscribed to — and if any
 * of those channels go from N=1 to N=0 subscribers, the channel is also
 * cleaned via cleanupDeadChannel.
 *
 * Idempotent. Safe to call on a device that was never registered.
 *
 * Returns a promise; caller decides whether to await or wrap in waitUntil.
 *
 * @param {string} deviceId
 * @param {object} env
 * @param {string} [reason='fcm_unregistered']
 * @returns {Promise<{channelsCleaned: number, devicesDeleted: number}>}
 */
async function cleanupDeadDevice(deviceId, env, reason = 'fcm_unregistered') {
  const kv = env.TUBEPULSE_KV;

  // 0. Read the profile so we can clean the FCM-lookup index below.
  //    This also acts as a no-op guard — if there's no profile, there's
  //    nothing to clean.
  const profile = await getKV(kv, key.deviceProfile(deviceId));
  if (!profile) {
    // Already cleaned up; nothing to do.
    return { channelsCleaned: 0, devicesDeleted: 0 };
  }

  // 1. Find every channel this device was on.
  const channels = await getKV(kv, key.deviceChannels(deviceId)) || [];
  let channelsCleaned = 0;

  // 2. For each channel, remove the device from its subscribers list.
  //    If the list goes empty, the channel is also fully cleaned up.
  for (const channelId of channels) {
    const subs = await getKV(kv, key.channelSubs(channelId)) || [];
    const filtered = subs.filter((id) => id !== deviceId);
    await putKV(kv, key.channelSubs(channelId), filtered);

    if (filtered.length === 0 && subs.length > 0) {
      await cleanupDeadChannel(channelId, env, 'last_subscriber_dead');
      channelsCleaned++;
    }
  }

  // 3. Delete the device's own state. We do this last so a failure in
  //    step 2 leaves the device profile intact and the next push will
  //    retry the cleanup.
  let devicesDeleted = 0;
  const deviceKeys = [
    key.deviceProfile(deviceId),
    key.deviceSettings(deviceId),
    key.deviceChannels(deviceId),
  ];
  for (const k of deviceKeys) {
    await kv.delete(k);
    devicesDeleted++;
  }

  // 3a. If we have a profile in memory, also clean up the FCM-lookup
  //     index so a future /register doesn't try to migrate from a
  //     dead device. (We may not have the profile here if called from
  //     migrateDevice, which is fine — the lookup gets rewritten by
  //     the new device's register call anyway.)
  if (profile && profile.fcmToken) {
    await kv.delete(key.fcmLookup(profile.fcmToken));
  }

  // 4. Delete per-channel state + override. We don't know the channel
  //    list any more (we just deleted :channels), so iterate the list
  //    we captured in step 1.
  for (const channelId of channels) {
    await kv.delete(key.deviceState(deviceId, channelId));
    await kv.delete(key.deviceOverride(deviceId, channelId));
    devicesDeleted += 2;
  }

  console.log(`[Cleanup] device ${deviceId}: reason=${reason} channelsAffected=${channels.length} channelsCleaned=${channelsCleaned} devicesDeleted=${devicesDeleted}`);
  return { channelsCleaned, devicesDeleted };
}

/**
 * Migrate state from one deviceId to another. Used when the same FCM
 * token registers with a new deviceId — the typical case is a client
 * app upgrade that changes its device-ID source (e.g. v3.0.18 random
 * UUID → v3.0.19 Android ID), or a debug/release build switch on the
 * same physical device. The new deviceId inherits the old device's
 * channel subscriptions, settings, and per-channel state. The old
 * deviceId is then cleaned up.
 *
 * Both the FCM-lookup index and the channel-subscribers lists are
 * rewritten to point at the new deviceId. After migration, the old
 * deviceId's profile, settings, channels, state:*, override:* keys
 * are deleted (via cleanupDeadDevice).
 *
 * Idempotent — safe to call when the new deviceId already has the same
 * state (will be a no-op for those channels).
 *
 * @param {string} oldDeviceId
 * @param {string} newDeviceId
 * @param {object} env
 * @returns {Promise<{channelsMigrated: number, settingsMigrated: boolean}>}
 */
async function migrateDevice(oldDeviceId, newDeviceId, env) {
  if (oldDeviceId === newDeviceId) {
    return { channelsMigrated: 0, settingsMigrated: false };
  }
  const kv = env.TUBEPULSE_KV;

  // 1. Read old device's state.
  const oldChannels = await getKV(kv, key.deviceChannels(oldDeviceId)) || [];
  const oldSettings = await getKV(kv, key.deviceSettings(oldDeviceId));
  const newChannels = await getKV(kv, key.deviceChannels(newDeviceId)) || [];

  // 2. Merge channels (union, dedupe).
  const mergedChannels = [...new Set([...newChannels, ...oldChannels])];

  // 3. For each channel the old device was on, add the new device to
  //    the subscribers list (if not already there) and copy the
  //    per-channel state + override to the new device.
  let channelsMigrated = 0;
  for (const channelId of oldChannels) {
    const subs = await getKV(kv, key.channelSubs(channelId)) || [];
    if (!subs.includes(newDeviceId)) {
      const filtered = subs.filter((id) => id !== oldDeviceId);
      filtered.push(newDeviceId);
      await putKV(kv, key.channelSubs(channelId), filtered);
    } else {
      // New device already on this channel — just remove the old one.
      const filtered = subs.filter((id) => id !== oldDeviceId);
      await putKV(kv, key.channelSubs(channelId), filtered);
    }

    // Copy per-channel state (don't overwrite if new device already has one).
    const newStateExists = await getKV(kv, key.deviceState(newDeviceId, channelId)) !== null;
    if (!newStateExists) {
      const oldState = await getKV(kv, key.deviceState(oldDeviceId, channelId));
      if (oldState) {
        await putKV(kv, key.deviceState(newDeviceId, channelId), oldState);
      }
    }

    // Copy per-channel override (new device takes precedence if it has one).
    const newOverrideExists = await getKV(kv, key.deviceOverride(newDeviceId, channelId)) !== null;
    if (!newOverrideExists) {
      const oldOverride = await getKV(kv, key.deviceOverride(oldDeviceId, channelId));
      if (oldOverride) {
        await putKV(kv, key.deviceOverride(newDeviceId, channelId), oldOverride);
      }
    }

    channelsMigrated++;
  }

  // 4. Write the merged channel list to the new device.
  await putKV(kv, key.deviceChannels(newDeviceId), mergedChannels);

  // 5. Migrate settings (new device takes precedence if it already has settings).
  let settingsMigrated = false;
  const newSettingsExists = await getKV(kv, key.deviceSettings(newDeviceId)) !== null;
  if (!newSettingsExists && oldSettings) {
    await putKV(kv, key.deviceSettings(newDeviceId), oldSettings);
    settingsMigrated = true;
  }

  // 6. Clean up the old device. This deletes the old profile/settings/
  //    channels/state/override and ensures it's not in any subscribers
  //    list (we already did that in step 3).
  await cleanupDeadDevice(oldDeviceId, env, 'migrated_to_new_device');

  console.log(`[Migrate] ${oldDeviceId} → ${newDeviceId}: channels=${channelsMigrated} settings=${settingsMigrated}`);
  return { channelsMigrated, settingsMigrated };
}

// ─── DND logic ──────────────────────────────────────────────────────────

function isDndActive(dndStart, dndEnd, timezone = 'UTC') {
  const [sh, sm] = dndStart.split(':').map(Number);
  const [eh, em] = dndEnd.split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;

  // Get the current hour/minute in the device's timezone (Intl is available in
  // the Workers JS runtime). Falls back to UTC if the tz string is invalid.
  let nowMins;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const hh = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const mm = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    nowMins = hh * 60 + mm;
  } catch {
    const now = new Date();
    nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  }

  if (startMins <= endMins) {
    return nowMins >= startMins && nowMins < endMins;
  } else {
    return nowMins >= startMins || nowMins < endMins;
  }
}

// ─── WebSub subscription management ────────────────────────────────────

const HUB_URL = 'https://pubsubhubbub.appspot.com/';
const FEED_TEMPLATE = 'https://www.youtube.com/feeds/videos.xml?channel_id=';

async function subscribeToChannel(channelId, callbackUrl, secret) {
  const feedUrl = `${FEED_TEMPLATE}${channelId}`;
  const body = new URLSearchParams({
    'hub.callback': callbackUrl,
    'hub.mode': 'subscribe',
    'hub.topic': feedUrl,
    'hub.verify': 'sync',
    'hub.lease_seconds': String(86400 * 5),
    'hub.secret': secret,
  });

  try {
    const resp = await fetch(HUB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    console.log(`[WebSub] Subscribe for ${channelId}: ${resp.status}`);
    return resp.ok || resp.status === 202 || resp.status === 204;
  } catch (err) {
    console.error(`[WebSub] Subscribe failed for ${channelId}:`, err.message);
    return false;
  }
}

async function unsubscribeFromChannel(channelId, callbackUrl) {
  const feedUrl = `${FEED_TEMPLATE}${channelId}`;
  const body = new URLSearchParams({
    'hub.callback': callbackUrl,
    'hub.mode': 'unsubscribe',
    'hub.topic': feedUrl,
    'hub.verify': 'sync',
  });

  try {
    await fetch(HUB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    console.log(`[WebSub] Unsubscribe request for ${channelId}`);
  } catch (err) {
    console.error(`[WebSub] Unsubscribe failed for ${channelId}:`, err.message);
  }
}

// ─── WebSub HMAC verification ────────────────────────────────────────────

async function verifyWebSubSignature(payload, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  const match = signatureHeader.match(/^sha256=(.+)$/i);
  if (!match) return false;

  const expectedHex = match[1];
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(payload));
  const sigHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return sigHex === expectedHex;
}

// ─── XML Parser ─────────────────────────────────────────────────────────

function parseWebSubPush(xmlText) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m;

  while ((m = entryRegex.exec(xmlText)) !== null) {
    const e = m[1];
    const videoId = e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = e.match(/<title>([^<]+)<\/title>/)?.[1];
    const link = e.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/)?.[1]
      || e.match(/<link[^>]*href="([^"]+)"[^>]*rel="alternate"/)?.[1]
      || `https://www.youtube.com/watch?v=${videoId}`;
    const published = e.match(/<published>([^<]+)<\/published>/)?.[1];
    const updated = e.match(/<updated>([^<]+)<\/updated>/)?.[1];
    const thumbMatch = e.match(/<media:thumbnail[^>]*url="([^"]+)"/);
    const thumbnail = thumbMatch ? thumbMatch[1] : null;
    const descMatch = e.match(/<media:description>([^<]*)<\/media:description>/);
    const description = descMatch ? descMatch[1] : '';
    // View count lives in media:community/media:statistics/@_views
    const viewsMatch = e.match(/<media:statistics[^>]*views="(\d+)"/);
    const views = viewsMatch ? viewsMatch[1] : null;

    // Likes / dislikes live in media:community/media:starRating/@_count
    // and a `dislikes` attribute on media:statistics. We accept both
    // layouts defensively — many feeds only carry likes on starRating.
    const likesMatch = e.match(/<media:starRating[^>]*count="(\d+)"/);
    const likes = likesMatch ? likesMatch[1] : null;
    const dislMatch = e.match(/<media:statistics[^>]*dislikes="(\d+)"/);
    const dislikes = dislMatch ? dislMatch[1] : null;

    if (videoId) {
      entries.push({ videoId, title, link, published, updated, thumbnail, description, views, likes, dislikes });
    }
  }

  const channelId = xmlText.match(/<yt:channelId>([^<]+)<\/yt:channelId>/)?.[1];
  const channelName = xmlText.match(/<name>([^<]+)<\/name>/)?.[1];

  return { channelId, channelName, entries };
}

// ─── YouTube RSS fetch ─────────────────────────────────────────────────

async function fetchYouTubeRSS(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(feedUrl, { signal: controller.signal });
    if (!resp.ok) return null;
    const xml = await resp.text();

    // Parse with our lightweight parser
    const parsed = parseWebSubPush(xml);
    if (!parsed.channelId || parsed.entries.length === 0) return { channel: null, videos: [] };

    const channel = { name: parsed.channelName || '', uri: '' };
    const videos = parsed.entries.map((e) => ({
      videoId: e.videoId,
      title: e.title,
      published: e.published,
      updated: e.updated,
      link: e.link,
      thumbnail: e.thumbnail,
      description: e.description,
      views: e.views,
      likes: e.likes,
      dislikes: e.dislikes,
    }));

    return { channel, videos };
  } catch (err) {
    console.error(`RSS fetch error for ${channelId}:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── YouTube Data API (avatars + resolve + recent videos) ──────────────

async function fetchRecentVideosViaAPI(apiKey, channelId, maxResults = 15) {
  const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${encodeURIComponent(channelId)}&fields=items(contentDetails(relatedPlaylists(uploads)))&key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const channelResp = await fetch(channelUrl, { signal: controller.signal });
    if (!channelResp.ok) return null;
    const channelData = await channelResp.json();
    const playlistId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!playlistId) return null;
    const apiUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails,status&playlistId=${encodeURIComponent(playlistId)}&maxResults=${Math.min(50, maxResults)}&fields=items(snippet(publishedAt,channelTitle,title,thumbnails),contentDetails(videoId,videoPublishedAt),status(privacyStatus))&key=${apiKey}`;
    const resp = await fetch(apiUrl, { signal: controller.signal });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.items?.length) return null;

    const videos = data.items.map((item) => {
      const s = item.snippet;
      const thumbs = s.thumbnails || {};
      return {
        videoId: item.contentDetails?.videoId,
        title: s.title,
        publishedAt: item.contentDetails?.videoPublishedAt || s.publishedAt,
        thumbnail: thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null,
        type: classifyVideo({ title: s.title, published: item.contentDetails?.videoPublishedAt || s.publishedAt }),
        link: `https://www.youtube.com/watch?v=${item.contentDetails?.videoId}`,
      };
    }).filter((v, index) => v.videoId && data.items[index]?.status?.privacyStatus !== 'private'
      && !/^(deleted|private) video$/i.test(String(v.title || '').trim()));

    return videos;
  } catch (err) {
    console.error(`Uploads playlist API error for ${channelId}:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Batched statistics lookup. Optional metrics remain null when YouTube hides
// or omits them; null must not be converted into a misleading public zero.
// Costs 1 quota unit per call (up to 50 video IDs at once).
// Returns null on quota/connection error so the caller can degrade gracefully.
async function fetchVideoStatistics(apiKey, videoIds) {
  if (!videoIds || videoIds.length === 0) return {};
  const ids = videoIds.filter(Boolean).slice(0, 50);
  if (ids.length === 0) return {};
  const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.map(encodeURIComponent).join(',')}&key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(apiUrl, { signal: controller.signal });
    if (!resp.ok) return null;
    const data = await resp.json();
    const out = {};
    for (const item of data.items || []) {
      const statistics = item.statistics || {};
      out[item.id] = {
        views: statistics.viewCount != null ? String(statistics.viewCount) : null,
        likes: statistics.likeCount != null ? String(statistics.likeCount) : null,
        dislikes: statistics.dislikeCount != null ? String(statistics.dislikeCount) : null,
      };
    }
    return out;
  } catch (err) {
    console.error(`VideoStatistics error:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveChannelViaAPI(apiKey, channelId) {
  const apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${encodeURIComponent(channelId)}&key=${apiKey}`;
  const resp = await fetch(apiUrl);
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data.items?.[0]) return null;
  const ch = data.items[0];
  const thumbs = ch.snippet?.thumbnails || {};
  return {
    channelId: ch.id,
    name: ch.snippet?.title || null,
    avatar: thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null,
  };
}

async function ensureChannelAvatar(env, channelId, meta, logScope) {
  if (!env.YOUTUBE_API_KEY || meta?.avatarUrl) return meta;

  try {
    const resolved = await resolveChannelViaAPI(env.YOUTUBE_API_KEY, channelId);
    if (!resolved) return meta;

    const repaired = {
      ...(meta || {}),
      name: resolved.name || meta?.name || channelId,
      avatarUrl: resolved.avatar || meta?.avatarUrl || null,
      lastVideoId: meta?.lastVideoId || null,
      addedAt: meta?.addedAt || Date.now(),
    };
    await putKVIfChanged(env.TUBEPULSE_KV, key.channelMeta(channelId), repaired, meta);
    return repaired;
  } catch (e) {
    console.warn(`[${logScope}] Avatar fetch failed for ${channelId}:`, e.message);
    return meta;
  }
}

async function resolveHandleViaAPI(apiKey, handle) {
  const clean = handle.replace(/^@/, '');

  // Attempt 1: forHandle
  let apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=${encodeURIComponent(clean)}&key=${apiKey}`;
  let resp = await fetch(apiUrl);
  if (resp.ok) {
    const data = await resp.json();
    if (data.items?.length) {
      const ch = data.items[0];
      const thumbs = ch.snippet?.thumbnails || {};
      return {
        channelId: ch.id,
        name: ch.snippet?.title || null,
        avatar: thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null,
      };
    }
  }

  // Attempt 2: forUsername fallback
  apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&forUsername=${encodeURIComponent(clean)}&key=${apiKey}`;
  resp = await fetch(apiUrl);
  if (resp.ok) {
    const data = await resp.json();
    if (data.items?.length) {
      const ch = data.items[0];
      const thumbs = ch.snippet?.thumbnails || {};
      return {
        channelId: ch.id,
        name: ch.snippet?.title || null,
        avatar: thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null,
      };
    }
  }

  return null;
}

// ─── FCM helpers ────────────────────────────────────────────────────────

async function getGoogleAccessToken(serviceAccountJson) {
  const sa = JSON.parse(serviceAccountJson);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  };

  const base64url = (obj) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const headerB64 = base64url(header);
  const payloadB64 = base64url(payload);
  const input = `${headerB64}.${payloadB64}`;

  const pemKey = sa.private_key;
  // The Cloudflare secret manager may store the file with literal "\n"
  // two-character sequences (escape sequences) rather than actual newlines.
  // Convert literal "\n" to real newlines first, then strip headers/whitespace.
  let pemBody = pemKey
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');

  // Fix base64 padding. Google service account JSON sometimes ships with the
  // wrong number of trailing '=' signs because JSON encoding strips them
  // inconsistently. Body length must be divisible by 4 to decode.
  while (pemBody.length % 4 !== 0) {
    pemBody += '=';
  }

  const binaryStr = atob(pemBody);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(input)
  );

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const jwt = `${input}.${signatureB64}`;

  const tokenResp = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
  }

  return tokenData.access_token;
}

async function sendFCMPush(accessToken, projectId, fcmToken, payload, notificationCapability = null) {
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: buildFcmMessage(fcmToken, payload, notificationCapability),
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`FCM push failed for token ${fcmToken.slice(0, 10)}...: ${resp.status} ${errText}`);
    if (resp.status === 404 || errText.includes('UNREGISTERED') || errText.includes('NotRegistered')) {
      return { sent: false, deadToken: true };
    }
    return { sent: false, deadToken: false };
  }

  return { sent: true, deadToken: false };
}

// ─── Time bucket helpers ────────────────────────────────────────────────

// Align to the nearest 5-minute boundary for upcoming buckets
function upcomingBucket(isoDate) {
  const d = new Date(isoDate);
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  return d.toISOString().slice(0, 16); // "2026-04-20T15:30"
}

// Align to the nearest 15-minute boundary for nag buckets
function nagBucket(timestampMs) {
  const d = new Date(timestampMs);
  d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
  return d.toISOString().slice(0, 16); // "2026-04-20T15:15"
}

// ─── Video type classification ──────────────────────────────────────────

function classifyVideo(entry) {
  const publishedTime = entry.published ? new Date(entry.published).getTime() : 0;
  if (publishedTime > Date.now() + 5 * 60 * 1000) return 'live_scheduled';
  if (entry.title?.startsWith('🔴') || /\bLIVE\b/i.test(entry.title || '')) return 'live';
  return 'video';
}

// ═══════════════════════════════════════════════════════════════════════
// Route handlers
// ═══════════════════════════════════════════════════════════════════════

// ─── POST /register ─────────────────────────────────────────────────────

async function handleRegister(request, env) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Missing Authorization: Bearer <device-id>', 401);

  let body;
  try { body = await request.json(); } catch { return errorResponse('Invalid JSON body'); }

  const { fcmToken, platform, appVersion } = body;
  const notificationCapability = normalizeNotificationCapability(body.notificationCapability);
  // fcmToken is optional — the device profile is what subscribes channels and
  // serves /feed. Push delivery is a separate concern, addressed by the
  // /register call when the user grants notification permission, and by
  // the onTokenRefresh hook from the app. If we made fcmToken required,
  // a fresh install on a user who denies notifications would never get
  // a device profile, and every subsequent /feed /subscribe-channel /etc
  // would 404.
  const now = Date.now();
  const existing = await getKV(env.TUBEPULSE_KV, key.deviceProfile(deviceId));

  // ─── FCM-token migration: same install, new deviceId ─────────────
  // If the FCM token is already known and points to a different deviceId,
  // this is a "same install, new deviceId" event — typically caused by
  // a client-side device-ID source change (e.g. v3.0.18 random UUID →
  // v3.0.19 Android ID), or a debug/release build switch on the same
  // physical device. Migrate the old device's state to the new deviceId
  // before we register the new one, so the user doesn't lose their
  // channels on upgrade.
  //
  // Two-phase check:
  //   1. Fast path: read the FCM-lookup index. If it points to a
  //      different deviceId, migrate that one.
  //   2. Slow path: if the lookup wasn't there (e.g. the lookup was
  //      lost on a prior FCM token rotation, or the old device was
  //      registered before the lookup index existed), scan all device
  //      profiles for the same FCM token and migrate any matches.
  //      This is the case that catches the v3.0.18 duplicate-deviceId
  //      race — both old UUIDs have the same FCM token, and we want
  //      to merge them into the new device on upgrade.
  let lookupDeviceId = null;
  if (fcmToken && fcmToken.length > 0) {
    let migrated = false;
    lookupDeviceId = await getKV(env.TUBEPULSE_KV, key.fcmLookup(fcmToken));
    if (lookupDeviceId && lookupDeviceId !== deviceId) {
      console.log(`[Register] FCM token lookup → ${lookupDeviceId}, migrating to new deviceId ${deviceId}`);
      await migrateDevice(lookupDeviceId, deviceId, env);
      migrated = true;
    }

    // Slow path: scan for any other devices with the same FCM token.
    // This is one extra `kv.list` per register, which is fine even
    // at free tier (~1 op per app launch, well under our 100k/day
    // budget). Necessary because the lookup index can be stale or
    // missing for the rare case where multiple old devices share
    // the same FCM token (e.g. the v3.0.18 duplicate-UUID race).
    if (lookupDeviceId !== deviceId) {
      const list = await env.TUBEPULSE_KV.list({ prefix: 'device:' });
      for (const k of list.keys) {
        if (migrated && !k.name.endsWith(':profile')) continue; // optimization
        // We only care about profile keys
        if (!k.name.endsWith(':profile')) continue;
        const oldId = k.name.slice('device:'.length, -':profile'.length);
        if (oldId === deviceId) continue;
        if (oldId === lookupDeviceId) continue; // already migrated
        const prof = await getKV(env.TUBEPULSE_KV, key.deviceProfile(oldId));
        if (prof?.fcmToken === fcmToken) {
          console.log(`[Register] Found orphan ${oldId} with matching FCM token, migrating`);
          await migrateDevice(oldId, deviceId, env);
        }
      }
    }
  }

  // Preserve existing fcmToken if the new one is missing or null —
  // this lets the app re-register on app launch with the current token
  // (which may be the same or a refreshed one) without overwriting
  // a known-good token with null during permission races.
  const effectiveFcmToken = (fcmToken && fcmToken.length > 0)
    ? fcmToken
    : (existing?.fcmToken || null);

  const baseProfile = {
    fcmToken: effectiveFcmToken,
    platform: platform || existing?.platform || 'android',
    appVersion: appVersion || existing?.appVersion || null,
    notificationCapability,
    createdAt: existing?.createdAt || now,
    lastSeenAt: existing?.lastSeenAt || now,
  };
  const profileFieldsChanged = !existing
    || existing.fcmToken !== baseProfile.fcmToken
    || existing.platform !== baseProfile.platform
    || existing.appVersion !== baseProfile.appVersion
    || existing.notificationCapability !== baseProfile.notificationCapability
    || existing.createdAt !== baseProfile.createdAt;
  const lastSeenAgeMs = now - (Number(existing?.lastSeenAt) || 0);
  const shouldRefreshLastSeen = !existing || profileFieldsChanged || lastSeenAgeMs >= LAST_SEEN_REFRESH_INTERVAL_MS;
  const profile = {
    ...baseProfile,
    lastSeenAt: shouldRefreshLastSeen ? now : baseProfile.lastSeenAt,
  };

  await putKVIfChanged(env.TUBEPULSE_KV, key.deviceProfile(deviceId), profile, existing);

  // Maintain the FCM-token → deviceId index so future migrations can
  // find this install even if the deviceId changes. Only update if we
  // have a real FCM token (the lookup is meaningless for null tokens).
  if (effectiveFcmToken && fcmToken && fcmToken.length > 0) {
    if (lookupDeviceId !== deviceId) {
      await putKVIfChanged(env.TUBEPULSE_KV, key.fcmLookup(effectiveFcmToken), deviceId, lookupDeviceId);
    }

    // If the FCM token rotated (we have a new token, the old one still
    // has a lookup pointing to us), clean up the old lookup. Otherwise
    // it sits in KV forever pointing to a token no one uses.
    if (existing?.fcmToken && existing.fcmToken !== effectiveFcmToken) {
      await env.TUBEPULSE_KV.delete(key.fcmLookup(existing.fcmToken));
      console.log(`[Register] FCM token rotated for ${deviceId}, cleaned up old lookup`);
    }
  }

  return json({ ok: true, createdAt: profile.createdAt, fcmTokenPresent: effectiveFcmToken !== null });
}

async function handleInternalActivityTouch(request, env) {
  if (String(env.TUBEPULSE_INTERNAL_ACTIVITY_TOUCH || '').toLowerCase() !== 'true') {
    return errorResponse('Not found', 404);
  }
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Missing Authorization: Bearer <device-id>', 401);
  const result = await touchExistingDeviceActivity(env, deviceId);
  if (!result.profilePresent) return errorResponse('Device not registered', 404);
  return json({ ok: true, touched: result.touched, retryAfterMs: result.retryAfterMs });
}

// ─── POST /subscribe-channel ────────────────────────────────────────────

const MAX_CHANNELS = 100;

async function handleSubscribeChannel(request, env, ctx) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Missing Authorization: Bearer <device-id>', 401);

  let body;
  try { body = await request.json(); } catch { return errorResponse('Invalid JSON body'); }

  const { channelId } = body;
  if (!channelId) return errorResponse('channelId is required');

  // Check device exists
  const profile = await getKV(env.TUBEPULSE_KV, key.deviceProfile(deviceId));
  if (!profile) return errorResponse('Device not registered', 404);

  // Read device channels, enforce cap
  const channels = await getKV(env.TUBEPULSE_KV, key.deviceChannels(deviceId)) || [];
  const alreadySubscribed = channels.includes(channelId);
  if (!alreadySubscribed && channels.length >= MAX_CHANNELS) {
    return errorResponse(`Channel limit reached (${MAX_CHANNELS})`, 400);
  }

  // Repair shared channel metadata before either the idempotent or new
  // subscription response. Older failed bootstraps can leave a valid meta
  // record with avatarUrl:null; checking only for a missing record made that
  // partial state permanent.
  let meta = await getKV(env.TUBEPULSE_KV, key.channelMeta(channelId));
  let recent = await getKV(env.TUBEPULSE_KV, key.channelRecent(channelId));
  meta = await ensureChannelAvatar(env, channelId, meta, 'API');

  if (alreadySubscribed) {
    // Return channel info even if already subscribed
    return json({ ok: true, alreadySubscribed: true, channel: { channelId, meta, recent } });
  }

  // Add to device channels
  channels.push(channelId);
  await putKV(env.TUBEPULSE_KV, key.deviceChannels(deviceId), channels);

  // Add device to channel subscribers
  const subs = await getKV(env.TUBEPULSE_KV, key.channelSubs(channelId)) || [];
  if (!subs.includes(deviceId)) subs.push(deviceId);
  await putKV(env.TUBEPULSE_KV, key.channelSubs(channelId), subs);

  const callbackUrl = `${new URL(request.url).origin}/websub`;
  const isFirstSubscriber = subs.length === 1;

  // Bootstrap channel data SYNCHRONOUSLY so /feed works immediately.
  if (!meta || !recent) {
    // Bootstrap structurally from the channel uploads playlist. Routine and
    // bootstrap discovery deliberately avoid both RSS and search.list.
    if (!recent && env.YOUTUBE_API_KEY) {
      try {
        const apiVideos = await fetchRecentVideosViaAPI(env.YOUTUBE_API_KEY, channelId);
        if (apiVideos && apiVideos.length > 0) {
          const statistics = await fetchVideoStatistics(env.YOUTUBE_API_KEY, apiVideos.map((v) => v.videoId)) || {};
          const checkedHour = Math.floor(Date.now() / 3600000);
          recent = apiVideos.map((v) => {
            const metrics = statistics[v.videoId] || {};
            return {
              ...v,
              views: metrics.views ?? null,
              likes: metrics.likes ?? null,
              dislikes: metrics.dislikes ?? null,
              viewsLastCheckedHour: checkedHour,
              likesLastCheckedHour: checkedHour,
            };
          });
          if (meta) meta.lastVideoId = apiVideos[0].videoId;
          await putKV(env.TUBEPULSE_KV, key.channelMeta(channelId), meta || {
            name: channelId,
            avatarUrl: null,
            lastVideoId: apiVideos[0].videoId,
            addedAt: Date.now(),
          });
          await putKV(env.TUBEPULSE_KV, key.channelRecent(channelId), recent);
        }
      } catch (e) {
        console.warn(`[API] Data API uploads bootstrap failed for ${channelId}:`, e.message);
      }
    }
  }

  // WebSub subscription + channels:active index (async — not blocking the response)
  ctx.waitUntil((async () => {
    if (isFirstSubscriber) {
      const active = await getKV(env.TUBEPULSE_KV, key.channelsActive()) || [];
      if (!active.includes(channelId)) {
        active.push(channelId);
        await putKV(env.TUBEPULSE_KV, key.channelsActive(), active);
      }

      const webSubDisabled = String(env.TUBEPULSE_DISABLE_WEBSUB || '').toLowerCase() === 'true';
      const subState = webSubDisabled ? null : await getKV(env.TUBEPULSE_KV, key.channelWebsub(channelId));
      if (!webSubDisabled && !subState) {
        const secret = crypto.randomUUID();
        const success = await subscribeToChannel(channelId, callbackUrl, secret);
        if (success) {
          await putKV(env.TUBEPULSE_KV, key.channelWebsub(channelId), {
            leaseExpiresAt: Date.now() + 86400 * 5 * 1000,
            hmacSecret: secret,
            lastVerified: Date.now(),
          });
        }
      }
    }
  })());

  return json({ ok: true, alreadySubscribed: false, channel: { channelId, meta, recent } });
}

// ─── POST /unsubscribe ─────────────────────────────────────────────────

async function handleUnsubscribe(request, env, ctx) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Missing Authorization: Bearer <device-id>', 401);

  let body;
  try { body = await request.json(); } catch { return errorResponse('Invalid JSON body'); }

  const { channelId } = body;
  if (!channelId) return errorResponse('channelId is required');

  // Remove from device channels
  const channels = await getKV(env.TUBEPULSE_KV, key.deviceChannels(deviceId)) || [];
  const updated = channels.filter((id) => id !== channelId);
  await putKV(env.TUBEPULSE_KV, key.deviceChannels(deviceId), updated);

  // Remove device from channel subscribers
  const subs = await getKV(env.TUBEPULSE_KV, key.channelSubs(channelId)) || [];
  const updatedSubs = subs.filter((id) => id !== deviceId);
  await putKV(env.TUBEPULSE_KV, key.channelSubs(channelId), updatedSubs);

  // Clean up device state + override for this channel
  await env.TUBEPULSE_KV.delete(key.deviceState(deviceId, channelId));
  await env.TUBEPULSE_KV.delete(key.deviceOverride(deviceId, channelId));

  // If last subscriber, unsubscribe from WebSub and remove from active index
  const isLastSubscriber = updatedSubs.length === 0;

  if (isLastSubscriber) {
    const callbackUrl = `${new URL(request.url).origin}/websub`;
    ctx.waitUntil((async () => {
      if (String(env.TUBEPULSE_DISABLE_WEBSUB || '').toLowerCase() !== 'true') {
        await unsubscribeFromChannel(channelId, callbackUrl);
      }
      // cleanupDeadChannel deletes meta/recent/websub and removes from
      // channels:active. Don't delete the device profile — the user
      // may re-subscribe later and we want to preserve their settings.
      await cleanupDeadChannel(channelId, env, 'unsubscribe_last');
    })());
  }

  return json({ ok: true });
}

// ─── POST /seen ─────────────────────────────────────────────────────────

async function handleSeen(request, env) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Missing Authorization: Bearer <device-id>', 401);

  let body;
  try { body = await request.json(); } catch { return errorResponse('Invalid JSON body'); }

  const { channelId, videoIds, clearAll } = body;
  if (!channelId) return errorResponse('channelId is required');
  if (!clearAll && !Array.isArray(videoIds)) return errorResponse('Provide videoIds array or clearAll: true');

  const existingState = await getKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId));
  // IMPORTANT: create a NEW object, not a reference to existingState.
  // putKVIfChanged compares state vs existingState — if they're the same
  // object reference, jsonEqual returns true and the write is silently
  // skipped, even though we mutated state.unwatched in-place.
  const state = existingState
    ? { ...existingState, unwatched: [...(existingState.unwatched || [])] }
    : { unwatched: [], lastNagAt: null, nagCount: 0 };

  if (clearAll) {
    state.unwatched = [];
  } else {
    const removeSet = new Set(videoIds);
    state.unwatched = (state.unwatched || []).filter((id) => !removeSet.has(id));
  }

  // Reset nag counters when all items are seen, so the next unread item
  // starts fresh nag cadence (e.g. 5-min relentless resets to 5-min, not
  // backed-off 15-min from stale nagCount).
  if (state.unwatched.length === 0) {
    state.nagCount = 0;
    state.lastNagAt = null;
  }

  await putKVIfChanged(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId), state, existingState);

  // Nag counters are reset when unwatched becomes empty, so the next
  // unread item starts a fresh nag cadence.

  // Remove from nag:active when unwatched becomes empty
  if (state.unwatched.length === 0) {
    const nagActive = await getKV(env.TUBEPULSE_KV, key.nagActive()) || [];
    const entry = `${deviceId}|${channelId}`;
    const filtered = nagActive.filter((e) => e !== entry);
    if (filtered.length !== nagActive.length) {
      await putKV(env.TUBEPULSE_KV, key.nagActive(), filtered);
    }
  }

  return json({ ok: true, unwatchedCount: state.unwatched.length });
}

// ─── GET /feed ──────────────────────────────────────────────────────────

/**
 * Fetch the recent posts for a channel to include in the /feed
 * response, respecting both the global `includeCommunityPosts` setting
 * and the per-channel override. Returns an empty array if the feature
 * is disabled at both levels.
 *
 * @param {string} channelId
 * @param {string} deviceId
 * @param {boolean} globalInclude — global setting from deviceSettings
 * @param {boolean} communityPostsEnabled
 * @returns {Promise<Array>}
 */
async function getFeedPostsForChannel(env, channelId, deviceId, globalInclude, communityPostsEnabled) {
  if (!communityPostsEnabled) return [];

  // Per-channel override takes precedence. If the user has explicitly
  // set it (true or false), use that. Otherwise fall back to the global.
  const override = await getKV(env.TUBEPULSE_KV, key.deviceOverride(deviceId, channelId));
  const overrideValue = override?.includeCommunityPosts;
  let posts;
  if (overrideValue === true) posts = await getKV(env.TUBEPULSE_KV, key.channelRecentPosts(channelId)) || [];
  else if (overrideValue === false) posts = [];
  else if (!globalInclude) posts = [];
  else posts = await getKV(env.TUBEPULSE_KV, key.channelRecentPosts(channelId)) || [];

  // Mark each post as unwatched based on the device's state. Post
  // activityIds are namespaced with "post:" in the shared unwatched
  // list so they don't collide with video IDs.
  if (posts.length === 0) return posts;
  const state = await getKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId));
  const unwatched = state?.unwatched || [];
  return posts.map((p) => ({
    ...p,
    unwatched: unwatched.includes(`post:${p.activityId}`),
  }));
}

async function handleFeed(request, env) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Missing Authorization: Bearer <device-id>', 401);

  const deviceSettings = await getKV(env.TUBEPULSE_KV, key.deviceSettings(deviceId)) || {};
  const globalIncludePosts = !!deviceSettings.includeCommunityPosts;
  const communityPostsEnabled = isCommunityPostsEnabled(env);

  const profile = await getKV(env.TUBEPULSE_KV, key.deviceProfile(deviceId));
  if (!profile) return errorResponse('Device not registered', 404);

  const channels = await getKV(env.TUBEPULSE_KV, key.deviceChannels(deviceId)) || [];

  // Fetch meta, recent, and per-device state for each channel
  const channelData = await Promise.all(channels.map(async (channelId) => {
    const [meta, recent, state] = await Promise.all([
      getKV(env.TUBEPULSE_KV, key.channelMeta(channelId)),
      getKV(env.TUBEPULSE_KV, key.channelRecent(channelId)),
      getKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId)),
    ]);

    const unwatched = state?.unwatched || [];
    const videos = (recent || []).map((v) => ({
      ...v,
      unwatched: unwatched.includes(v.videoId),
    }));

    // Posts are feature-gated independently of user settings so stale
    // post cache cannot leak into /feed while the worker contract is off.
    const posts = await getFeedPostsForChannel(env, channelId, deviceId, globalIncludePosts, communityPostsEnabled);

    return {
      channelId,
      meta: meta || { name: channelId },
      videos,
      posts,
      unwatchedCount: unwatched.length,
    };
  }));

  return json({ channels: channelData });
}

// ─── GET /resolve ───────────────────────────────────────────────────────

async function handleResolve(request, env) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Authentication required', 401);

  const profile = await getKV(env.TUBEPULSE_KV, key.deviceProfile(deviceId));
  if (!profile) return errorResponse('Device not registered', 404);

  const url = new URL(request.url);
  const handle = url.searchParams.get('handle');
  const channelId = url.searchParams.get('channelId');

  if (!handle && !channelId) return errorResponse('Provide ?handle=@handle or ?channelId=UC...', 400);
  if (!env.YOUTUBE_API_KEY) return errorResponse('Server misconfigured — missing API key', 500);

  // Check handle cache first (7-day TTL)
  if (handle) {
    const cached = await getKV(env.TUBEPULSE_KV, key.handle(handle.toLowerCase()));
    if (cached && cached.cachedAt > Date.now() - 7 * 86400 * 1000) {
      return json(cached, 200, { 'Cache-Control': 'public, max-age=3600' });
    }
  }

  try {
    let result;
    if (channelId) {
      result = await resolveChannelViaAPI(env.YOUTUBE_API_KEY, channelId);
    } else {
      result = await resolveHandleViaAPI(env.YOUTUBE_API_KEY, handle);
    }

    if (!result) return errorResponse('Channel not found', 404);

    // Cache handle resolution
    if (handle && result.channelId) {
      await putKV(env.TUBEPULSE_KV, key.handle(handle.toLowerCase()), {
        ...result,
        cachedAt: Date.now(),
      });
    }

    return json(result, 200, { 'Cache-Control': 'public, max-age=3600' });
  } catch (err) {
    console.error('Resolver error:', err);
    return errorResponse('Internal error', 500);
  }
}

// ─── POST /bootstrap ────────────────────────────────────────────────────

async function handleBootstrap(request, env, ctx) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Authentication required', 401);

  const profile = await getKV(env.TUBEPULSE_KV, key.deviceProfile(deviceId));
  if (!profile) return errorResponse('Device not registered', 404);

  let body;
  try { body = await request.json(); } catch { return errorResponse('Invalid JSON body'); }

  const { channelId } = body;
  if (!channelId) return errorResponse('channelId is required');

  // Verify this device tracks this channel
  const channels = await getKV(env.TUBEPULSE_KV, key.deviceChannels(deviceId)) || [];
  if (!channels.includes(channelId)) return errorResponse('Channel not tracked by this device', 404);

  const callbackUrl = `${new URL(request.url).origin}/websub`;

  // Fetch or repair avatar metadata. A prior transient failure may have
  // persisted a usable meta record whose avatarUrl is null.
  let meta = await getKV(env.TUBEPULSE_KV, key.channelMeta(channelId));
  meta = await ensureChannelAvatar(env, channelId, meta, 'Bootstrap');

  // Bootstrap structurally from the uploads playlist; never consume the
  // scarce search.list bucket and never depend on RSS health.
  let recent = await getKV(env.TUBEPULSE_KV, key.channelRecent(channelId));
  if (!recent) {
    if (env.YOUTUBE_API_KEY) {
      try {
        const apiVideos = await fetchRecentVideosViaAPI(env.YOUTUBE_API_KEY, channelId);
        if (apiVideos && apiVideos.length > 0) {
          // Enrich public statistics in a single batched call (1 quota unit).
          const statistics = await fetchVideoStatistics(env.YOUTUBE_API_KEY, apiVideos.map((v) => v.videoId)) || {};
          const checkedHour = Math.floor(Date.now() / 3600000);
          recent = apiVideos.map((v) => {
            const metrics = statistics[v.videoId] || {};
            return {
              ...v,
              views: metrics.views ?? null,
              likes: metrics.likes ?? null,
              dislikes: metrics.dislikes ?? null,
              viewsLastCheckedHour: checkedHour,
              likesLastCheckedHour: checkedHour,
            };
          });
          if (meta) meta.lastVideoId = apiVideos[0].videoId;
          await putKV(env.TUBEPULSE_KV, key.channelMeta(channelId), meta || {
            name: channelId,
            avatarUrl: null,
            lastVideoId: apiVideos[0].videoId,
            addedAt: Date.now(),
          });
          await putKV(env.TUBEPULSE_KV, key.channelRecent(channelId), recent);
        }
      } catch (e) {
        console.warn(`[Bootstrap] Data API uploads bootstrap failed for ${channelId}:`, e.message);
      }
    }
  }

  // Subscribe to WebSub (async)
  ctx.waitUntil((async () => {
    const webSubDisabled = String(env.TUBEPULSE_DISABLE_WEBSUB || '').toLowerCase() === 'true';
    const subState = webSubDisabled ? null : await getKV(env.TUBEPULSE_KV, key.channelWebsub(channelId));
    if (!webSubDisabled && !subState) {
      const secret = crypto.randomUUID();
      const success = await subscribeToChannel(channelId, callbackUrl, secret);
      if (success) {
        await putKV(env.TUBEPULSE_KV, key.channelWebsub(channelId), {
          leaseExpiresAt: Date.now() + 86400 * 5 * 1000,
          hmacSecret: secret,
          lastVerified: Date.now(),
        });

        // Ensure in active index
        const active = await getKV(env.TUBEPULSE_KV, key.channelsActive()) || [];
        if (!active.includes(channelId)) {
          active.push(channelId);
          await putKV(env.TUBEPULSE_KV, key.channelsActive(), active);
        }
      }
    }
  })());

  return json({
    ok: true,
    channelId,
    name: meta?.name || channelId,
    avatar: meta?.avatarUrl || null,
    videos: recent || [],
  });
}

// ─── POST /settings ─────────────────────────────────────────────────────

async function handleSettings(request, env) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Missing Authorization: Bearer <device-id>', 401);

  let body;
  try { body = await request.json(); } catch { return errorResponse('Invalid JSON body'); }

  const { settings } = body;
  if (!settings) return errorResponse('settings is required');

  await putKVIfChanged(env.TUBEPULSE_KV, key.deviceSettings(deviceId), settings);
  return json({ ok: true });
}

// ─── POST /channel-override ─────────────────────────────────────────────

async function handleChannelOverride(request, env) {
  const deviceId = getDeviceId(request);
  if (!deviceId) return errorResponse('Missing Authorization: Bearer <device-id>', 401);

  let body;
  try { body = await request.json(); } catch { return errorResponse('Invalid JSON body'); }

  const { channelId, override } = body;
  if (!channelId) return errorResponse('channelId is required');

  const overrideKey = key.deviceOverride(deviceId, channelId);

  // Empty override → delete the key (inherit from device-level settings)
  if (!override || Object.keys(override).length === 0) {
    await deleteKVIfExists(env.TUBEPULSE_KV, overrideKey);
    return json({ ok: true, deleted: true });
  }

  await putKVIfChanged(env.TUBEPULSE_KV, overrideKey, override);
  return json({ ok: true });
}

// ─── GET /websub — Verification handshake ──────────────────────────────

async function handleWebSubVerification(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const topic = url.searchParams.get('hub.topic');
  const challenge = url.searchParams.get('hub.challenge');
  const leaseSeconds = url.searchParams.get('hub.lease_seconds');

  if (!mode || !topic || !challenge) {
    return new Response('Missing parameters', { status: 400 });
  }

  const channelIdMatch = topic.match(/channel_id=([A-Za-z0-9_-]+)/);
  const channelId = channelIdMatch ? channelIdMatch[1] : null;

  if (!channelId) return new Response('Invalid topic', { status: 400 });

  // During unified-Home ownership, retain protocol compatibility with any
  // already-issued hub verification request without renewing or mutating the
  // canonical WebSub lease record. Push delivery is acknowledged and ignored
  // by the authority wrapper; five-minute Home polling is authoritative.
  if (String(env.TUBEPULSE_DISABLE_WEBSUB || '').toLowerCase() === 'true') {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  // Verify we have a subscription for this channel
  const subState = await getKV(env.TUBEPULSE_KV, key.channelWebsub(channelId));
  if (!subState) {
    console.warn(`[WebSub] Verification for unknown channel: ${channelId}`);
    return new Response('Unknown subscription', { status: 404 });
  }

  if (mode === 'subscribe') {
    const leaseMs = leaseSeconds ? parseInt(leaseSeconds) * 1000 : 86400 * 5 * 1000;
    subState.leaseExpiresAt = Date.now() + leaseMs;
    subState.lastVerified = Date.now();
    await putKV(env.TUBEPULSE_KV, key.channelWebsub(channelId), subState);
    console.log(`[WebSub] Subscribed to ${channelId}, lease: ${leaseSeconds}s`);
  } else if (mode === 'unsubscribe') {
    await env.TUBEPULSE_KV.delete(key.channelWebsub(channelId));
    console.log(`[WebSub] Unsubscribed from ${channelId}`);
  }

  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

// ─── POST /websub — Push from YouTube ──────────────────────────────────

async function handleWebSubPush(request, env, ctx) {
  const signature = request.headers.get('X-Hub-Signature');

  let xmlText;
  try { xmlText = await request.text(); } catch { return new Response('Bad request', { status: 400 }); }

  // Quick-extract channelId for HMAC verification
  const quickChannelId = xmlText.match(/<yt:channelId>([^<]+)<\/yt:channelId>/)?.[1];

  if (quickChannelId && signature) {
    const subState = await getKV(env.TUBEPULSE_KV, key.channelWebsub(quickChannelId));
    if (subState?.hmacSecret) {
      const valid = await verifyWebSubSignature(xmlText, signature, subState.hmacSecret);
      if (!valid) {
        console.warn(`[WebSub] Invalid signature for ${quickChannelId} — rejecting`);
        return new Response('Forbidden', { status: 403 });
      }
    }
  }

  const parsed = parseWebSubPush(xmlText);
  if (!parsed.channelId || parsed.entries.length === 0) {
    return new Response('OK', { status: 200 });
  }

  const channelId = parsed.channelId;
  const channelName = parsed.channelName;

  // Process in background
  ctx.waitUntil((async () => {
    try {
    // Step 1: Update channel recent list
    const prevRecent = await getKV(env.TUBEPULSE_KV, key.channelRecent(channelId)) || [];
    const prevVideoIds = new Set(prevRecent.map((v) => v.videoId));

    const newEntries = [];
    const checkedHour = Math.floor(Date.now() / 3600000);
    for (const entry of parsed.entries) {
      if (!prevVideoIds.has(entry.videoId)) {
        newEntries.push({
          videoId: entry.videoId,
          title: entry.title,
          publishedAt: entry.published,
          thumbnail: entry.thumbnail,
          type: classifyVideo(entry),
          link: entry.link,
          // Preserve metrics present in the push. Missing/hidden optional
          // counts remain null until an RSS poll can expose them.
          views: entry.views ?? null,
          likes: entry.likes ?? null,
          dislikes: entry.dislikes ?? null,
          viewsLastCheckedHour: checkedHour,
          likesLastCheckedHour: checkedHour,
        });
      }
    }

    if (newEntries.length > 0) {
      // Prepend new entries, trim to 15
      const updatedRecent = [...newEntries, ...prevRecent].slice(0, 15);
      await putKV(env.TUBEPULSE_KV, key.channelRecent(channelId), updatedRecent);

      // Update meta
      const meta = await getKV(env.TUBEPULSE_KV, key.channelMeta(channelId)) || {};
      meta.name = channelName || meta.name || channelId;
      meta.lastVideoId = newEntries[0].videoId;
      await putKV(env.TUBEPULSE_KV, key.channelMeta(channelId), meta);
    } else {
      // Duplicate push — update meta name only if we didn't have it
      const meta = await getKV(env.TUBEPULSE_KV, key.channelMeta(channelId)) || {};
      if (!meta.name && channelName) {
        meta.name = channelName;
        await putKV(env.TUBEPULSE_KV, key.channelMeta(channelId), meta);
      }
      return; // No new videos
    }

    // Step 2: Get subscribers
    const subs = await getKV(env.TUBEPULSE_KV, key.channelSubs(channelId)) || [];
    if (subs.length === 0) return;

    // Step 3: Get FCM access token
    let accessToken;
    try {
      accessToken = await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
    } catch (err) {
      console.error('[WebSub] Failed to get FCM access token:', err);
      return;
    }

    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    const projectId = sa.project_id;

    // Step 4: For each subscriber, send notification + update state.
    // Nag scheduling is handled by the cron worker's runNagCron (timestamp-based).
    for (const deviceId of subs) {
      // Read profile + settings + override
      const [deviceProfile, deviceSettings, deviceOverride] = await Promise.all([
        getKV(env.TUBEPULSE_KV, key.deviceProfile(deviceId)),
        getKV(env.TUBEPULSE_KV, key.deviceSettings(deviceId)),
        getKV(env.TUBEPULSE_KV, key.deviceOverride(deviceId, channelId)),
      ]);

      if (!deviceProfile?.fcmToken) continue;

      // Resolve effective settings
      const effective = {
        mode: deviceOverride?.mode || deviceSettings?.mode || 'chill',
        nagInterval: deviceOverride?.nagInterval || deviceSettings?.nagInterval || 15,
        dndEnabled: deviceSettings?.dndEnabled || false,
        dndStart: deviceSettings?.dndStart || '22:00',
        dndEnd: deviceSettings?.dndEnd || '07:00',
        dndTimezone: deviceSettings?.dndTimezone || 'UTC',
        dndBypass: deviceOverride?.dndBypass || false,
        muted: deviceOverride?.muted || false,
        tapAction: deviceSettings?.tapAction || 'video',
      };

      if (effective.muted) continue;

      // Get current per-device state for this channel
      const state = await getKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId)) || {
        unwatched: [],
        lastNagAt: null,
        nagCount: 0,
      };

      const fcmToken = deviceProfile.fcmToken;
      let shouldNotify = true;

      for (const entry of newEntries) {
        // Add to unwatched
        if (!state.unwatched.includes(entry.videoId)) {
          state.unwatched.push(entry.videoId);
        }

        if (entry.type === 'live_scheduled') {
          // v3.1: no bucket writes. Prewarn is fired by the cron's
          // runPrewarnCron at the user's preferred prewarn time
          // (driven by the upcoming:events:list, not by a
          // hardcoded 30-min bucket). At live time the video is
          // re-detected as type 'live' below and added to
          // channelRecent as a normal new video — no separate
          // "live now!" push.
          const publishedTime = new Date(entry.publishedAt).getTime();

          // Append to the global scheduled-events list so the
          // cron's runPrewarnCron can iterate and fire per-device
          // prewarns. Idempotent — skip if this videoId is already
          // in the list.
          const events = await getKV(env.TUBEPULSE_KV, key.upcomingEvents()) || [];
          if (!events.some((e) => e.videoId === entry.videoId)) {
            events.push({
              channelId,
              videoId: entry.videoId,
              scheduledFor: publishedTime,
              addedAt: Date.now(),
            });
            await putKV(env.TUBEPULSE_KV, key.upcomingEvents(), events);
          }

          // Don't send immediate notification for scheduled events
          continue;
        }

        // Non-scheduled: check DND
        const dndActive = effective.dndEnabled && isDndActive(effective.dndStart, effective.dndEnd, effective.dndTimezone);
        const isLivestream = entry.type === 'live';
        const bypassesDnd = effective.dndBypass || isLivestream;

        if (dndActive && !bypassesDnd) {
          // Schedule a nag for when DND ends
          shouldNotify = false;
          // We'll rely on the nag cycle to deliver when DND lifts
        }
      }

      // Save updated state
      await putKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId), state);

      // Add to nag:active when unwatched items are added
      if (state.unwatched.length > 0) {
        const nagActive = await getKV(env.TUBEPULSE_KV, key.nagActive()) || [];
        const entry = `${deviceId}|${channelId}`;
        if (!nagActive.includes(entry)) {
          nagActive.push(entry);
          await putKV(env.TUBEPULSE_KV, key.nagActive(), nagActive);
        }
      }

      // Send FCM notification for non-scheduled, non-DND-blocked new videos
      const notifyEntries = newEntries.filter((e) =>
        e.type !== 'live_scheduled' && shouldNotify
      );

      if (notifyEntries.length > 0) {
        // Compose notification
        let notifPayload;
        if (notifyEntries.length === 1) {
          const entry = notifyEntries[0];
          notifPayload = {
            title: `${channelName || channelId} uploaded`,
            body: entry.title,
            data: {
              videoId: entry.videoId,
              channelId,
              channelName: channelName || channelId,
              videoLink: entry.link,
              type: entry.type,
              tapAction: String(effective.tapAction),
            },
            tag: `video-${entry.videoId}`,
          };
        } else {
          // Multiple new videos — batch
          notifPayload = {
            title: `${channelName || channelId} — ${notifyEntries.length} new videos`,
            body: notifyEntries.map((e) => e.title).join('\n'),
            data: {
              type: 'batch',
              count: String(notifyEntries.length),
              channelId,
              contentIds: JSON.stringify(notifyEntries.map((entry) => entry.videoId)),
              tapAction: String(effective.tapAction),
            },
            tag: 'tubepulse-batch',
          };
        }

        const result = await sendFCMPush(
          accessToken, projectId, fcmToken, notifPayload, deviceProfile.notificationCapability,
        );

        if (result.sent) {
          // Initialise the nag clock so runNagCron doesn't immediately
          // re-notify on the next 5-min tick.
          state.lastNagAt = Date.now();
          await putKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId), state);
        }

        if (result.deadToken) {
          // FCM has confirmed the device is gone (UNREGISTERED). Run the
          // full cleanup: remove from every channel's subscribers, clean
          // up any channel that goes empty, delete the device's profile.
          // We do this in ctx.waitUntil so the response to the hub isn't
          // blocked on the cleanup work.
          console.log(`[WebSub] Pruning dead token: ${deviceId}`);
          ctx.waitUntil(cleanupDeadDevice(deviceId, env, 'fcm_unregistered'));
        }
      }


    }
    } catch (err) {
      console.error('[WebSub] waitUntil CRASHED:', err && err.stack || err);
    }
  })());

  return new Response('OK', { status: 200 });
}

// ─── Main handler ───────────────────────────────────────────────────────

export const appWorker = {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // WebSub
      if (path === '/websub' && request.method === 'GET') {
        return await handleWebSubVerification(request, env);
      }
      if (path === '/websub' && request.method === 'POST') {
        return await handleWebSubPush(request, env, ctx);
      }

      // App routes
      if (path === '/register' && request.method === 'POST') {
        return await handleRegister(request, env);
      }
      if (path === '/subscribe-channel' && request.method === 'POST') {
        return await handleSubscribeChannel(request, env, ctx);
      }
      if (path === '/unsubscribe' && request.method === 'POST') {
        return await handleUnsubscribe(request, env, ctx);
      }
      if (path === '/seen' && request.method === 'POST') {
        return await handleSeen(request, env);
      }
      if (path === '/feed' && request.method === 'GET') {
        return await handleFeed(request, env);
      }
      if (path === '/resolve' && request.method === 'GET') {
        return await handleResolve(request, env);
      }
      if (path === '/bootstrap' && request.method === 'POST') {
        return await handleBootstrap(request, env, ctx);
      }
      if (path === '/settings' && request.method === 'POST') {
        return await handleSettings(request, env);
      }
      if (path === '/channel-override' && request.method === 'POST') {
        return await handleChannelOverride(request, env);
      }
      if (path === '/_tubepulse/activity-touch' && request.method === 'POST') {
        return await handleInternalActivityTouch(request, env);
      }

      if (path === '/' && request.method === 'GET') {
        return json({ status: 'ok', version: '3.0.0', worker: 'tubepulse-api', architecture: 'channel-first' });
      }

      return errorResponse('Not found', 404);
    } catch (err) {
      console.error('Unhandled error:', err);
      return errorResponse('Internal server error', 500);
    }
  },
};

// The authority wrapper is byte-for-behaviour transparent unless its explicit
// production latch is enabled. Keep the legacy read gateway inside it so an
// authority rollout can disable Home reads while retaining signed mutation
// ingress and the canonical Cloudflare API contract.
export default createAuthorityWorker(createGatewayWorker(appWorker));
