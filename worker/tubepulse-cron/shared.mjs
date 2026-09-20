// shared.mjs — shared helpers for TubePulse shard workers.
// Extracted from the original tubepulse-cron/index.js to allow each
// shard worker to import only what it needs.

// ─── Key builders ───────────────────────────────────────────────────────

export const key = {
  channelMeta:        (channelId) => `channel:${channelId}:meta`,
  channelSubs:        (channelId) => `channel:${channelId}:subscribers`,
  channelWebsub:      (channelId) => `channel:${channelId}:websub`,
  channelRecent:      (channelId) => `channel:${channelId}:recent`,
  channelRecentPosts: (channelId) => `channel:${channelId}:recent:posts`,
  firstPollAtPosts:   (channelId) => `channel:${channelId}:firstPollAt:posts`,
  channelKnownPosts:  (channelId) => `channel:${channelId}:known:posts`,
  channelKnownVideos: (channelId) => `channel:${channelId}:known:videos`,
  deviceProfile:      (deviceId)  => `device:${deviceId}:profile`,
  deviceSettings:     (deviceId)  => `device:${deviceId}:settings`,
  deviceChannels:     (deviceId)  => `device:${deviceId}:channels`,
  deviceOverride:     (deviceId, channelId) => `device:${deviceId}:override:${channelId}`,
  deviceState:        (deviceId, channelId) => `device:${deviceId}:state:${channelId}`,
  fcmLookup:          (fcmToken)  => `fcm:lookup:${fcmToken}`,
  upcoming:           (bucket)    => `upcoming:${bucket}`,
  nag:               (bucket)    => `nag:${bucket}`,
  channelsActive:    ()          => `channels:active`,
  handle:            (lc)        => `handle:${lc}`,
  upcomingEvents:    ()          => `upcoming:events:list`,
  prewarnSent:       (videoId, deviceId) => `upcoming:prewarn:${videoId}:${deviceId}`,
  // New keys for sharded architecture
  nagActive:         ()          => `nag:active`,
  fcmTokenCache:     ()          => `fcm:cache:token`,
};

// ─── Constants ──────────────────────────────────────────────────────────

export const KNOWN_COMMUNITY_POST_LIMIT = 20;
export const KNOWN_VIDEO_LIMIT = 500;
export const RELENTLESS_5M_BACKOFF_THRESHOLD = 12; // 12 × 5min = 1 hour
const FCM_TOKEN_CACHE_TTL_MS = 50 * 60 * 1000; // 50 minutes (access tokens last 60min)
const FCM_TOKEN_CACHE_MARGIN_MS = 5 * 60 * 1000; // refresh 5min before expiry

// ─── KV helpers ─────────────────────────────────────────────────────────

export async function getKV(kv, k) { return await kv.get(k, 'json'); }
export async function putKV(kv, k, value) { await kv.put(k, JSON.stringify(value)); }

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

export function jsonEqual(a, b) {
  return stableJson(a) === stableJson(b);
}

export async function putKVIfChanged(kv, k, value, existingValue) {
  const existing = arguments.length >= 4 ? existingValue : await getKV(kv, k);
  if (jsonEqual(existing, value)) return false;
  await putKV(kv, k, value);
  return true;
}

// ─── Stable sort ────────────────────────────────────────────────────────

export function stableSort(arr) {
  return [...arr].sort();
}

// Time-derived work selection keeps shard workers stateless. These helpers
// are shared with focused tests so cadence/config drift cannot strand channels.
export function selectRssShardWork(activeChannels, shardIndex, maxShards, minuteSlot) {
  const channels = stableSort(activeChannels || []);
  if (channels.length === 0) return null;

  const activeShardCount = Math.min(maxShards, Math.max(1, Math.ceil(channels.length / 5)));
  if (shardIndex < 0 || shardIndex >= activeShardCount) return null;

  const shardChannels = channels.filter((_, index) => index % activeShardCount === shardIndex);
  if (shardChannels.length === 0) return null;

  return {
    activeShardCount,
    channelId: shardChannels[minuteSlot % shardChannels.length],
  };
}

export function selectCommunityPostWork(eligibleChannels, minuteSlot) {
  const channels = stableSort(eligibleChannels || []);
  if (channels.length === 0) return null;

  const stepMinutes = Math.max(3, Math.floor(60 / channels.length));
  const channelIndex = Math.floor(minuteSlot / stepMinutes) % channels.length;
  return {
    channelId: channels[channelIndex],
    channelIndex,
    channelCount: channels.length,
    stepMinutes,
  };
}

// ─── DND logic ──────────────────────────────────────────────────────────

export function isDndActive(dndStart, dndEnd, timezone = 'UTC') {
  const [sh, sm] = dndStart.split(':').map(Number);
  const [eh, em] = dndEnd.split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;

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

// ─── Video classification ───────────────────────────────────────────────

export function classifyVideo(entry, now = Date.now()) {
  if (!entry.published && !entry.publishedAt) return 'video';
  const publishedTime = new Date(entry.published || entry.publishedAt).getTime();
  if (publishedTime > now + 5 * 60 * 1000) return 'live_scheduled';
  const title = (entry.title || '').toLowerCase();
  if (title.startsWith('🔴') || title.includes(' live')) return 'live';
  return 'video';
}

// ─── RSS parsing ────────────────────────────────────────────────────────

export function parseRSSFeed(xmlText) {
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
    const viewsMatch = e.match(/<media:statistics[^>]*views="(\d+)"/);
    const views = viewsMatch ? viewsMatch[1] : '0';
    const likesMatch = e.match(/<media:starRating[^>]*count="(\d+)"/);
    const likes = likesMatch ? likesMatch[1] : null;
    let dislikes = null;
    const dislAttrMatch = e.match(/<media:statistics[^>]*dislikes="(\d+)"/);
    if (dislAttrMatch) dislikes = dislAttrMatch[1];

    if (videoId) {
      entries.push({ videoId, title, link, published, updated, thumbnail, description, views, likes, dislikes });
    }
  }

  const channelId = xmlText.match(/<yt:channelId>([^<]+)<\/yt:channelId>/)?.[1];
  const channelName = xmlText.match(/<name>([^<]+)<\/name>/)?.[1];

  return { channelId, channelName, entries };
}

// ─── RSS recent-video persistence ────────────────────────────────────────

const RSS_METRIC_REFRESH_THRESHOLD = 0.25;
const RSS_METRIC_FORCE_REFRESH_HOURS = 24;

function metricChangedBeyondThreshold(persistedValue, rssValue) {
  if (rssValue === undefined || rssValue === null) return false;
  const persisted = Number(persistedValue ?? 0);
  const current = Number(rssValue);
  if (!Number.isFinite(persisted) || !Number.isFinite(current)) return false;
  return Math.abs(current - persisted) / Math.max(Math.abs(persisted), 1) > RSS_METRIC_REFRESH_THRESHOLD;
}

function shouldPersistMetricGroup(lastCheckedHour, currentHour, metricPairs) {
  const normalizedLastCheckedHour = Number(lastCheckedHour);
  const missingLastCheckedHour = lastCheckedHour === undefined || lastCheckedHour === null
    || !Number.isFinite(normalizedLastCheckedHour);
  const differentHour = missingLastCheckedHour || normalizedLastCheckedHour !== currentHour;
  const stale = missingLastCheckedHour
    || currentHour - normalizedLastCheckedHour >= RSS_METRIC_FORCE_REFRESH_HOURS;
  return differentHour && (
    stale || metricPairs.some(([persistedValue, rssValue]) => (
      metricChangedBeyondThreshold(persistedValue, rssValue)
    ))
  );
}

function currentMetricValue(rssValue, persistedValue) {
  if (rssValue !== undefined && rssValue !== null) return String(rssValue);
  if (persistedValue !== undefined && persistedValue !== null) return persistedValue;
  return '0';
}

function copyPersistedMetricFields(target, cached) {
  for (const field of [
    'views', 'likes', 'dislikes', 'viewsLastCheckedHour', 'likesLastCheckedHour',
  ]) {
    if (Object.prototype.hasOwnProperty.call(cached, field)) target[field] = cached[field];
  }
}

/**
 * Merge the current RSS ordering/structure with persisted metrics.
 * Only the latest existing entry is eligible for a metric refresh; new entries
 * are seeded from RSS. `nowMs` is explicit so this helper remains deterministic.
 */
export function mergeRssUploadsIntoRecentVideos(cachedRecent, rssUploads, nowMs) {
  const currentHour = Math.floor(nowMs / 3600000);
  const cachedByVideoId = new Map((cachedRecent || []).map((video) => [video.videoId, video]));

  return (rssUploads || []).slice(0, 15).map((upload, index) => {
    const merged = {
      videoId: upload.videoId,
      title: upload.title,
      publishedAt: upload.published,
      thumbnail: upload.thumbnail,
      type: classifyVideo(upload, nowMs),
      link: upload.link,
    };
    const cached = cachedByVideoId.get(upload.videoId);

    if (!cached) {
      return {
        ...merged,
        views: currentMetricValue(upload.views),
        likes: currentMetricValue(upload.likes),
        dislikes: currentMetricValue(upload.dislikes),
        viewsLastCheckedHour: currentHour,
        likesLastCheckedHour: currentHour,
      };
    }

    copyPersistedMetricFields(merged, cached);
    if (index !== 0) return merged;

    if (shouldPersistMetricGroup(cached.viewsLastCheckedHour, currentHour, [
      [cached.views, upload.views],
    ])) {
      merged.views = currentMetricValue(upload.views, cached.views);
      merged.viewsLastCheckedHour = currentHour;
    }

    if (shouldPersistMetricGroup(cached.likesLastCheckedHour, currentHour, [
      [cached.likes, upload.likes],
      [cached.dislikes, upload.dislikes],
    ])) {
      merged.likes = currentMetricValue(upload.likes, cached.likes);
      merged.dislikes = currentMetricValue(upload.dislikes, cached.dislikes);
      merged.likesLastCheckedHour = currentHour;
    }

    return merged;
  });
}

export async function fetchChannelRSS(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(feedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Cookie': 'SOCS=CAESEwgDEgk2MTcxNTcyNjAaAmVuIAEaBgiA_LyaBg; CONSENT=YES+cb',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'application/atom+xml,application/xml,text/xml,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    if (!resp.ok) {
      console.warn(`[RSS] HTTP ${resp.status} for ${channelId}`);
      return null;
    }
    const xml = await resp.text();
    return parseRSSFeed(xml);
  } catch (err) {
    console.error(`[RSS] fetch error for ${channelId}:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── FCM access token with KV caching ───────────────────────────────────

export async function getGoogleAccessToken(serviceAccountJson) {
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

  let pemBody = sa.private_key
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');

  while (pemBody.length % 4 !== 0) pemBody += '=';

  const binaryStr = atob(pemBody);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(input)
  );

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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
  return { token: tokenData.access_token, expiresAt: Date.now() + FCM_TOKEN_CACHE_TTL_MS };
}

/**
 * Get a cached FCM access token from KV, or mint a new one and cache it.
 * Never prints token contents.
 */
export async function getCachedFcmAccessToken(env) {
  const kv = env.TUBEPULSE_KV;
  const cached = await getKV(kv, key.fcmTokenCache());
  const now = Date.now();
  if (cached && cached.expiresAt && cached.expiresAt > now + FCM_TOKEN_CACHE_MARGIN_MS) {
    return cached.token;
  }
  // Mint fresh token
  const { token, expiresAt } = await getGoogleAccessToken(env.FIREBASE_SERVICE_ACCOUNT);
  // Cache in KV with TTL (Cloudflare KV put supports expirationTtl in seconds)
  const ttlSeconds = Math.ceil((expiresAt - now - FCM_TOKEN_CACHE_MARGIN_MS) / 1000);
  if (ttlSeconds > 30) {
    await kv.put(key.fcmTokenCache(), JSON.stringify({ token, expiresAt }), { expirationTtl: ttlSeconds });
  }
  return token;
}

// ─── FCM push ──────────────────────────────────────────────────────────

export async function sendFCMPush(accessToken, projectId, fcmToken, payload) {
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const notification = payload.notification || {};
  const title = payload.title ?? notification.title ?? 'TubePulse';
  const body = payload.body ?? notification.body ?? '';

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        notification: { title, body },
        data: payload.data,
        android: {
          priority: 'high',
          notification: {
            channel_id: payload.silent ? 'new-videos-silent' : 'new-videos',
            sound: payload.silent ? null : 'default',
            tag: payload.tag || 'tubepulse',
          },
        },
      },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    const errSummary = errText.length > 300 ? `${errText.slice(0, 300)}...` : errText;
    console.error(`FCM push failed: ${resp.status} ${errSummary}`);
    if (resp.status === 404 || errText.includes('UNREGISTERED') || errText.includes('NotRegistered')) {
      return { sent: false, deadToken: true, status: resp.status, error: errSummary };
    }
    return { sent: false, deadToken: false, status: resp.status, error: errSummary };
  }
  return { sent: true, deadToken: false };
}

// ─── Nag interval ───────────────────────────────────────────────────────

export function getNagIntervalMs(effective, state) {
  const mode = effective.mode || 'chill';
  if (mode === 'chill') {
    return 4 * 60 * 60 * 1000; // 4 hours
  }
  const configuredMinutes = Number(effective.nagInterval || 15);
  if (mode === 'relentless' && configuredMinutes === 5) {
    const nagCount = Number(state?.nagCount || 0);
    const activeMinutes = nagCount < RELENTLESS_5M_BACKOFF_THRESHOLD ? 5 : 15;
    return activeMinutes * 60 * 1000;
  }
  return configuredMinutes * 60 * 1000;
}

// ─── Cleanup helpers ────────────────────────────────────────────────────

export async function cleanupDeadChannel(channelId, env, reason = 'last_subscriber_dead') {
  const kv = env.TUBEPULSE_KV;
  await kv.delete(key.channelMeta(channelId));
  await kv.delete(key.channelRecent(channelId));
  await kv.delete(key.channelRecentPosts(channelId));
  await kv.delete(key.firstPollAtPosts(channelId));
  await kv.delete(key.channelKnownPosts(channelId));
  await kv.delete(key.channelWebsub(channelId));
  await kv.delete(key.channelSubs(channelId));
  const active = await getKV(kv, key.channelsActive()) || [];
  const filtered = active.filter((id) => id !== channelId);
  if (filtered.length !== active.length) {
    await putKV(kv, key.channelsActive(), filtered);
  }
  console.log(`[Cleanup] channel ${channelId}: reason=${reason}`);
}

export async function cleanupDeadDevice(deviceId, env, reason = 'fcm_unregistered') {
  const kv = env.TUBEPULSE_KV;
  const profile = await getKV(kv, key.deviceProfile(deviceId));
  const channels = await getKV(kv, key.deviceChannels(deviceId)) || [];
  let channelsCleaned = 0;

  for (const channelId of channels) {
    const subs = await getKV(kv, key.channelSubs(channelId)) || [];
    const filtered = subs.filter((id) => id !== deviceId);
    await putKV(kv, key.channelSubs(channelId), filtered);
    if (filtered.length === 0 && subs.length > 0) {
      await cleanupDeadChannel(channelId, env, 'last_subscriber_dead');
      channelsCleaned++;
    }
  }

  let devicesDeleted = 0;
  for (const k of [key.deviceProfile(deviceId), key.deviceSettings(deviceId), key.deviceChannels(deviceId)]) {
    await kv.delete(k);
    devicesDeleted++;
  }
  if (profile?.fcmToken) {
    await kv.delete(key.fcmLookup(profile.fcmToken));
  }
  for (const channelId of channels) {
    await kv.delete(key.deviceState(deviceId, channelId));
    await kv.delete(key.deviceOverride(deviceId, channelId));
    devicesDeleted += 2;
  }
  // Remove from nag:active
  await removeFromNagActive(env, deviceId);
  console.log(`[Cleanup] device ${deviceId}: reason=${reason} channelsAffected=${channels.length} channelsCleaned=${channelsCleaned} devicesDeleted=${devicesDeleted}`);
}

// ─── Nag active index ───────────────────────────────────────────────────

export async function addToNagActive(env, deviceId, channelId) {
  const kv = env.TUBEPULSE_KV;
  const entry = `${deviceId}|${channelId}`;
  const active = await getKV(kv, key.nagActive()) || [];
  if (active.includes(entry)) return;
  active.push(entry);
  await putKV(kv, key.nagActive(), active);
}

export async function removeFromNagActive(env, deviceId, channelId) {
  const kv = env.TUBEPULSE_KV;
  const entry = `${deviceId}|${channelId}`;
  const active = await getKV(kv, key.nagActive()) || [];
  const filtered = active.filter((e) => e !== entry);
  if (filtered.length !== active.length) {
    await putKV(kv, key.nagActive(), filtered);
  }
}

// ─── RSS known-video watermark helpers ──────────────────────────────────
//
// Separate notification memory from display cache. `channel:{id}:recent`
// shows the latest RSS entries; `channel:{id}:known:videos` remembers which
// IDs have been seen and the high-watermark publishedAt. A video is only
// notified if its ID is unknown AND its publishedAt is strictly greater
// than the channel's high-watermark. This prevents old videos exposed by
// deletions from re-notifying.

export function createEmptyKnownVideos(seedTimestamp) {
  return {
    ids: [],
    highWatermarkAt: null,
    highWatermarkIds: [],
    seededAt: seedTimestamp || new Date().toISOString(),
    updatedAt: seedTimestamp || new Date().toISOString(),
  };
}

export function seedKnownVideosFromRss(known, rssVideos, nowIso) {
  if (!known) known = createEmptyKnownVideos(nowIso);
  const timestamp = nowIso || new Date().toISOString();
  const ids = rssVideos.map((v) => v.videoId).filter(Boolean);
  const highWatermarkAt = ids.length > 0 ? maxPublishedAt(rssVideos) : known.highWatermarkAt;
  const highWatermarkIds = ids.length > 0 ? idsAtPublishedAt(rssVideos, highWatermarkAt) : known.highWatermarkIds;
  const nextKnown = {
    ids: boundKnownVideoIds(ids),
    highWatermarkAt,
    highWatermarkIds,
    seededAt: known?.seededAt || timestamp,
    updatedAt: timestamp,
  };
  // Seeding always counts as a semantic change (missing state is being seeded).
  return { nextKnown, changed: true };
}

export function classifyRssVideosForNotification(known, rssVideos) {
  if (!known || !known.highWatermarkAt) {
    return rssVideos.map((v) => ({ ...v, isNew: false, reason: 'no-watermark' }));
  }
  const knownIds = new Set(known.ids || []);
  const watermark = known.highWatermarkAt;
  return rssVideos.map((v) => {
    const published = v.published || v.publishedAt;
    if (!published) return { ...v, isNew: false, reason: 'missing-published' };
    if (knownIds.has(v.videoId)) return { ...v, isNew: false, reason: 'known-id' };
    if (new Date(published).getTime() <= new Date(watermark).getTime()) {
      return { ...v, isNew: false, reason: 'at-or-below-watermark' };
    }
    return { ...v, isNew: true, reason: 'above-watermark' };
  });
}

export function updateKnownVideosAfterPoll(known, rssVideos, notifiedVideos, nowIso) {
  const timestamp = nowIso || new Date().toISOString();
  const incomingIds = rssVideos.map((v) => v.videoId).filter(Boolean);
  const mergedIds = boundKnownVideoIds([...new Set([...incomingIds, ...(known?.ids || [])])]);

  let highWatermarkAt = known?.highWatermarkAt || null;
  let highWatermarkIds = known?.highWatermarkIds || [];
  const candidates = [...(notifiedVideos || []), ...rssVideos];
  const maxTs = maxPublishedAt(candidates);
  if (maxTs && (!highWatermarkAt || new Date(maxTs).getTime() > new Date(highWatermarkAt).getTime())) {
    highWatermarkAt = maxTs;
    highWatermarkIds = idsAtPublishedAt(candidates, maxTs);
  }

  const nextKnown = {
    ids: mergedIds,
    highWatermarkAt,
    highWatermarkIds,
    seededAt: known?.seededAt || timestamp,
    updatedAt: known?.updatedAt || timestamp,
  };

  const changed =
    !known ||
    !jsonEqual(known.ids || [], nextKnown.ids) ||
    known.highWatermarkAt !== nextKnown.highWatermarkAt ||
    !jsonEqual(known.highWatermarkIds || [], nextKnown.highWatermarkIds);

  if (changed) {
    nextKnown.updatedAt = timestamp;
  }

  return { nextKnown, changed };
}

export function boundKnownVideoIds(ids) {
  if (!Array.isArray(ids)) return [];
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  return unique.slice(0, KNOWN_VIDEO_LIMIT);
}

function maxPublishedAt(videos) {
  let max = null;
  for (const v of videos || []) {
    const ts = v.published || v.publishedAt;
    if (!ts) continue;
    if (!max || new Date(ts).getTime() > new Date(max).getTime()) max = ts;
  }
  return max;
}

function idsAtPublishedAt(videos, targetTs) {
  if (!targetTs) return [];
  const targetTime = new Date(targetTs).getTime();
  const ids = [];
  for (const v of videos || []) {
    const ts = v.published || v.publishedAt;
    if (ts && new Date(ts).getTime() === targetTime) ids.push(v.videoId);
  }
  return [...new Set(ids)];
}

// ─── Community post helpers ─────────────────────────────────────────────

export function getCommunityPostSeenId(post) {
  if (!post) return null;
  if (typeof post.id === 'string' && post.id.startsWith('post:')) return post.id;
  if (post.activityId) return `post:${post.activityId}`;
  if (post.postId) return `post:${post.postId}`;
  return null;
}

export function getCachedCommunityPostIds(posts) {
  return new Set((posts || []).map(getCommunityPostSeenId).filter(Boolean));
}

export function preserveCachedCommunityPostPublishedAt(post, cachedPosts) {
  if (!post) return post;
  const postId = getCommunityPostSeenId(post);
  const cached = (cachedPosts || []).find((cachedPost) => getCommunityPostSeenId(cachedPost) === postId);
  if (!cached?.publishedAt) return post;
  return {
    ...post,
    publishedAt: cached.publishedAt,
    publishedAtSource: cached.publishedAtSource || post.publishedAtSource || 'unknown',
  };
}

export function shouldRefreshCachedCommunityPost(latestPost, cachedPosts) {
  if (!latestPost) return false;
  if (!Array.isArray(cachedPosts) || cachedPosts.length !== 1) return true;
  const cached = cachedPosts[0];
  if ((cached?.activityId || cached?.postId) !== latestPost.activityId) return true;
  if (!cached.publishedAt && latestPost.publishedAt) return true;
  if (!cached.fetchedAt && latestPost.fetchedAt) return true;
  if (!cached.publishedAtSource && latestPost.publishedAtSource) return true;
  for (const field of ['text', 'thumbnail', 'publishedText', 'likeCount', 'likeText', 'viewCount', 'viewText']) {
    if ((cached?.[field] ?? null) !== (latestPost?.[field] ?? null)) return true;
  }
  return false;
}

function cleanCommunityPostDisplayName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function formatCommunityPostNotificationTitle({ channelMeta, post, profile, channelId, postLabel }) {
  const displayName = cleanCommunityPostDisplayName(channelMeta?.title)
    || cleanCommunityPostDisplayName(channelMeta?.name)
    || cleanCommunityPostDisplayName(channelMeta?.channelName)
    || cleanCommunityPostDisplayName(post?.authorName);
  if (displayName) return `${displayName} ${postLabel}`;
  const handle = cleanCommunityPostDisplayName(profile?.channelHandle)
    || cleanCommunityPostDisplayName(post?.authorHandle);
  if (handle) {
    return `${handle.startsWith('@') ? handle : `@${handle}`} ${postLabel}`;
  }
  return `@${channelId} ${postLabel}`;
}

export function normalizeKnownCommunityPostIds(ids) {
  const normalized = [];
  for (const id of ids || []) {
    if (typeof id !== 'string' || !id.startsWith('post:')) continue;
    if (!normalized.includes(id)) normalized.push(id);
    if (normalized.length >= KNOWN_COMMUNITY_POST_LIMIT) break;
  }
  return normalized;
}

export function addKnownCommunityPostId(ids, id) {
  if (!id) return normalizeKnownCommunityPostIds(ids);
  return normalizeKnownCommunityPostIds([id, ...(ids || []).filter((knownId) => knownId !== id)]);
}

export function removePostIdsFromUnwatched(unwatched, postIds) {
  if (!Array.isArray(unwatched) || !postIds || postIds.size === 0) {
    return { unwatched: Array.isArray(unwatched) ? unwatched : [], removed: 0 };
  }
  const filtered = unwatched.filter((id) => !postIds.has(id));
  return { unwatched: filtered, removed: unwatched.length - filtered.length };
}

export async function removeCachedPostIdsFromSubscriberState(env, channelId, postIds) {
  if (!postIds || postIds.size === 0) return 0;
  const subs = await getKV(env.TUBEPULSE_KV, key.channelSubs(channelId)) || [];
  let removed = 0;
  for (const deviceId of subs) {
    const state = await getKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId));
    if (!state?.unwatched?.length) continue;
    const result = removePostIdsFromUnwatched(state.unwatched, postIds);
    if (result.removed > 0) {
      await putKV(env.TUBEPULSE_KV, key.deviceState(deviceId, channelId), {
        ...state,
        unwatched: result.unwatched,
      });
      removed += result.removed;
    }
  }
  return removed;
}
