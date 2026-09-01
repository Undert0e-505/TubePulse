# TubePulse — Cloud Services

This document describes the TubePulse backend: the HTTP API Worker, five active scheduled Workers, the shared Cloudflare KV store, YouTube integrations, and Firebase Cloud Messaging. For the current endpoint, trigger, KV, notification, and deployment inventory, start with [CONTRACTS.md](CONTRACTS.md). The Android app is documented separately in the project root README.

---

## 1. High-level architecture

```
                                                ┌─────────────────────────────┐
                                                │     YouTube RSS feed        │
                                                │  (free, no auth, no quota)  │
                                                └──────────────┬──────────────┘
                                                               │ rotating poll
                                                               ▼
┌────────────┐     HTTPS     ┌────────────────────┐    fan-out    ┌────────────────────┐
│ Android    │──────────────▶│ tubepulse-api      │◀──────────────│ RSS/posts/aux      │
│ app        │               │ (Cloudflare Worker)│               │ scheduled Workers  │
│            │◀── FCM push ──│                    │── FCM v1 API ─▶│ YouTube Data API   │
└────────────┘               └────────┬───────────┘               │ (subscribe-time    │
                                     │                           │  only, 1-2 units)  │
                                     ▼                           └────────────────────┘
                            ┌─────────────────┐
                            │ Cloudflare KV   │
                            │ (single ns)     │
                            └─────────────────┘
                                       ▲
                                       │ same KV
                                       │
                            ┌──────────┴──────────┐
                            │ five active workers │
                            │ (same shared KV)    │
                            └─────────────────────┘
```

**One API Worker, five scheduled Workers, one KV namespace, one Firebase project.**

| Component | Repo path/config | Purpose | Route/deploy evidence |
|-----------|------------------|---------|-----------------------|
| `tubepulse-api` | `worker/tubepulse-api/` | Current live app-facing API worker source + dormant WebSub callback | `GET /` at `https://tubepulse-api.jimothyoakley55.workers.dev` returned Cloudflare-served health JSON on 2026-06-25. Wrangler route comments are stale/incomplete. |
| `tubepulse-rss-0/1/2` | `worker/tubepulse-rss-{0,1,2}/` | Time-derived RSS shards; one channel per active shard per minute | One-minute triggers, distinct shard indexes, no HTTP handlers. |
| `tubepulse-posts` | `worker/tubepulse-posts/` | Rotating community-post poller; one eligible channel per invocation | One-minute trigger; with six channels each is selected approximately hourly. |
| `tubepulse-aux` | `worker/tubepulse-aux/` | Bounded nag/prewarn processing and legacy upcoming-bucket drain | One-minute trigger; no HTTP handler. |
| `tubepulse-cron` | `worker/tubepulse-cron/` | Retired compatibility stub | Deliberate no-op with `triggers.crons = []`; do not deploy it as the active scheduler. |
| `tubepulse-resolver` | `worker/archive/tubepulse-resolver/` | Historical standalone resolver worker | Archived for reference only; do not deploy unless deliberately restoring historical resolver behaviour. |
| `TUBEPULSE_KV` | KV namespace `52e77ca9f5f6493e89d2478c8d3055ec` | All current backend persistent state | Shared by the API and all five scheduled workers. |

> **Verified route:** on 2026-06-25, `GET /` at the app API URL returned `200 OK` with `{"status":"ok","version":"3.0.0","worker":"tubepulse-api","architecture":"channel-first"}`. The health `version` is an API worker label and appears stale or independent from the app release version `3.3.3`. `worker/tubepulse-api/wrangler.toml` has no explicit route setting and still contains a stale/incomplete "No HTTP routes" comment.

The active workers share the **same KV namespace** so scheduled workers can update state that the API reads when serving `/feed`.

---

## 2. Why split scheduled workers?

The scheduled workers have no `fetch()` handler. This is deliberate:

- **No public HTTP surface** — no attack surface, no auth concerns
- **Free-tier CPU bounds** — each invocation performs one RSS/post channel or a bounded aux batch rather than one large combined scan.
- **Independent deploy cadence** — RSS, posts, aux, and API changes can be deployed separately.

All scheduled workers use the same KV namespace, so they can write state that the API reads directly.

---

## 3. Scheduled workers

The active entry points are `worker/tubepulse-rss-0/1/2/index.js`, `worker/tubepulse-posts/index.js`, and `worker/tubepulse-aux/index.js`. Shared runtime helpers live in `worker/tubepulse-cron/shared.mjs`; `worker/tubepulse-cron/index.js` itself is a retired no-op.

**Schedule:** all five active workers use `* * * * *` (every minute).

See [CONTRACTS.md](CONTRACTS.md) for the active worker contract/inventory reference before changing worker behavior.

| Worker | Selection/work |
|---|---|
| RSS 0/1/2 | Sort `channels:active`, choose the active shard count (one per five channels, up to three), then rotate one channel per shard using the current minute. A durable known-video watermark prevents deletion/restoration notification cascades. |
| Posts | Filter active channels through the optional allowlist and use minute-derived spacing to select one channel. First-poll seeding sends no notification. |
| Aux | Drain one legacy upcoming bucket, process at most five `nag:active` entries, then check prewarns when no nag fired. |

### 3.1 RSS poll — the active new-video detection path

Since WebSub hub shutdown, the RSS shards detect new videos by polling YouTube's public RSS feed:

```
https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxxxxxxxxxxxxxxxxxx
```

Each entry in the Atom feed carries: `videoId`, `title`, `publishedAt`, `thumbnail`, `link`, **view count** (from `media:community/media:statistics/@_views`), **like count** (from `media:starRating/@_count`), and **dislike count** (from `media:statistics/@_dislikes` — usually `0` for public videos since YouTube removed public dislike counts in Nov 2021; the field is still captured for completeness).

**Flow for the selected channel:**

1. Read `channels:active` and select this shard's channel for the current minute.
2. For that channelId:
   - GET the RSS feed (with `User-Agent` + `SOCS` cookie to bypass the EU/UK consent wall)
   - Parse with a regex-based Atom parser (no XML library needed in the worker)
   - Read `channel:{id}:recent` from KV
   - Find videos in RSS that aren't in `recent` → new videos
   - For new videos: write updated `channel:{id}:recent` and `channel:{id}:meta`, then look up subscribers and fan out FCM pushes
3. Truncate `recent` to 15 entries

**Quota cost: 0 YouTube Data API units.** RSS is a free public feed. Cloudflare KV cost: ~1 read per channel per tick, with writes only when a new video is detected, when engagement metrics cross their threshold, or when the top-of-hour top-of-list view refresh runs (see §6.4 below).

### 3.2 FCM push from the cron

For each new video, the cron does the standard fan-out (which is identical to what a WebSub push would have done):

1. Read `channel:{id}:subscribers` to get the list of devices
2. For each device:
   - Read `device:{id}:profile` (FCM token), `device:{id}:settings`, and `device:{id}:override:{channelId}`
   - Skip if muted via override, or if DND is active and the override doesn't bypass it
   - Sign a JWT using the Firebase service account, exchange for an OAuth token, POST to `fcm.googleapis.com/v1/projects/{projectId}/messages:send`
3. Update `device:{id}:state:{channelId}` with the new `unwatched` list
4. Nag scheduling is handled by the aux worker's timestamp-based bounded processor; RSS adds newly unread channel/device pairs to `nag:active`.

---

## 4. The API worker

`worker/tubepulse-api/index.js` - app-facing API worker source. Line counts in older notes may be stale; check the file directly when needed.

**Route status verified.** The API worker source has a `fetch(request, env, ctx)` entry point and app-facing routes. The app client hardcodes `https://tubepulse-api.jimothyoakley55.workers.dev`, and live `GET /` verification on 2026-06-25 returned the worker health JSON. The wrangler route comment is stale/incomplete; review deployed Cloudflare settings before changing route config.

### 4.1 Endpoint map

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET`  | `/` | none | Health check (inlined — verified live on 2026-06-25 as `{ status: 'ok', version: '3.0.0', worker: 'tubepulse-api', architecture: 'channel-first' }`). The `version` field is a worker health label and appears stale/independent from the app release version. |
| `POST` | `/register` | Bearer | `handleRegister` — create/update device profile (FCM token optional). Two-phase deviceId migration for cross-version upgrades (see §11.1). |
| `POST` | `/subscribe-channel` | Bearer | `handleSubscribeChannel` — add a channel, fetch its avatar via Data API (first-subscribe only), RSS bootstrap (zero quota) |
| `POST` | `/unsubscribe` | Bearer | `handleUnsubscribe` — remove a channel, clean up subscriber list and active index, call `cleanupDeadChannel` if the device was the last subscriber |
| `POST` | `/seen` | Bearer | `handleSeen` — mark videos / posts as watched. `ids: [videoId, "post:activityId", ...]` for individual marks; `clearAll: true` for channel-tap (clears all videos and posts for that channel) |
| `GET`  | `/feed` | Bearer | `handleFeed` — return recent videos + community posts for all subscribed channels, with per-device `unwatched` flags merged in |
| `GET`  | `/resolve` | Bearer | `handleResolve` — `@handle` → channelId (Data API, cached 7 days in `handle:*`) |
| `POST` | `/bootstrap` | Bearer | `handleBootstrap` — on-demand channel meta + recent videos refresh (RSS primary, Data API fallback for the rare unreachable-RSS case) |
| `POST` | `/settings` | Bearer | `handleSettings` — update device notification settings. Accepts `prewarnMinutes` and `includeCommunityPosts` (v3.1) |
| `POST` | `/channel-override` | Bearer | `handleChannelOverride` — set per-channel override. Accepts `prewarnMinutes` and `includeCommunityPosts` (v3.1, tri-state null/value) |
| `GET`  | `/websub` | none | `handleWebSubVerification` — WebSub handshake (dormant) |
| `POST` | `/websub` | HMAC | `handleWebSubPush` — WebSub push delivery (dormant) |
| `OPTIONS` | * | none | CORS preflight — allow any path |

**Auth model:** Every authenticated endpoint requires `Authorization: Bearer <deviceId>`. The `deviceId` is a UUID generated on first launch (via `expo-secure-store` since v3.0.20; previously a random UUID, then `Application.getAndroidId()`). There is no login — the deviceId *is* the auth token. This is acceptable because the KV is private and the deviceId is unguessable (UUIDv4 / Android-ID / secure-store UUID).

### 4.2 Bootstrap-on-subscribe (the most important code path)

When a new device subscribes to a channel, the API worker does **the only work that uses the YouTube Data API at subscribe time**:

1. **Resolve channel via Data API** (`channels.list?part=snippet&forHandle=...` or `forUsername=...`) — 1 quota unit, returns channelId + name + avatar URL in one call. Only runs if `meta` is missing.
2. **Fetch recent videos via RSS** — 0 quota units, returns up to 15 videos with view counts, like counts, and dislike counts (from `media:community`, `media:starRating`, and `media:statistics`)
3. Cache the channel meta + recent list in KV
4. Add the channel to `channels:active` (if this device is the first subscriber)
5. Try a dormant WebSub subscription (no quota cost, just a POST that 404s — kept for future hub revival)

**The YouTube Data API is called at most once per new channel** (the avatar resolve, on the very first subscribe for that channel). After that, RSS shard Workers refresh `channel:{id}:meta` and `channel:{id}:recent` at zero quota cost.

### 4.3 WebSub (dormant)

The WebSub handlers are intact but unused since 2024 (Google's hub was shut down). The code path remains in case a YouTube-compatible hub reappears or you want to integrate with a self-hosted hub.

---

## 5. KV schema (the only persistent state)

`worker/tubepulse-api/index.js` - app-facing API worker source. Line counts in older notes may be stale; check the file directly when needed.

| Key | Type | Contents | Written by | Read by |
|-----|------|----------|------------|---------|
| `channel:{channelId}:meta` | JSON | `{ name, avatarUrl, lastVideoId, addedAt, viewsLastCheckedHour? }` | API (subscribe), Cron (new video + view refresh) | API (feed, bootstrap) |
| `channel:{channelId}:subscribers` | JSON array | `[deviceId, ...]` | API (subscribe, unsubscribe) | Cron (FCM fan-out), API (unsubscribe cleanup) |
| `channel:{channelId}:websub` | JSON | `{ leaseExpiresAt, hmacSecret, lastVerified }` | API (subscribe, dormant) | (none — never used) |
| `channel:{channelId}:recent` | JSON array | `[{ videoId, title, publishedAt, thumbnail, type, link, views, likes, dislikes, viewsLastCheckedHour? }]` — **v3.1**: `likes` + `dislikes` extracted from `media:starRating` and `media:statistics` | Cron (RSS poll) | API (feed, bootstrap), API (subscribe for first-time populate) |
| `channel:{channelId}:recent:posts` | JSON array | `[{ activityId, kind, text, thumbnail, link, publishedAt }, ...]` — last 30 community posts (**v3.1**) | Cron (community posts) | API (feed) |
| `channel:{channelId}:firstPollAt:posts` | string | ISO timestamp of the first posts-cron run for this channel — drives the first-run guard (**v3.1**) | Cron (community posts) | Cron (community posts) |
| `device:{deviceId}:profile` | JSON | `{ fcmToken, platform, appVersion, createdAt, lastSeenAt }` | API (register) | API (any auth call), Cron (FCM fan-out) |
| `device:{deviceId}:settings` | JSON | `{ mode, nagInterval, dndEnabled, dndStart, dndEnd, dndTimezone, dndBypass, tapAction, includeCommunityPosts (v3.1), prewarnMinutes (v3.1), ... }` | API (settings) | Cron (FCM fan-out filter) |
| `device:{deviceId}:channels` | JSON array | `[channelId, ...]` | API (subscribe, unsubscribe) | API (feed filter) |
| `device:{deviceId}:override:{channelId}` | JSON | per-channel notification override. May include `mode?`, `nagInterval?`, `dndBypass?`, `muted?`, `includeCommunityPosts?` (**v3.1**, tri-state null/true/false), `prewarnMinutes?` (**v3.1**, tri-state null/number) | API (channel-override) | Cron (FCM fan-out filter) |
| `device:{deviceId}:state:{channelId}` | JSON | `{ unwatched: [...], lastNagAt, nagCount }` — `unwatched` holds plain videoIds and `post:{activityId}` for community posts (**v3.1** shares the array via `post:` namespace). `lastNagAt` is a timestamp updated after each successful nag push. `nagCount` tracks the number of reminder nags sent (not counting the initial new-video push). Both are reset to `null`/`0` by `/seen` when `unwatched` becomes empty, so the next unread item starts a fresh nag cadence. | Cron (new video, nag fire) | Cron (nag fire, seen cleanup) |
| `upcoming:events:list` | JSON array | `[{ channelId, videoId, scheduledFor, addedAt }, ...]` — currently-scheduled live events, pruned 24h after live (**v3.1**, replaces the pre-v3.1 `upcoming:{bucket}` scheme) | Cron (RSS poll) | Cron (prewarn cron) |
| `upcoming:prewarn:{videoId}:{deviceId}` | number | `prewarnMinutes` value at send-time, sentinel for "prewarn sent for this (event, device)" (**v3.1**) | Cron (prewarn fire) | Cron (prewarn fire) |
| `upcoming:{bucket}` | JSON array | pre-v3.1 scheduled-livestream entries | (legacy writes only) | Cron (`runUpcomingCron` drain-only) |
| `nag:{bucket}` | JSON array | **Legacy/unused** — pending nag entries from the old 15-min bucket system. No longer written by any code path. The timestamp-based `runNagCron` replaces this entirely. | (none — legacy) | (none) |
| `channels:active` | JSON array | `[channelId, ...]` — index of channels with ≥1 subscriber | API (subscribe, unsubscribe) | Cron (RSS poll, community posts) |
| `handle:{lowercase}` | JSON | `{ channelId, cachedAt }` — 7-day TTL | API (resolve) | API (resolve) |
| `fcm:lookup:{fcmToken}` | string | `deviceId` — reverse index from FCM token to the device that owns it | API (register) | API (register, migration) |

**`channels:active` is the secret sauce.** It replaces a `KV.list()` call — the only way to know "which channels have at least one subscriber" without scanning the entire namespace. The cron reads this list, processes each channel, done. No cron-side `list()` in the current code.

**`fcm:lookup:*` is the deviceId-migration index.** When the same FCM token registers with a new `deviceId` (e.g. a v3.0.18 UUID-based install upgrades to v3.0.19's Android-ID-based install), the server uses this index to find the old device and migrate its state. See §11.1.

**Key lifecycle (cleanup):** channel and device keys are deleted by two helpers, `cleanupDeadChannel()` and `cleanupDeadDevice()` — see §11. Channel keys (`meta`/`recent`/`websub` + the `channels:active` membership) are deleted when the last subscriber leaves or is detected as dead. Device keys (`profile`/`settings`/`channels`/`state:*`/`override:*`) are deleted only when the FCM token is reported dead. The API cleanup path deletes `fcm:lookup:*`; the cron cleanup path has known drift documented in [CONTRACTS.md](CONTRACTS.md).

---

## 5.1 Nag reminder behaviour

The nag system sends repeat reminder push notifications while items remain unread. It runs on every 5-minute cron tick.

**How it works:**

1. Iterate `channels:active` → `channel:{id}:subscribers` → `device:{id}:state:{channelId}`
2. For each subscriber with `unwatched.length > 0`, check `now - state.lastNagAt >= intervalMs`
3. If enough time has passed, send an FCM nag push and update `state.lastNagAt` + `state.nagCount`
4. If not enough time has passed, skip (no push, no KV write)

**Interval calculation (`getNagIntervalMs`):**

| Mode | Configured interval | Actual interval |
|---|---|---|
| Relentless | 5 min | 5 min for first 12 nags (1 hour), then **15 min** (backoff) |
| Relentless | 15 min | 15 min |
| Relentless | 30 min | 30 min |
| Relentless | 60 min | 60 min |
| Relentless | 120 min | 120 min |
| Chill | any | 4 hours |

**Backoff rationale:** Relentless 5-minute mode would burn KV writes (12 nags/hour per device/channel) if sustained indefinitely. After the first hour (12 nags), the interval backs off to 15 minutes (4 nags/hour), a 67% reduction.

**nagCount lifecycle:**
- `nagCount` counts only reminder nags (the initial new-video push does NOT increment it)
- `nagCount` is incremented in `runNagCron` after each successful FCM delivery
- `nagCount` and `lastNagAt` are reset to `0`/`null` by `/seen` when `unwatched` becomes empty
- A new unread item after a full clear starts fresh at `nagCount = 0` (5-min cadence)
- A new item added while old unread remains does NOT reset `nagCount` (stays in backed-off mode)

**Notification stacking:**
- Single-video nag: `tag: video-{videoId}` — replaces the original new-video notification in the tray
- Multi-video nag: `tag: tubepulse-nag-{channelId}` — replaces previous batch nags for that channel
- Different channels don't collide
- A dismissed notification **will** reappear on the next nag interval (the FCM tag prevents stacking, not re-delivery)

**Only `/seen` clears unwatched state.** Swiping away an Android tray notification does NOT mark anything seen. Opening settings, changing display mode, refreshing the feed, or app focus does NOT mark anything seen.

### 5.2 `/seen` contract

**Endpoint:** `POST /seen`
**Auth:** `Authorization: Bearer <deviceId>`

**Request body:**
```json
{
  "channelId": "UCxxxxx",
  "videoIds": ["videoId1", "post:activityId1"],  // for individual marks
  "clearAll": true                                // for channel-tap (clears all)
}
```

Either `videoIds` (array of seen IDs) or `clearAll: true` is required.

**Seen ID format:**
- Videos: plain `videoId` string (e.g. `dQw4w9WgXcQ`)
- Community posts: `post:{activityId}` string (e.g. `post:Ugkx...`)

**Behaviour:**
1. Reads `device:{deviceId}:state:{channelId}` from KV
2. Creates a **new** state object (copy, not reference — see aliasing bug below)
3. Removes seen IDs from `state.unwatched`, or empties it if `clearAll`
4. When `state.unwatched` becomes empty: resets `state.nagCount = 0` and `state.lastNagAt = null`
5. Writes via `putKVIfChanged` (only writes if state actually changed)
6. Returns `{ ok: true, unwatchedCount: N }`

**What `/seen` does NOT do:**
- Does not delete recent content (videos/posts remain in `channel:{id}:recent`)
- Does not unsubscribe the device from the channel
- Does not remove the channel from `channels:active`
- Does not send any FCM push

**`/seen` is the only backend path that marks content seen.** No other endpoint, cron job, or notification event modifies `unwatched`.

**Aliasing bug (fixed):** The `/seen` handler must create a fresh state object before mutation. The previous bug was: `const state = existingState` (a reference), then `state.unwatched = [...]`, then `putKVIfChanged(kv, key, state, existingState)` — since `state` and `existingState` are the same object, `jsonEqual` returns `true` and the write is silently skipped. The API returns `{ ok: true }` but nothing is persisted. The fix (already deployed): `const state = existingState ? { ...existingState, unwatched: [...] } : { ... }`.

### 5.3 Community post behaviour

**Global gate:** `TUBEPULSE_ENABLE_COMMUNITY_POSTS` (worker env var). Set to `1`, `true`, or `yes` to enable. Missing or any other value = disabled.

**Allowlist:** `TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST` (worker env var, optional). When blank/missing, all channels in `channels:active` are polled. When set to a comma-separated list of channel IDs, only those active channels are polled.

**Polling:** Hourly via InnerTube `youtubei/v1/browse` (not YouTube Data API — 0 quota cost).

**State keys:**
- `channel:{id}:recent:posts` — display cache (latest post only)
- `channel:{id}:known:posts` — notification/deletion watermark (up to 20 post IDs)
- `channel:{id}:firstPollAt:posts` — first-run sentinel

**First-run guard:** The first poll for a channel seeds `recent:posts` with the latest post and sets `firstPollAt:posts`, but sends **no notification**. This prevents spamming users with old posts on first subscribe.

**Detection logic:**
- Same latest post ID as cached → no-op (or compaction if metadata changed)
- New latest post ID, **not** in `known:posts` → new post: notify subscribers, add to `known:posts`, update `recent:posts`
- New latest post ID, **in** `known:posts` → rollback/restoration: suppress notification, update `recent:posts` (a newer post was likely deleted, rolling back to an older known one)
- No latest post found → clear `recent:posts` and remove stale `post:*` IDs from subscriber `unwatched`

**Community post seen IDs** use the `post:{activityId}` namespace in `device:state.unwatched`, sharing the array with video IDs.

**Community post fields** (from InnerTube): `id` (`post:{postId}`), `activityId`, `postId`, `kind` (text/image/poll), `text`, `thumbnail`, `link`, `publishedText`, `publishedAt` (preserved from cache), `fetchedAt`, `publishedAtSource`, optional `likeCount`/`likeText`, `viewCount`/`viewText`. `likeCount: 0` is a real value; null/missing means unknown.

### 5.4 Notification tag strategy

All FCM pushes include an `android.notification.tag` for tray replacement:

| Push type | Tag | Effect |
|---|---|---|
| New video (RSS poll) | `video-{videoId}` | Replaces any existing notification for the same video |
| Batch new videos | `tubepulse-batch` | Replaces previous batch notifications |
| Single-video nag | `video-{videoId}` | Replaces the original notification (updates tray) |
| Multi-video nag | `tubepulse-nag-{channelId}` | Replaces previous batch nags for that channel |
| Prewarn | `video-{videoId}` | Replaces previous prewarn for the same event |
| Community post | (no explicit tag — defaults to `tubepulse`) | May stack if multiple posts arrive; acceptable for rare community posts |

Different channels don't collide (channel-specific tags). A dismissed notification **will** reappear on the next nag interval — the tag prevents stacking, not re-delivery.

### 5.5 Worker free-tier cautions

KV writes are the primary budget concern. The free tier allows 1,000 writes/day (Cloudflare plan-dependent).

- Each successful nag writes `device:state` (1 KV write per device/channel per nag)
- Relentless 5-min with persistent unread items: 12 writes in the first hour, then 4 writes/hour after backoff — a 67% reduction
- Multiple test devices on 5-min relentless with uncleared items can accumulate writes quickly
- Monitor at: `https://dash.cloudflare.com/<account_id>/storage/kv`
- Do not leave several test devices on 5-min relentless indefinitely

---

## 6. Cost analysis (1 user, 4 channels)

### 6.1 YouTube Data API (free tier: 10,000 units/day)

| Operation | Quota units | When |
|-----------|-------------|------|
| `/resolve` (`channels.list?part=snippet&forHandle=...`) | 1 unit | Per unique handle, cached 7 days |
| `handle:*` cache hit | 0 units | Subsequent lookups for the same handle |
| Subscribe-time avatar fetch (in `/subscribe-channel`) | 1 unit | Per new channel added (one-time, cached forever in `channel:{id}:meta`) |
| Cron tick — RSS-based video detection | **0 units** | RSS feed has no API key requirement |
| Cron tick — community posts (`runCommunityPostsCron`, **v3.1**) | 0 units | InnerTube `youtubei/v1/browse` is free, no YouTube Data API quota cost |
| **Total steady-state (4 channels)** | **~4 units/day** | 0 for community posts (InnerTube is free) + ~4 for occasional handle resolves. New-channel adds are one-time, ~2 units each. |

### 6.2 Cloudflare Workers (free tier: 100,000 requests/day, 10ms CPU per invocation)

| Worker | Invocations/day | CPU per | Notes |
|--------|-----------------|---------|-------|
| RSS/posts/aux scheduled workers | One invocation/worker/minute | Bounded | One RSS/post channel or bounded aux batch per invocation |
| `tubepulse-api` (HTTP) | ~20-50 | ~5ms | Depends on app open frequency and action count |

### 6.3 Cloudflare KV (free tier: 100K reads, 1K writes, 1K list, 1GB storage)

**Reads per day (1 user, 4 channels):**
- Scheduled workers: each RSS tick reads `channels:active` and one selected channel; posts reads the active set and one selected channel; aux performs a bounded nag/prewarn batch. Exact reads depend on subscriptions and due work.
- API (per app open): 4 `channel:{id}:*` reads × 4 channels = 16 reads × 20 opens = **320 reads/day**
- **Total: ~2,400 reads/day = 2.4% of free tier**

**Writes per day (1 user, 4 channels):**
- View-refresh (throttled, see §6.4): up to 4 channels × 24 hours = **up to 96 writes/day**
- App open (~20/day × ~5 writes each): **~100 writes/day**
- One-time per subscribe: **~4 writes per new channel** (only on first add)
- **Total: ~200 writes/day = 20% of free tier**

**Cron `KV.list()` calls: 0 in the current code.** The `channels:active` index replaces cron-side namespace scans. The API `/register` path intentionally uses `KV.list({ prefix: 'device:' })` for FCM-token migration; see [CONTRACTS.md](CONTRACTS.md).

**Deletes per day (cleanup):** dead-device cleanup is event-driven, not scheduled — it only fires when FCM reports a token as `UNREGISTERED`. Steady-state cost is ~0 deletes/day. A single cleanup of a device subscribed to N channels costs roughly `1 + 5N + 3N` KV ops (1 read of `device:{id}:channels` + N reads + N writes of subscriber lists + 3 + 2N deletes). In practice this is one user uninstalling every few months, well under free tier. See §11.

### 6.4 Engagement-metric write throttle (since v3.0.18, refined v3.1)

Originally, the combined cron re-stamped view counts on every video in the recent list on every tick, causing excessive writes.

New policy:
- Only the **latest video's** view count is considered for writes
- Only evaluated at the top of a new hour (gated by `currentHour !== viewsLastCheckedHour`)
- Only writes if the count changed by **more than 5%** from the last stored value
- Prior videos (index 1-14) keep their last-stored view counts — view counts are slightly stale on older videos, which is fine because the newest video is the one the user actually looks at
- **v3.1**: likes and dislikes follow the same hourly top-of-list rule but with a **stricter** threshold (any change) — they're useful at any scale, so we don't wait for a 5% swing

Net effect: engagement writes are bounded to at most one latest-video refresh per channel per hour, and are often much lower.

---

## 7. Firebase Cloud Messaging (FCM)

The API and scheduled workers use FCM v1 HTTP API for notification fan-out.

**Required secret:** `FIREBASE_SERVICE_ACCOUNT` (JSON blob stored in Cloudflare Workers secret manager). This is the Firebase service account key — `secrets/fcm-service-account.json` in the local repo (gitignored).

**How a push is sent:**

1. Read the service account JSON from `env.FIREBASE_SERVICE_ACCOUNT`
2. Extract the private key (PEM), strip literal `\n` escapes, base64-decode to get the PKCS8 DER
3. Build a JWT with header `{alg: 'RS256', typ: 'JWT'}` and payload `{ iss, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud, iat, exp }`
4. Sign with the private key using RSA-SHA256
5. POST to `https://oauth2.googleapis.com/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={jwt}` → get an OAuth access token
6. POST to `https://fcm.googleapis.com/v1/projects/{projectId}/messages:send` with the access token as a Bearer and the message payload:
   ```json
   {
     "message": {
       "token": "<device FCM token>",
       "notification": { "title": "...", "body": "..." },
       "data": { "videoId": "...", "channelId": "...", "channelName": "...", "videoLink": "..." },
       "android": { "priority": "HIGH", "notification": { "click_action": "OPEN_VIDEO" } }
     }
   }
   ```

**The FCM token can be null on `/register`.** The server accepts null tokens because the user might have denied notification permission. The device profile is still created so `/feed` and `/subscribe-channel` work. Push delivery is just disabled until a real token arrives via `onTokenRefresh`.

**Background push handler** (Android side, in `App.js`): when a push arrives while the app is in the background or killed, the handler re-fetches `/feed` and updates the local channel cache, then calls `requestWidgetUpdate` so the home-screen widget re-renders. Without this, the widget stays stale until the user opens the app.

**Dead-token detection and cleanup:** FCM returns a structured error when a token is no longer valid (user uninstalled, app data cleared, token rotated without our knowledge). The error code is `UNREGISTERED` (HTTP 404) or `NotRegistered` in the body. When `sendFCMPush` sees this, it returns `{ sent: false, deadToken: true }` to the caller, which then calls `cleanupDeadDevice()` to remove the device's full state. Other error codes (`INVALID_ARGUMENT`, `INTERNAL`, `UNAVAILABLE`, `SENDER_ID_MISMATCH`) are transient or config errors and do **not** trigger cleanup — see §11 for the full policy.

---

## 8. Local development

### 8.1 Running a worker locally

```bash
# In one worker directory
source ../../secrets/load-secrets.sh   # sets CLOUDFLARE_* and YOUTUBE_API_KEY
npx wrangler dev                       # starts local miniflare on port 8787
```

The local miniflare has its own KV simulator. The state is cached in `worker/*/.wrangler/state/v3/kv/...` — gitignored.

**Secrets permissions:** the `secrets/` directory contains live credentials. The whole directory is gitignored (see `.gitignore` line 23), so perms are not enforced by git. After copying or creating the files, run `chmod 600 secrets/*.env secrets/*.json` and `chmod 700 secrets/*.sh` to make them private to your user. On Windows-native or NTFS-mounted filesystems (e.g. `/mnt/d/...` in WSL) the POSIX mode bits are ignored — security is then controlled by Windows ACLs.

### 8.2 Deploying to production

```bash
source secrets/load-secrets.sh
for worker in tubepulse-rss-0 tubepulse-rss-1 tubepulse-rss-2 tubepulse-posts tubepulse-aux; do
  (cd "worker/$worker" && npx wrangler deploy)
done
```

Deploy only affected workers during ordinary changes. The loop is the full scheduled-worker rollout. Each `triggers.crons` entry controls that worker's schedule; `tubepulse-cron` deliberately has none.

### 8.3 Pushing secrets to a worker

```bash
./secrets/set-worker-secrets.sh tubepulse-api
./secrets/set-worker-secrets.sh tubepulse-rss-0
./secrets/set-worker-secrets.sh tubepulse-rss-1
./secrets/set-worker-secrets.sh tubepulse-rss-2
./secrets/set-worker-secrets.sh tubepulse-posts
./secrets/set-worker-secrets.sh tubepulse-aux
```

This pushes the secrets required by each worker via `wrangler secret put`. The API uses `YOUTUBE_API_KEY` and Firebase credentials; RSS, posts, and aux require Firebase credentials for notification paths.

### 8.4 Tailing live logs

```bash
source secrets/load-secrets.sh
npx wrangler tail tubepulse-rss-0
npx wrangler tail tubepulse-posts
npx wrangler tail tubepulse-aux
```

Live-streamed logs from the deployed worker. Useful for watching a cron tick fire or debugging an FCM error.

---

## 9. Common operations

### Adding a new endpoint to the API worker

1. Add the handler function in `worker/tubepulse-api/index.js` (use the existing `handleX(request, env, ctx)` pattern)
2. Add a route entry in the main router near line 1729 (look for `path === '/...'` blocks)
3. Test with `npx wrangler dev` and curl
4. Deploy with `npx wrangler deploy`

### Adding a new scheduled job

1. Add the bounded job to the appropriate RSS, posts, or aux worker; keep the retired `tubepulse-cron/index.js` unchanged.
2. Update that worker's `scheduled()` handler and focused tests.
3. Run `npm run check:workers`, deploy only that worker, then verify a Cron Event or bounded live tail.

### Rotating the FCM service account

1. Generate a new key in the Firebase console: `https://console.firebase.google.com/project/tubepulse-470a1/settings/serviceaccounts/adminsdk`
2. Save the new JSON to `secrets/fcm-service-account.json` (overwrite)
3. Verify the new key is the right size: `node -e "const k=JSON.parse(require('fs').readFileSync('secrets/fcm-service-account.json','utf8')); const b=Buffer.from(k.private_key.replace(/-----[^-]+-----|\n/g,''),'base64'); console.log('PKCS8 DER bytes:', b.length);"` — should print `1217`. Anything else is corrupted.
4. Push the replacement to `tubepulse-api`, RSS 0/1/2, posts, and aux using `set-worker-secrets.sh`.
5. Test by triggering a push (next cron tick with a new video, or manually: `curl or invoke the configured API route only after verifying live Cloudflare route state; otherwise use `wrangler dev` for local testing)

### Debugging KV state

The KV namespace is shared and not directly inspectable from the CLI. To see what's in there:
- Add temporary `console.log(...)` calls in the worker, deploy, and tail
- Or write a one-shot debug endpoint that returns specific keys
- For a quick check, the API worker's `/feed` returns the current state for a given device

### Manually forcing a dead-device cleanup (for testing)

1. Get a real FCM token from a device (e.g. by tailing the API worker's logs while the app registers)
2. Kill the token via FCM: `curl -X POST -H "Authorization: Bearer <oauth-token>" -H "Content-Type: application/json" -d '{"tokens":["<fcm-token>"]}' "https://fcm.googleapis.com/v1/projects/tubepulse-470a1/tokens:batchDelete"`
3. Plant the test token on a test device via `POST /register` with that token
4. Subscribe the test device to a real channel via `POST /subscribe-channel`
5. Trigger a WebSub push for that channel (curl a fake `<feed>` XML to `POST /websub`)
6. Tail the API worker's logs — you should see `[Cleanup] device ...` and `[Cleanup] channel ...` lines within ~5 seconds

The cleanup helpers are also unit-testable by adding a temp `POST /_test_cleanup` endpoint that takes a deviceId in the body — verified this way during the v3.0.18 deploy, then the endpoint was removed.

### Monitoring free tier usage

Cloudflare's dashboard shows daily usage: `https://dash.cloudflare.com/<account_id>/workers/overview`. KV usage is at `https://dash.cloudflare.com/<account_id>/storage/kv`. YouTube Data API quota is at `https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas`.

---

## 10. File layout

```
worker/
├── README.md                  ← you are here
├── archive/
│   └── tubepulse-resolver/    ← legacy resolver worker archive; reference only
├── tubepulse-api/             ← app-facing HTTP worker
├── tubepulse-rss-0/           ← active RSS shard 0
├── tubepulse-rss-1/           ← active RSS shard 1
├── tubepulse-rss-2/           ← active RSS shard 2
├── tubepulse-posts/           ← active community-post worker
├── tubepulse-aux/             ← active nag/prewarn worker
└── tubepulse-cron/
    ├── index.js               ← retired no-op entrypoint
    ├── shared.mjs             ← shared scheduled-worker helpers
    └── wrangler.toml          ← no Cron Trigger

secrets/                       ← live credentials, ALL gitignored
├── cloudflare.env             ← CF account ID + API token
├── youtube.env                ← YouTube Data API key
├── fcm-service-account.json   ← Firebase service account
├── load-secrets.sh            ← sources env + generates .dev.vars
├── set-worker-secrets.sh      ← pushes secrets to worker via wrangler
└── README.md                  ← operator docs for secrets
```

The actual KV namespace, Firebase project, and Cloudflare account are not in this repo — they're configured in the workers' `wrangler.toml` (account ID) and the secrets/ directory.

---

## 11. Dead-device cleanup

Both workers implement the same two helpers to remove state for channels and devices that no longer need it:

```js
async function cleanupDeadChannel(channelId, env, reason)
// Deletes channel:{id}:meta, channel:{id}:recent, channel:{id}:websub,
// channel:{id}:subscribers (the empty list left after the last
// subscriber left — v3.0.19 fix to avoid KV orphans)
// Removes channelId from channels:active
// Idempotent. Safe to call on a never-cached channel.

async function cleanupDeadDevice(deviceId, env, reason)
// Reads device:{id}:channels to find every channel the device was on
// For each: removes the device from that channel's subscribers list
//   - if the list goes empty, also calls cleanupDeadChannel
// Deletes device:{id}:profile, :settings, :channels
// Deletes device:{id}:state:{channelId} + :override:{channelId} for each channel
// Idempotent. Safe to call on a never-registered device.
```

**Trigger policy:**

| Trigger | Action | Deletes device profile? |
|---------|--------|-------------------------|
| FCM returns `UNREGISTERED` (HTTP 404) on a push to a device's token | `cleanupDeadDevice(deviceId, env, 'fcm_unregistered')` | **Yes** |
| `/unsubscribe` and the device was the last subscriber on that channel | `cleanupDeadChannel(channelId, env, 'unsubscribe_last')` | **No** — the device profile is preserved so the user can re-subscribe |
| Any other FCM error (`INVALID_ARGUMENT`, `INTERNAL`, `UNAVAILABLE`, `SENDER_ID_MISMATCH`) | No cleanup | n/a — these are transient or config errors, not dead devices |
| App opens with no FCM token (user denied permission) | No cleanup | n/a — the device profile is intentionally retained for `/feed` and `/subscribe-channel` to work |
| Time-based / scheduled cleanup | **None** | n/a — cleanup is purely event-driven |

**Why so conservative?** FCM holds messages for up to 28 days for offline devices. If a phone is off / out of credit / has Do Not Disturb blocking background data, the push will still be delivered when the device comes back. We only cleanup when FCM explicitly tells us the token is gone, which is the only unambiguous signal that the device is unrecoverable.

**Why no time-based expiry for unused channels?** Same reason — the user might be on holiday, between projects, or temporarily using a different device. The KV cost of a few hundred cached channels is negligible; the user-experience cost of "I came back and my watch list is empty" is high.

**Where the helpers live:** the API retains its WebSub-path cleanup implementation; scheduled workers import shared cleanup helpers from `worker/tubepulse-cron/shared.mjs`.

**Idempotency and races:** `kv.delete()` is a no-op on missing keys. If the API and a scheduled worker detect the same dead device in the same window, the second cleanup performs a few extra reads and no-op deletes without corrupting state.

**Log format:** every cleanup emits a single structured line. Watch for sudden spikes — >5 cleanups in a day usually means an app-version bug, a mass uninstall, or someone manually nuking test devices:

```
[Cleanup] channel <id>: reason=<reason> deletedKeys=3 removedFromActive=true
[Cleanup] device <id>: reason=<reason> channelsAffected=<n> channelsCleaned=<n> devicesDeleted=<n>
```

Reason values you may see:
- `fcm_unregistered` — FCM told us the token is dead
- `unsubscribe_last` — the user removed a channel they were the only one watching
- `last_subscriber_dead` — fired inside `cleanupDeadDevice` when removing a dead device empties a channel

**Manually triggering cleanup for testing:** neither worker exposes a public endpoint for this (we don't want arbitrary callers able to nuke device state). For dev/test, use a one-shot script that reads a real FCM token, calls the FCM `tokens:batchDelete` API to kill it, then triggers a WebSub push. The `v3.0.18` release verified the helper end-to-end via a temporary `/_test_cleanup` endpoint that was removed before final deploy.

### 11.1 Device-ID migration on `register`

The client-side `getDeviceId()` is a stable identifier for a given install — but its source has changed over time:

- **v3.0.18**: random UUID stored in AsyncStorage (prone to races that could mint two UUIDs for the same install)
- **v3.0.19**: Android's `Application.getAndroidId()` (per-app-install, stable, but fingerprintable)
- **v3.0.20** → **v3.1.x (current)**: `expo-secure-store` UUID (random, encrypted in Android Keystore / iOS Keychain, hardware-backed on most devices, wiped on uninstall). The current shipping app uses this.

When an existing user upgrades across a version boundary, their `deviceId` changes (e.g. `android:abc...` → `secure:xyz...`), but the FCM token stays the same. Without migration, the user's channels would appear "lost" on upgrade.

When an existing user upgrades across a version boundary, their `deviceId` changes (e.g. `android:abc...` → `secure:xyz...`), but the FCM token stays the same. Without migration, the user's channels would appear "lost" on upgrade.

`/register` runs a two-phase migration to handle this:

1. **Fast path — `fcm:lookup:{fcmToken}` index**: read the index. If it points to a different `deviceId` than the one currently registering, call `migrateDevice(oldId, newId, env)`. This is the common case for cross-version upgrades (v3.0.18→v3.0.19, v3.0.19→v3.0.20).
2. **Slow path — full profile scan**: if the lookup is missing (e.g. rotated FCM token wiped the lookup, or the old device was registered before the index existed), `kv.list({ prefix: 'device:' })` and inspect each profile. For every profile whose `fcmToken` matches the registering token, call `migrateDevice(oldId, newId, env)`. This catches:
   - The v3.0.18 duplicate-UUID race (two old devices, same FCM token) — both get merged into the new device
   - Any case where a user's previous install was on a build that didn't maintain the lookup index

The scan is one `kv.list` per `register` call, costing ~1 KV op per app launch. Negligible against the 100k/day free tier.

**`migrateDevice(oldId, newId, env)`** does the following atomically:
- Reads old device's `channels`, `settings`, and per-channel `state:*` / `override:*`
- For each channel the old device was on: ensures the new device is in that channel's `subscribers` list (and the old device is removed from it)
- Copies per-channel `state:*` and `override:*` to the new device (new device takes precedence if it already has a value)
- Writes the union of old + new channel lists to `device:{newId}:channels`
- Copies old device's `settings` to the new device (new device takes precedence)
- Calls `cleanupDeadDevice(oldId, env, 'migrated_to_new_device')` to clean up the old device's profile/settings/channels/state/override and its `fcm:lookup` entry

**Settings merge rule:** when both old and new devices have settings, the new device's settings are kept. Rationale: the user just installed the new version, so the latest settings (which may have been edited through the new version) are what they want.

**What survives the migration:** the new device's `profile.fcmToken`, `profile.platform`, `profile.appVersion`, `profile.createdAt`, `profile.lastSeenAt`. Migration does NOT copy the old profile — only the channels, settings, and per-channel state. The new device is the canonical install going forward.

**Verified end-to-end** during the v3.0.19 development cycle: two stale device profiles (`974444b4-...`, `5ffc51a1-...`) from the v3.0.18 duplicate-UUID race, both pointing to the same FCM token, were merged into a single new `android:*` device in a single `register` call. All 4 channels survived. The scan-based migration found both old devices and the lookup-based migration found the most recently registered one — they cooperated correctly.

