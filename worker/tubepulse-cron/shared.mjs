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
const SHADOW_FCM_ACCESS_TOKEN = 'tubepulse-shadow-no-network';

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

export async function withKvMutationLock(env, name, operation) {
  if (typeof env?.TUBEPULSE_KV_MUTATION_LOCK === 'function') {
    return await env.TUBEPULSE_KV_MUTATION_LOCK(name, operation);
  }
  return await operation();
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

const RSS_METRIC_FORCE_REFRESH_HOURS = 24;

function normalizedKnownMetric(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return BigInt(text).toString();
  const numeric = Number(text);
  return Number.isFinite(numeric) ? String(numeric) : null;
}

function knownMetricChanged(persistedValue, incomingValue) {
  const persisted = normalizedKnownMetric(persistedValue);
  const incoming = normalizedKnownMetric(incomingValue);
  return persisted !== null && incoming !== null && persisted !== incoming;
}

function shouldPersistMetricGroup(lastCheckedHour, currentHour, metricPairs) {
  // Structural discovery can seed a brand-new video with unknown metrics and
  // then enrich it from the batched statistics endpoint seconds later. Allow
  // that one-time null -> known hydration even though both operations happen
  // in the same hour; subsequent known values remain subject to the normal
  // once-per-UTC-hour write gate.
  const hydratesMissingMetric = metricPairs.some(([persistedValue, incomingValue]) => (
    (persistedValue === undefined || persistedValue === null)
    && incomingValue !== undefined
    && incomingValue !== null
  ));
  if (hydratesMissingMetric) return true;
  const normalizedLastCheckedHour = Number(lastCheckedHour);
  const missingLastCheckedHour = lastCheckedHour === undefined || lastCheckedHour === null
    || !Number.isFinite(normalizedLastCheckedHour);
  const differentHour = missingLastCheckedHour || normalizedLastCheckedHour !== currentHour;
  const stale = missingLastCheckedHour
    || currentHour - normalizedLastCheckedHour >= RSS_METRIC_FORCE_REFRESH_HOURS;
  return differentHour && (
    stale || metricPairs.some(([persistedValue, incomingValue]) => (
      knownMetricChanged(persistedValue, incomingValue)
    ))
  );
}

function currentMetricValue(rssValue, persistedValue) {
  if (rssValue !== undefined && rssValue !== null) return String(rssValue);
  if (persistedValue !== undefined && persistedValue !== null) return persistedValue;
  return null;
}

function isMissingMetricClock(lastCheckedHour) {
  return lastCheckedHour === undefined || lastCheckedHour === null
    || !Number.isFinite(Number(lastCheckedHour));
}

function isAmbiguousLegacyZero(persistedValue, rssValue) {
  return (rssValue === undefined || rssValue === null)
    && persistedValue !== undefined
    && persistedValue !== null
    && persistedValue !== ''
    && Number(persistedValue) === 0;
}

function copyPersistedMetricFields(target, cached) {
  for (const field of [
    'views', 'likes', 'comments', 'dislikes', 'viewsLastCheckedHour', 'likesLastCheckedHour',
    'commentsLastCheckedHour',
  ]) {
    if (Object.prototype.hasOwnProperty.call(cached, field)) target[field] = cached[field];
  }
}

/**
 * Merge the current RSS/API ordering and structure with persisted metrics.
 * Only the three app-visible entries are eligible for a metric refresh; new
 * entries are seeded from the current source. Comment counts are observational:
 * they may piggyback on a write already required by structure/views/likes, but
 * never make the canonical recent list dirty by themselves. `nowMs` is explicit
 * so this helper remains deterministic.
 */
export function mergeRssUploadsIntoRecentVideos(cachedRecent, rssUploads, nowMs) {
  const currentHour = Math.floor(nowMs / 3600000);
  const cachedByVideoId = new Map((cachedRecent || []).map((video) => [video.videoId, video]));
  const uploads = (rssUploads || []).slice(0, 15);

  const mergedVideos = uploads.map((upload, index) => {
    const hasCommentMetric = Object.prototype.hasOwnProperty.call(upload, 'comments');
    const merged = {
      videoId: upload.videoId,
      title: upload.title,
      publishedAt: upload.published,
      thumbnail: upload.thumbnail,
      type: upload.type || classifyVideo(upload, nowMs),
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
        ...(hasCommentMetric ? {
          comments: currentMetricValue(upload.comments),
          commentsLastCheckedHour: currentHour,
        } : {}),
      };
    }

    copyPersistedMetricFields(merged, cached);
    if (index >= 3) return merged;

    if (shouldPersistMetricGroup(cached.viewsLastCheckedHour, currentHour, [
      [cached.views, upload.views],
    ])) {
      merged.views = currentMetricValue(upload.views, cached.views);
      merged.viewsLastCheckedHour = currentHour;
    }

    const repairAmbiguousLikes = isAmbiguousLegacyZero(cached.likes, upload.likes);
    const repairAmbiguousDislikes = isAmbiguousLegacyZero(cached.dislikes, upload.dislikes);
    if (repairAmbiguousLikes || repairAmbiguousDislikes || shouldPersistMetricGroup(cached.likesLastCheckedHour, currentHour, [
      [cached.likes, upload.likes],
      [cached.dislikes, upload.dislikes],
    ])) {
      // Old API bootstrap/WebSub entries wrote a synthetic zero and no
      // metric clock when RSS omitted a count. During their one-time clock
      // migration, or if the old zero has already acquired a clock, trust the
      // current RSS value (including null/unknown) instead of carrying that
      // ambiguous zero forever. Once repaired to null this condition is false,
      // so the exception remains a bounded one-time write.
      const legacyUnclocked = isMissingMetricClock(cached.likesLastCheckedHour);
      merged.likes = currentMetricValue(
        upload.likes,
        legacyUnclocked || repairAmbiguousLikes ? undefined : cached.likes,
      );
      merged.dislikes = currentMetricValue(
        upload.dislikes,
        legacyUnclocked || repairAmbiguousDislikes ? undefined : cached.dislikes,
      );
      merged.likesLastCheckedHour = currentHour;
    }

    return merged;
  });

  // At this point existing comments/clocks are copied verbatim, so inequality
  // can only come from a legitimate structural, view, like, or dislike write.
  // If comments are the sole new observation, return the canonical value
  // unchanged and let Home retain the fresh count only in its local state.
  if (jsonEqual(cachedRecent || [], mergedVideos)) return mergedVideos;

  return mergedVideos.map((video, index) => {
    const upload = uploads[index];
    if (index >= 3 || !Object.prototype.hasOwnProperty.call(upload, 'comments')
      || upload.comments === undefined) return video;
    return {
      ...video,
      comments: upload.comments === null ? null : String(upload.comments),
      commentsLastCheckedHour: currentHour,
    };
  });
}

export class RssFetchError extends Error {
  constructor(message, { category = 'rss-fetch-failed', status = null, retryable = false } = {}) {
    super(message);
    this.name = 'RssFetchError';
    this.category = category;
    this.status = status;
    this.retryable = retryable;
  }
}

function validYoutubeFeedXml(xmlText) {
  return typeof xmlText === 'string'
    && /<feed(?:\s|>)/i.test(xmlText)
    && /<yt:channelId>[^<]+<\/yt:channelId>/i.test(xmlText);
}

export async function fetchChannelRSS(channelId, options = {}) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(feedUrl, {
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
      throw new RssFetchError(`RSS HTTP ${resp.status}`, {
        category: `http-${resp.status}`,
        status: resp.status,
        retryable: resp.status === 408 || resp.status === 429 || resp.status >= 500,
      });
    }
    const xml = await resp.text();
    if (!validYoutubeFeedXml(xml)) {
      throw new RssFetchError('RSS response was not a valid YouTube feed', {
        category: 'invalid-xml',
        status: resp.status,
      });
    }
    return parseRSSFeed(xml);
  } catch (err) {
    const error = err instanceof RssFetchError
      ? err
      : new RssFetchError(err?.name === 'AbortError' ? 'RSS request timed out' : 'RSS network request failed', {
        category: err?.name === 'AbortError' ? 'timeout' : 'network',
        retryable: true,
      });
    if (options.throwOnError) throw error;
    if (!options.quiet) {
      if (error.status) console.warn(`[RSS] ${error.message} for ${channelId}`);
      else console.error(`[RSS] ${error.message} for ${channelId}`);
    }
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
  // The dedicated Home scheduler uses this explicit mode while measuring a
  // production-shaped sweep. Returning an internal sentinel keeps the normal
  // notification decision path intact without minting a Google token or
  // contacting FCM. The sentinel is consumed only by sendFCMPush below.
  if (env?.TUBEPULSE_NOTIFICATION_MODE === 'shadow') return SHADOW_FCM_ACCESS_TOKEN;
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

export const LOCAL_NOTIFICATION_CAPABILITY = 'local-v1';

export function normalizeNotificationCapability(value) {
  return value === LOCAL_NOTIFICATION_CAPABILITY ? LOCAL_NOTIFICATION_CAPABILITY : null;
}

function stringData(data) {
  return Object.fromEntries(Object.entries(data || {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value)]));
}

export function buildFcmMessage(fcmToken, payload, notificationCapability = null) {
  const notification = payload.notification || {};
  const title = payload.title ?? notification.title ?? 'TubePulse';
  const body = payload.body ?? notification.body ?? '';
  const data = stringData(payload.data);
  if (normalizeNotificationCapability(notificationCapability)) {
    return {
      token: fcmToken,
      data: {
        ...data,
        localRender: '1',
        notificationTitle: String(title),
        notificationBody: String(body),
        notificationTag: String(payload.tag || data.notificationTag || 'tubepulse'),
      },
      android: { priority: 'high' },
    };
  }
  return {
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
  };
}

export async function sendFCMPush(accessToken, projectId, fcmToken, payload, notificationCapability = null) {
  if (accessToken === SHADOW_FCM_ACCESS_TOKEN) {
    return { sent: false, deadToken: false, shadow: true };
  }
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
  return await withKvMutationLock(env, key.nagActive(), async () => {
    const kv = env.TUBEPULSE_KV;
    const entry = `${deviceId}|${channelId}`;
    const active = await getKV(kv, key.nagActive()) || [];
    if (active.includes(entry)) return;
    active.push(entry);
    await putKV(kv, key.nagActive(), active);
  });
}

export async function removeFromNagActive(env, deviceId, channelId) {
  return await withKvMutationLock(env, key.nagActive(), async () => {
    const kv = env.TUBEPULSE_KV;
    const entry = `${deviceId}|${channelId}`;
    const active = await getKV(kv, key.nagActive()) || [];
    const filtered = active.filter((e) => e !== entry);
    if (filtered.length !== active.length) {
      await putKV(kv, key.nagActive(), filtered);
    }
  });
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

function isExpectedCommunityThumbnailHost(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === 'i.ytimg.com'
    || normalized.endsWith('.ytimg.com')
    || normalized === 'yt3.ggpht.com'
    || normalized.endsWith('.ggpht.com')
    || normalized.endsWith('.googleusercontent.com');
}

function communityThumbnailCacheIdentity(value) {
  if (typeof value !== 'string' || !value) return value;
  try {
    const url = new URL(value);
    if (!isExpectedCommunityThumbnailHost(url.hostname)) return value;
    // YouTube rotates these delivery/signature parameters between otherwise
    // identical InnerTube responses. The image identity is the stable path;
    // retaining the cached URL prevents an hourly KV write with no UI change.
    url.searchParams.delete('sqp');
    url.searchParams.delete('rs');
    url.searchParams.sort();
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

const COMMUNITY_POST_METRIC_FIELDS = ['likeCount', 'likeText', 'viewCount', 'viewText'];

function communityPostWithoutObservationChurn(post) {
  if (!post || typeof post !== 'object') return post;
  const result = {};
  for (const [name, value] of Object.entries(post)) {
    if (name === 'fetchedAt' || COMMUNITY_POST_METRIC_FIELDS.includes(name)) continue;
    result[name] = name === 'thumbnail' ? communityThumbnailCacheIdentity(value) : value;
  }
  return result;
}

function knownCommunityMetric(value) {
  return value !== undefined && value !== null && Number.isFinite(Number(value));
}

function knownCommunityMetricChanged(cachedValue, latestValue) {
  if (!knownCommunityMetric(cachedValue) || !knownCommunityMetric(latestValue)) return false;
  return normalizedKnownMetric(cachedValue) !== normalizedKnownMetric(latestValue);
}

export function mergeCachedCommunityPostForPersistence(latestPost, cachedPosts) {
  if (!latestPost) return latestPost;
  if (!Array.isArray(cachedPosts) || cachedPosts.length !== 1) return latestPost;
  const cached = cachedPosts[0];
  if ((cached?.activityId || cached?.postId) !== (latestPost.activityId || latestPost.postId)) return latestPost;

  const candidate = { ...latestPost };
  if (communityThumbnailCacheIdentity(cached?.thumbnail)
    === communityThumbnailCacheIdentity(candidate?.thumbnail)) candidate.thumbnail = cached.thumbnail;
  const cachedPublishedAt = Date.parse(cached?.publishedAt);
  const latestPublishedAt = Date.parse(candidate?.publishedAt);
  const hasStablePublishedAt = Number.isFinite(cachedPublishedAt)
    && Number.isFinite(latestPublishedAt)
    && cachedPublishedAt === latestPublishedAt;
  // Relative labels (for example "12 minutes ago") advance even though the
  // post did not. Clients prefer publishedAt and compute their own age, so a
  // label-only change is useful only when there is no trustworthy timestamp.
  if (hasStablePublishedAt) candidate.publishedText = cached.publishedText;

  if (!jsonEqual(
    communityPostWithoutObservationChurn(cached),
    communityPostWithoutObservationChurn(candidate),
  )) return candidate;

  const latestFetchedAt = Date.parse(candidate.fetchedAt || '');
  const cachedFetchedAt = Date.parse(cached.fetchedAt || '');
  const latestHour = Number.isFinite(latestFetchedAt) ? Math.floor(latestFetchedAt / 3_600_000) : null;
  const cachedHour = Number.isFinite(cachedFetchedAt) ? Math.floor(cachedFetchedAt / 3_600_000) : null;
  const hydratesClock = !Number.isFinite(cachedFetchedAt) && Number.isFinite(latestFetchedAt);
  const hydratesMetric = ['likeCount', 'viewCount'].some((field) => (
    !knownCommunityMetric(cached[field]) && knownCommunityMetric(candidate[field])
  ));
  const differentHour = latestHour !== null && (cachedHour === null || latestHour !== cachedHour);
  const stale = latestHour !== null && (cachedHour === null || latestHour - cachedHour >= RSS_METRIC_FORCE_REFRESH_HOURS);
  const metricChanged = ['likeCount', 'viewCount'].some((field) => (
    knownCommunityMetricChanged(cached[field], candidate[field])
  ));
  if (!hydratesClock && !hydratesMetric && !(differentHour && (stale || metricChanged))) return cached;

  const merged = { ...cached };
  if (candidate.fetchedAt) merged.fetchedAt = candidate.fetchedAt;
  for (const [countField, textField] of [['likeCount', 'likeText'], ['viewCount', 'viewText']]) {
    if (!knownCommunityMetric(candidate[countField])) continue;
    merged[countField] = candidate[countField];
    merged[textField] = candidate[textField] ?? null;
  }
  return merged;
}

export function shouldRefreshCachedCommunityPost(latestPost, cachedPosts) {
  if (!latestPost) return false;
  if (!Array.isArray(cachedPosts) || cachedPosts.length !== 1) return true;
  return !jsonEqual(
    mergeCachedCommunityPostForPersistence(latestPost, cachedPosts),
    cachedPosts[0],
  );
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
