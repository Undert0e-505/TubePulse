# TubePulse — Cloud Services

This document describes the TubePulse backend: the HTTP API Worker, the active unified Home authority, five retained scheduled Worker deployments, the Cloudflare D1 canonical backup/fallback, YouTube integrations, and Firebase Cloud Messaging. For the current endpoint, trigger, storage, notification, and deployment inventory, start with [CONTRACTS.md](CONTRACTS.md). The Android app is documented separately in the project root README.

The [self-host runtime](../self-host/README.md) executes these same source files through a local workerd-backed runtime with persistent KV. Its Preview and shadow profiles remain additive; the separately guarded unified Home authority is now the production scheduler and fresh feed authority.

`tubepulse-api` retains the former one-device canary wrapper only for history and tests. Production routes every authenticated `GET /feed` to the unified Home store over `TUBEPULSE_HOME_VPC` while replication is current, with D1 fallback. The seven authenticated app mutations are Home-first: the Worker holds the Durable Object global lease, Home runs the unchanged raw API handler against a buffered local KV view, and only a successful semantic response is committed locally. The Worker then durably coalesces the exact deltas in the coordinator's pending D1-backup queue without requiring a canonical cloud read on that request.

`self-host/compose.authority.yaml` is the production successor to the earlier scheduler shadow. One local runtime/store combines signed all-device mutation execution and scheduled work, publishes exact changed-key journals through a SQLite Durable Object coordinator, and serves all authenticated feeds over Workers VPC while current. It performs no periodic full pull. D1 commits are atomic and content-hash guarded. The coordinator conservatively caps scheduler publication at 45,000 estimated rows/day and total coordinated D1 writes at 50,000 estimated rows/day, leaving a 5,000-row app reserve; deferred keys are coalesced and later drained by the existing publication path. App mutations no longer depend on cloud canonical read availability. Semantic `4xx`/`5xx` responses discard the buffered overlay, Home transport failures fail closed, and deferred scheduler batches still suppress FCM. WebSub is acknowledged but suppressed while authority traffic owns detection. RSS0/1/2, posts, and aux deployments are retained but all five Cron Trigger lists are empty and their handlers require an explicit frozen-KV rollback latch.

The current app-facing Worker deployment is version `3925dd9b-ef83-4d37-93eb-563dcba05c14`. Deployment authentication is intentionally external to the repository.

---

## 1. High-level architecture

Current production traffic keeps the existing app URL: `tubepulse-api` coordinates mutations and forwards authenticated feeds through private VPC to the unified Home authority. Cloudflare D1 is the canonical fallback/backup, and the five scheduled Worker deployments below are triggerless rollback artifacts.

```
                                                ┌─────────────────────────────┐
                                                │ YouTube Data API v3         │
                                                │ channels/uploads/statistics │
                                                └──────────────┬──────────────┘
                                                               │ batched poll
                                                               ▼
┌────────────┐     HTTPS     ┌────────────────────┐    fan-out    ┌────────────────────┐
│ Android    │──────────────▶│ tubepulse-api      │◀──────────────│ Home authority     │
│ app        │               │ (Cloudflare Worker)│               │ scheduler + KV     │
│            │◀── FCM push ──│                    │               │ server-side keys   │
└────────────┘               └────────┬───────────┘               └────────────────────┘
                                     │
                                     ▼
                            ┌─────────────────┐
                            │ Cloudflare D1   │
                            │ bounded backup  │
                            └─────────────────┘
                                       ▲
                                       │ rollback only
                                       │
                            ┌──────────┴──────────┐
                            │ scheduled Workers   │
                            │ (triggers disabled) │
                            └─────────────────────┘
```

**One public API Worker, one active unified Home authority, five triggerless rollback Workers, one D1 canonical database, one frozen legacy KV snapshot, one Firebase project.**

| Component | Repo path/config | Purpose | Route/deploy evidence |
|-----------|------------------|---------|-----------------------|
| `tubepulse-api` | `worker/tubepulse-api/` | Current live app-facing API worker source + dormant WebSub callback | The unchanged `workers.dev` endpoint was verified after the D1 cutover; authenticated feeds route Home-first with D1 fallback. |
| `tubepulse-rss-0/1/2` | `worker/tubepulse-rss-{0,1,2}/` | Retained time-derived RSS shards | No Cron Triggers; rollback cadence is five minutes. |
| `tubepulse-posts` | `worker/tubepulse-posts/` | Retained rotating community-post poller | No Cron Trigger; rollback wrapper cadence is one minute. |
| `tubepulse-aux` | `worker/tubepulse-aux/` | Retained bounded nag/prewarn processing | No Cron Trigger; rollback cadence is one minute. |
| `tubepulse-cron` | `worker/tubepulse-cron/` | Retired compatibility stub | Deliberate no-op with `triggers.crons = []`; do not deploy it as the active scheduler. |
| `tubepulse-resolver` | `worker/archive/tubepulse-resolver/` | Historical standalone resolver worker | Archived for reference only; do not deploy unless deliberately restoring historical resolver behaviour. |
| `TUBEPULSE_D1` | D1 database `tubepulse-canonical` | Active canonical backup/fallback state | Bound only to the API Worker; Home is the current primary store. |
| `TUBEPULSE_KV` | Legacy Workers KV namespace | Frozen point-in-time snapshot | Never selected automatically; retained Workers require explicit stale-snapshot acknowledgement. |

> **Verified route:** after the 2026-10-05 D1 cutover, the unchanged app API URL returned Cloudflare-served health and authenticated feeds routed Home-first while authority was current. The health `version` is an API contract label independent from the Android release version. Wrangler intentionally commits no custom route; the existing `workers.dev` endpoint remains enabled.

The API Worker selects D1 through an explicit backend identity and generation. Current scheduled state is owned by Home and journaled into D1 as a bounded backup; live authenticated feeds normally come from Home over VPC. The retained Workers still bind the frozen legacy KV namespace, but default to a no-op unless `TUBEPULSE_ENABLE_FROZEN_KV_ROLLBACK=true` is deliberately set after a quiesced reconciliation.

---

## 2. Retained split scheduled Workers (rollback only)

The retained scheduled Workers have no `fetch()` handler. They are currently triggerless and exist only for an explicit stop-Home-first rollback:

- **No public HTTP surface** — no attack surface, no auth concerns
- **Free-tier CPU bounds on rollback** — each invocation performs one RSS/post channel or a bounded aux batch rather than one large combined scan.
- **Independent rollback deployment** — RSS, posts, aux, and API changes can be deployed separately.

If deliberately re-enabled after Home has stopped and drained, these Workers use the frozen Cloudflare KV snapshot. They must not be activated after D1 has advanced until an exact quiesced reconciliation has made that snapshot current; the explicit latch documents that risk. They are not part of normal production scheduling.

---

## 3. Scheduled work

The active scheduler runs in the unified Home authority and reuses shared runtime helpers from `worker/tubepulse-cron/shared.mjs` and the established notification path. The Cloudflare entry points `worker/tubepulse-rss-0/1/2/index.js`, `worker/tubepulse-posts/index.js`, and `worker/tubepulse-aux/index.js` are retained rollback wrappers; `worker/tubepulse-cron/index.js` is a retired no-op.

**Current schedule ownership:** the three RSS, posts, and aux Workers have no live Cron Triggers. Every aligned five-minute cycle, the unified Home authority batches all active channel IDs through `channels.list` (at most 50 IDs/request), reconciles the uploads playlist only for migration/change/safety-due channels, polls relevant app-visible top-three statistics in batches, and makes the one video notification decision for each eligible device/channel. It checks eligible community posts hourly and runs minute aux only for prewarn/recovery work. RSS is not an automatic fallback.

See [CONTRACTS.md](CONTRACTS.md) for the active worker contract/inventory reference before changing worker behavior.

| Current runtime | Selection/work |
|---|---|
| Home video detector | Sort/de-duplicate `channels:active`; batch `channels.list` by 50; reconcile uploads playlists on baseline/change/six-hour safety due; batch metadata and statistics by 50. A durable known-video watermark prevents deletion/restoration notification cascades. |
| Home posts | Filter active channels through the optional allowlist and poll eligible channels hourly. First-poll seeding sends no notification. |
| Home aligned video owner | After discovery/state updates, scan all `nag:active` pairs and send at most one compatible single or exact-top-three batch per pair when new or due. Reminders are transient; new-upload intents retain durable recovery. |
| Host aux | Drain legacy upcoming work and check prewarn/recovery work each minute. Its rotating video-nag path is rollback-only and skipped while the aligned owner flag is enabled. |

The old RSS shard selector used `floor((scheduledTime ?? Date.now()) / 300000)` and remains tested for rollback. It is historical behavior, not the current production detector. Always read `channels:active` for the current fleet rather than relying on a historical count.

### 3.1 YouTube Data API poll — the active new-video detection path

Since WebSub hub shutdown, Home detects videos through the structural Data API path:

```
channels.list(part=statistics,contentDetails&id=<up to 50 IDs>)
  -> contentDetails.relatedPlaylists.uploads
  -> playlistItems.list(maxResults=50)
  -> videos.list metadata and videos:batchGetStats statistics (up to 50 IDs)
```

Playlist items provide structural upload identity and publication data. Batched video detail/statistics responses provide titles, thumbnails, duration/live status, views, likes, and comments as needed. Any count YouTube omits or hides is stored as `null` (unknown), not as a synthetic zero. An explicit `"0"` remains a real public count.

**Flow for each five-minute cycle:**

1. Read, sort, and de-duplicate `channels:active`.
2. Call `channels.list` in batches of at most 50 IDs. Production currently uses two requests per cycle.
3. Reconcile a channel's cached uploads playlist when its baseline is missing, public `videoCount` changed, or its staggered six-hour safety check is due. A one-time migration marker ensures capturing a count baseline cannot suppress catch-up.
4. Compare playlist IDs against the durable known/high-watermark state, fetch missing detail in 50-ID batches, and pass results through the existing recent/scheduled/live/notification path. New channels seed silently; established channels retain their watermark.
5. Poll due video metrics adaptively in 50-ID batches for only each channel's current app-visible top three. Persist any normalized known view/like change at most once per UTC hour, hydrate missing values immediately, and force unchanged values fresh after 24 hours. Home keeps comment observations locally; comments may piggyback on an already-required canonical write but never trigger one.

**Normal detector quota cost: 576 general units/day.** Two one-unit `channels.list` calls every five minutes yield `2 × 288 = 576`. A six-hour first-page safety sweep adds up to `active channels × 4` general units/day; changed-channel playlist/detail calls are event-driven. `videos:batchGetStats` uses the separately accounted statistics bucket. Request counters persist across restart, reset at Pacific midnight, and enforce reserves. There is no active RSS fallback.

Scheduled public livestreams use a narrower host-only precision window when `TUBEPULSE_HOME_PRECISE_LIVE_WATCH_ENABLED=true`. From five minutes before the scheduled start through fifteen minutes after it, Home batches all due IDs into `videos.list` calls of at most 50 and checks every ten seconds under the existing authority lease. The precision timer is the sole owner between aligned detector ticks; ordinary minute aux cannot add a second check. `actualStartTime` or `liveBroadcastContent=live` confirms the transition; an early active chat does not. Only the normalized predicate reason (`actual-start-time`, `live-broadcast-content`, or `both`) is retained for audit. A changed `scheduledStartTime` re-anchors the window without resetting an existing prewarn sentinel. Missing/private/deleted or lost-upcoming results require two consecutive successful observations; network/API/quota failures never count as cancellation. After T+15, ordinary five-minute detection continues, so a very late start is not blacklisted.

One precision request costs one general quota unit whether the API succeeds or fails. An on-time event therefore costs about 30 calls (T-5 to T), while the full no-start window is at most 120 calls for a concurrent batch of up to 50 events. A separate default 2,000-unit Pacific-day precision cap preserves the normal detector reserve; when unavailable, Home degrades to ordinary detection. Partial-response `fields` reduce payload only, not quota cost. See the official [`videos.list`](https://developers.google.com/youtube/v3/docs/videos/list), [`liveStreamingDetails`](https://developers.google.com/youtube/v3/docs/videos#liveStreamingDetails), and [quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost) documentation.

### 3.2 FCM push from Home

After each aligned discovery pass, Home performs the standard subscriber fan-out:

1. Read `channel:{id}:subscribers` to get the list of devices
2. For each device:
   - Read `device:{id}:profile` (FCM token), `device:{id}:settings`, and `device:{id}:override:{channelId}`
   - Skip if muted via override, or if DND is active and the override doesn't bypass it
   - Sign a JWT using the Firebase service account, exchange for an OAuth token, POST to `fcm.googleapis.com/v1/projects/{projectId}/messages:send`
3. Update `device:{id}:state:{channelId}` with the new `unwatched` list
4. Nag scheduling is handled by Home's timestamp-based bounded aux processor; the video detector adds newly unread channel/device pairs to `nag:active`.

---

## 4. The API worker

`worker/tubepulse-api/index.js` - app-facing API worker source. Line counts in older notes may be stale; check the file directly when needed.

**Route status verified.** The API worker source has a `fetch(request, env, ctx)` entry point and app-facing routes. The app client keeps the existing `workers.dev` endpoint unless a build-time override is supplied. Live verification after the D1 cutover returned Worker health and a Home-routed authenticated feed; review deployed Cloudflare settings before changing route ownership.

### 4.1 Endpoint map

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET`  | `/` | none | Health check returning the Worker status/contract label. The health `version` is independent from the Android app release version. |
| `POST` | `/register` | Bearer | `handleRegister` — create/update device profile (FCM token optional). New clients advertise `notificationCapability: "local-v1"`; missing/unknown values preserve legacy FCM rendering. Two-phase deviceId migration handles cross-version upgrades (see §11.1). |
| `POST` | `/subscribe-channel` | Bearer | `handleSubscribeChannel` — add a channel, fetch cached metadata if needed, and bootstrap recent uploads through `channels.list` → uploads playlist → `playlistItems.list` |
| `POST` | `/unsubscribe` | Bearer | `handleUnsubscribe` — remove a channel and subscriber state; the final subscriber removes it from `channels:active`, stops polling, cleans display caches, and retains the known-video watermark for safe resubscribe |
| `POST` | `/seen` | Bearer | `handleSeen` — mark videos / posts as watched. `ids: [videoId, "post:activityId", ...]` for individual marks; `clearAll: true` for channel-tap (clears all videos and posts for that channel) |
| `GET`  | `/feed` | Bearer | `handleFeed` — return recent videos + community posts for all subscribed channels, with per-device `unwatched` flags merged in |
| `GET`  | `/resolve` | Bearer | `handleResolve` — `@handle` → channelId (Data API, cached 7 days in `handle:*`) |
| `POST` | `/bootstrap` | Bearer | `handleBootstrap` — on-demand channel metadata + recent uploads refresh through the Data API structural path |
| `POST` | `/settings` | Bearer | `handleSettings` — update device notification settings. Accepts `prewarnMinutes` and `includeCommunityPosts` (v3.1) |
| `POST` | `/channel-override` | Bearer | `handleChannelOverride` — set per-channel override. Accepts `prewarnMinutes` and `includeCommunityPosts` (v3.1, tri-state null/value) |
| `POST` | `/_tubepulse/authority/rss-probe` | Authority HMAC | Retained legacy read-only RSS diagnostic. It is not called by the active scheduler and cannot enable an automatic RSS fallback. |
| `GET`  | `/websub` | none | `handleWebSubVerification` — WebSub handshake (dormant) |
| `POST` | `/websub` | HMAC | `handleWebSubPush` — WebSub push delivery (dormant) |
| `OPTIONS` | * | none | CORS preflight — allow any path |

**Auth model:** Every authenticated endpoint requires `Authorization: Bearer <deviceId>`. The `deviceId` is a UUID generated on first launch (via `expo-secure-store` since v3.0.20; previously a random UUID, then `Application.getAndroidId()`). There is no login — the deviceId *is* the auth token. This is acceptable because the KV is private and the deviceId is unguessable (UUIDv4 / Android-ID / secure-store UUID).

A successful authenticated app route for an existing profile is also an activity signal. Home refreshes only that profile's `lastSeenAt`, at most once per installation per hour, and publishes the changed key through the normal authority/D1 coordinator. Mutation routes coalesce the touch into their existing transaction; successful reads schedule a best-effort coordinated touch that cannot make the original response fail. Missing profiles, malformed/failed requests, WebSub, health, monitoring, internal authority and unknown routes never create or refresh a profile. This measures backend contact—including notification taps that invoke `/seen`—not passive push receipt.

### 4.2 Bootstrap-on-subscribe (the most important code path)

When a new device subscribes to a channel, the authority uses the same structural Data API path as scheduled detection:

1. **Resolve channel via Data API** when a handle must be resolved (`channels.list?part=snippet&forHandle=...` or `forUsername=...`) — 1 general unit, cached for seven days.
2. **Obtain the uploads playlist** with `channels.list(part=contentDetails,...)`, then fetch the newest playlist page with `playlistItems.list(maxResults=50)`.
3. Fetch required video metadata/statistics in batches, then cache channel metadata and the recent list.
4. Add the channel to `channels:active` (if this device is the first subscriber)
5. Preserve dormant WebSub bookkeeping for compatibility; it does not own detection.

**A brand-new channel seeds silently.** Its structural bootstrap may require a small number of one-unit general requests plus batched statistics; after that, the five-minute fleet detector and event-driven/safety reconciliation keep it current. Scheduled Home operation never falls back to RSS.

### 4.3 WebSub (dormant)

The WebSub handlers are intact but unused since 2024 (Google's hub was shut down). The code path remains in case a YouTube-compatible hub reappears or you want to integrate with a self-hosted hub.

---

## 5. Canonical key/value schema

Home keeps the current working copy in its persistent local store. D1 generation `production-v1` is the active coordinated cloud backup/fallback for the same logical keys. The legacy Workers KV namespace is frozen and is not part of normal reads or writes.

`worker/tubepulse-api/index.js` - app-facing API worker source. Line counts in older notes may be stale; check the file directly when needed.

| Key | Type | Contents | Written by | Read by |
|-----|------|----------|------------|---------|
| `channel:{channelId}:meta` | JSON | `{ name, avatarUrl, lastVideoId, addedAt }` | API subscribe/bootstrap; Home repairs missing display metadata but does not rewrite solely for `lastVideoId` | API (feed, bootstrap) |
| `channel:{channelId}:subscribers` | JSON array | `[deviceId, ...]` | API (subscribe, unsubscribe) | Home (FCM fan-out), API (unsubscribe cleanup) |
| `channel:{channelId}:websub` | JSON | `{ leaseExpiresAt, hmacSecret, lastVerified }` | API (subscribe, dormant) | (none — never used) |
| `channel:{channelId}:recent` | JSON array | `[{ videoId, title, publishedAt, thumbnail, type, link, views, likes, comments, dislikes, viewsLastCheckedHour?, likesLastCheckedHour? }]` — metrics are decimal strings when known and `null` when hidden/unavailable; persistence clocks gate canonical metric writes | Home Data API scheduler | API (feed, bootstrap), API (subscribe for first-time populate) |
| `channel:{channelId}:recent:posts` | JSON array | `[{ activityId, kind, text, thumbnail, link, publishedAt, fetchedAt, likeCount, viewCount }, ...]`; normalized known engagement changes persist at most once per UTC hour, with hydration and a 24-hour forced refresh | Home posts sweep | API (feed) |
| `channel:{channelId}:firstPollAt:posts` | string | ISO timestamp of the first posts sweep for this channel — drives the first-run guard (**v3.1**) | Home posts sweep | Home posts sweep |
| `device:{deviceId}:profile` | JSON | `{ fcmToken, platform, appVersion, notificationCapability, createdAt, lastSeenAt }`; capability is `"local-v1"` or `null` | API register plus the hourly-throttled coordinated activity touch after successful authenticated app contact | API (any auth call), Home (FCM fan-out) |
| `device:{deviceId}:settings` | JSON | `{ mode, nagInterval, dndEnabled, dndStart, dndEnd, dndTimezone, dndBypass, tapAction, includeCommunityPosts (v3.1), prewarnMinutes (v3.1), ... }` | API (settings) | Home (FCM fan-out filter) |
| `device:{deviceId}:channels` | JSON array | `[channelId, ...]` | API (subscribe, unsubscribe) | API (feed filter) |
| `device:{deviceId}:override:{channelId}` | JSON | per-channel notification override. Accepts `mode?` or `notificationMode?`, plus `nagInterval?`, inherited/per-channel DND fields, `dndBypass?`, `muted?`, `includeCommunityPosts?` (**v3.1**, tri-state null/true/false), and `prewarnMinutes?` (**v3.1**, tri-state null/number) | API (channel-override) | Home (FCM fan-out filter) |
| `device:{deviceId}:state:{channelId}` | JSON | `{ unwatched: [...], lastNagAt, nagCount }` — `unwatched` holds plain videoIds and `post:{activityId}` for community posts (**v3.1** shares the array via `post:` namespace). `lastNagAt` is a timestamp updated after each successful nag push. `nagCount` tracks the number of reminder nags sent (not counting the initial new-video push). Both are reset to `null`/`0` by `/seen` when `unwatched` becomes empty, so the next unread item starts a fresh nag cadence. | Host (new video, nag fire) | Host (nag fire, seen cleanup) |
| `upcoming:events:list` | JSON array | `[{ channelId, videoId, scheduledFor, addedAt }, ...]` — currently-scheduled public live events; `scheduledFor` is re-anchored when YouTube reports a reschedule (**v3.1**, replaces the pre-v3.1 `upcoming:{bucket}` scheme) | Home video detector / precise watcher | Home aux (prewarn) / precise watcher |
| `upcoming:prewarn:{videoId}:{deviceId}` | number | `prewarnMinutes` value at send-time, sentinel for "prewarn sent for this (event, device)" (**v3.1**) | Home aux (prewarn fire) | Home aux (prewarn fire) |
| `upcoming:{bucket}` | JSON array | pre-v3.1 scheduled-livestream entries | (legacy writes only) | Home aux (`runUpcomingCron` drain-only) |
| `nag:{bucket}` | JSON array | **Legacy/unused** — pending nag entries from the old 15-min bucket system. No longer written by any code path. Current production uses aligned timestamp-based notification decisions; flag-off rollback uses `runNag`. | (none — legacy) | (none) |
| `channels:active` | JSON array | `[channelId, ...]` — index of channels with ≥1 subscriber | API (subscribe, unsubscribe) | Home scheduler (Data API video detection, community posts) |
| `handle:{lowercase}` | JSON | `{ channelId, cachedAt }` — 7-day TTL | API (resolve) | API (resolve) |
| `fcm:lookup:{fcmToken}` | string | `deviceId` — reverse index from FCM token to the device that owns it | API (register) | API (register, migration) |

**`channels:active` is the secret sauce.** It replaces a `KV.list()` call — the only way to know "which channels have at least one subscriber" without scanning the entire namespace. The Home scheduler reads its local copy and processes every channel; the retained Cloudflare pollers use the same index on rollback.

**`fcm:lookup:*` is the deviceId-migration index.** When the same FCM token registers with a new `deviceId` (e.g. a v3.0.18 UUID-based install upgrades to v3.0.19's Android-ID-based install), the server uses this index to find the old device and migrate its state. See §11.1.

**Key lifecycle (cleanup):** channel and device keys are cleaned by two helpers, `cleanupDeadChannel()` and `cleanupDeadDevice()` — see §11. When the last subscriber leaves, the channel is removed from `channels:active`, polling stops, and display/subscriber/post caches plus `channel:{id}:known:videos` are deleted. A later re-add starts a fresh lifecycle and silently seeds the then-current uploads rather than replaying everything since the old watermark. Device keys (`profile`/`settings`/`channels`/`state:*`/`override:*`) are deleted only when the FCM token is reported dead. The API cleanup path deletes `fcm:lookup:*`; remaining cleanup differences are documented in [CONTRACTS.md](CONTRACTS.md).

---

## 5.1 Video notification and reminder behaviour

Production enables `TUBEPULSE_HOME_ALIGNED_VIDEO_NOTIFICATIONS_ENABLED` in the ignored authority environment. Tracked examples default it to `false` as deployment insurance. When enabled, Home owns all video notifications on the aligned five-minute detector raster and skips the legacy rotating minute `runNag` path; both owners must never be active together.

After discovery and canonical state updates, Home scans every indexed `nag:active` device/channel pair. One current app-visible unseen video yields a single notification. Two or three yield one batch containing exactly those visible IDs. A fourth remains in `unwatched` but is excluded until deletion/private removal promotes it. New content sends on its detector tick and resets the channel's reminder clock; if no content is new, a reminder sends only when the configured interval is due. New content plus a due reminder on the same tick is one consolidated push.

| Mode | Configured interval | Active aligned interval |
|---|---|---|
| Relentless | 5 min | Exactly 5 minutes; no hidden backoff |
| Relentless | 15 min | Exactly 15 minutes |
| Relentless | 30 min | Exactly 30 minutes |
| Relentless | 60 min | Exactly 60 minutes |
| Relentless | 120 min | Exactly 120 minutes |
| Chill | any | 4 hours |

All intervals are five-minute raster multiples with no former rotating-scan jitter. `nagCount` counts only successfully delivered reminders; `lastNagAt` advances only after successful delivery and is raster-stamped. Both remain in the established state schema for rollback compatibility and reset when `/seen` empties `unwatched`. Failed sends remain eligible for safe recalculation. Resubscription silently seeds the current baseline and never manufactures history.

Every future single or batch video notification for one channel uses `tubepulse-channel-{channelId}`. It therefore replaces that channel's previous surface without colliding with another channel. Swiping does not acknowledge and the notification may return at the next due interval. Single taps acknowledge the exact item; bundle taps open the channel and acknowledge their exact `contentIds`. Server DND defers unseen state until the first eligible aligned tick, while local mute keeps the push visible but silent. New livestream notifications retain their DND bypass contract.

Flag-off preserves the old bounded rotating aux implementation for rollback. It retains the old after-twelve backoff semantics; that behavior is not active production policy. The state and v4.0.0/v4.1.0 `type: nag` and `type: batch` payload schemas require no client migration.

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
| Video or video reminder, single or batch | `tubepulse-channel-{channelId}` | Replaces the current video surface for that channel only |
| Prewarn | `video-{videoId}` | Replaces previous prewarn for the same event |
| Community post | (no explicit tag — defaults to `tubepulse`) | May stack if multiple posts arrive; acceptable for rare community posts |

Different channels don't collide (channel-specific tags). A dismissed notification **will** reappear on the next nag interval — the tag prevents stacking, not re-delivery.

### 5.5 Worker free-tier cautions

D1 rows written are the primary cloud-storage budget concern. The free plan allows 100,000 rows written per UTC day (Cloudflare plan-dependent).

- Each successful reminder changes `device:state` once (one logical canonical mutation; D1 guard/application/cleanup rows are budgeted conservatively)
- Relentless 5-minute mode remains exactly five minutes while content stays unseen, so capacity planning must allow up to 12 reminder-state changes per hour for each continuously eligible device/channel pair
- Multiple test devices on 5-minute Relentless with uncleared items can accumulate writes quickly
- Monitor at: `https://dash.cloudflare.com/<account_id>/workers/d1`
- Do not leave several test devices on 5-min relentless indefinitely

---

## 6. Current cost model

### 6.1 YouTube Data API (free tier: 10,000 units/day)

| Operation | Quota units | When |
|-----------|-------------|------|
| `/resolve` (`channels.list?part=snippet&forHandle=...`) | 1 unit | Per unique handle, cached 7 days |
| `handle:*` cache hit | 0 units | Subsequent lookups for the same handle |
| Home detector — `channels.list` | **576 general units/day** | Production detector = 2 batched calls every 5 minutes = `2 × 288` |
| Six-hour uploads safety sweep | **up to `active channels × 4` general units/day** | One first-page `playlistItems.list` per channel, four times/day; staggered and bounded |
| Changed/migration uploads reconciliation | 1+ general units/channel/event | First playlist page, with pagination only until known overlap or the configured three-page bound |
| New-video metadata | 1 general unit per 50 IDs | Event-driven `videos.list`; requested only where playlist data is insufficient |
| Adaptive engagement metrics | 1 statistics unit per 50 IDs | `videos:batchGetStats`; only each channel's current top three are eligible, with the newest remaining frequent |
| Community posts | 0 units | InnerTube `youtubei/v1/browse` is not a YouTube Data API request |
| **Normal general baseline** | **576 + (`active channels × 4`) units/day plus events** | Detector plus bounded safety; comfortably below the configured 10,000-unit cap and reserve |

Every request, including a failed request, is reserved in persisted Pacific-day accounting before it is issued. Detector work has priority; safety pagination, metadata, and old-video metrics are deferrable. Partial-response `fields` reduce payload, not quota units. RSS consumes no quota because it is not called by the active scheduler.

### 6.2 Cloudflare Workers (free tier: 100,000 requests/day, 10ms CPU per invocation)

| Worker | Invocations/day | CPU per | Notes |
|--------|-----------------|---------|-------|
| Home authority | One minute timer; video work on aligned five-minute boundaries | Bounded | Active video, posts, aux, mutation, and feed authority |
| RSS/posts/aux scheduled Workers | **0** | N/A | Cron Triggers disabled; rollback only |
| `tubepulse-api` (HTTP) | ~20-50 | ~5ms | Depends on app open frequency and action count |

### 6.3 Cloudflare D1 (free tier: 5M rows read/day, 100K rows written/day)

Home scheduled work reads persistent local KV. The API reads D1 only when Home is unavailable or stale, and correctness-sensitive reads use the direct binding's primary database; read replication is disabled. Production app mutations execute Home-first; successful changed keys are later coalesced into the bounded D1 backup journal.

**Rows written are workload-dependent.** New uploads, notification state, app activity, subscription changes, cleanup, posts, aux work, and throttled metric changes share the canonical table. The coordinator reserves three estimated rows per logical mutation (guard insert, canonical row mutation, guard cleanup), caps scheduler publication at 45,000 estimated rows/day and total coordinated writes at 50,000 estimated rows/day, and leaves a 5,000-row app reserve. This deliberately keeps at least half the free daily allowance outside the coordinator budget for accounting uncertainty and operational headroom. D1 `batch()` makes a multi-key commit atomic and reduces round trips; it does not reduce per-row billing. Deferred keys coalesce.

The generic schema has no secondary indexes: `canonical_records` uses a `(generation, key)` primary key, `canonical_backend` records the active manifest, and a short-lived guard table enforces content-hash preconditions. Values over 1.9 MB are rejected before publication, below D1's 2 MB row/value boundary.

### 6.3.1 Historical KV evidence (superseded by D1)

Predeployment evidence supplied from Cloudflare adaptive analytics on 2026-09-20 (approximate and potentially delayed):

- 2026-09-19 recorded about **1,546 writes**.
- 2026-09-20 had recorded about **950 writes by approximately 14:33 UTC**.
- Before the five-minute cron change, RSS ran about **5 invocations per worker per 5 minutes** and the shared namespace recorded about **6–14 writes per 5 minutes**.
- After the cron-only change, RSS ran about **1 invocation per worker per 5 minutes** and the shared namespace recorded about **1–2 writes per 5 minutes**.

Those observations motivated the persistence-code fix and later D1 migration. They are historical Workers KV measurements, not D1 projections.

**Scheduled canonical `list()` calls: 0 in the current code.** The `channels:active` index replaces scheduler-side namespace scans. The API `/register` path intentionally uses the compatibility adapter's prefix list for FCM-token migration; see [CONTRACTS.md](CONTRACTS.md).

**Deletes (cleanup):** dead-device cleanup is event-driven, not scheduled — it only fires when FCM reports a token as `UNREGISTERED`. Each changed/deleted key enters the same D1 row budget and atomic journal. See §11.

### 6.4 Engagement-metric hourly write gate (since v3.0.18, refined 2026-10-05)

Historical context: the 25% rule introduced during the RSS era was initially ineffective because each shard rebuilt the recent array with fresh metrics for every entry. Whole-array change detection therefore persisted routine movement anyway. The likes/dislikes gate also used `viewsLastCheckedHour` instead of an independent likes clock. That implementation defect was corrected before the current hourly policy replaced the percentage threshold.

Current policy (updated 2026-10-05):

- Existing cached videos preserve `views`, `likes`, and `dislikes`; videos below the app-visible top three do not receive further metric observations or persistence-clock state.
- The current top three existing videos are eligible for a metric refresh. A deletion/private transition promotes the new third item immediately without changing durable known-video dedupe history.
- Views use `viewsLastCheckedHour`; likes/dislikes use `likesLastCheckedHour` as an independent group clock.
- Each group can refresh at most once per UTC hour when any normalized known metric changes. Numerically equivalent decimal strings do not create writes. An unchanged known group is forced fresh when it has not been persisted for at least 24 hours.
- New entries seed current API metrics and both clocks. Missing or hidden metrics remain `null`; explicit zero remains zero. Missing legacy clocks are migrated with one refresh. Older synthetic zeros are also repaired once from the current API value even if an earlier worker already assigned them a clock; normal hourly gating resumes immediately afterward.
- Current uploads-playlist order, structural edits, additions/restorations, and removals are still persisted.
- `commentCount` remains requested and parsed for each eligible statistics response. Home stores the latest known/null count and observation timestamp in durable local metric state. Comment movement is excluded from adaptive activity cadence and cannot independently dirty `channel:{id}:recent`; when structure or an allowed view/like update already requires that cache write, the latest comment count may piggyback at no additional canonical-publication cost.

Community-post engagement uses the same any-known-change, once-per-UTC-hour, or 24-hour forced refresh policy, with `fetchedAt` as its persisted observation clock. Missing metrics hydrate once; rotating thumbnail signatures, stable relative-time churn, and same-hour metric movement remain no-ops. The dated shared-namespace observation below is historical RSS-era evidence and is not a guaranteed daily write count.

### 6.5 Historical RSS deployment observation (2026-09-20)

The corrected RSS workers were deployed individually:

| Worker | Version ID | Deployment timestamp (UTC) |
|--------|------------|----------------------------|
| `tubepulse-rss-0` | `dcbe5269-b32c-4302-9c41-8f4477b3ece4` | `2026-09-20T16:12:16.484491Z` |
| `tubepulse-rss-1` | `bb7f3dcc-a63e-4d5e-9cd1-475c11f21e87` | `2026-09-20T16:12:35.539949Z` |
| `tubepulse-rss-2` | `16c3853d-2c76-42d0-be07-ecbdbb7406ed` | `2026-09-20T16:12:54.093884Z` |

All three live schedules were verified as exactly `*/5 * * * *`. From `2026-09-20T16:20:14Z` through `2026-09-20T16:55:14Z`, eight consecutive ticks produced 24/24 successful scheduled `CronEvent`s (8 per worker) with zero scheduled/runtime errors, RSS HTTP errors, fetch errors, FCM errors, or error-level console messages.

The run covered the complete active test set. Every selection matched the five-minute tick calculation, and each shard visited every member before wrapping. There was no starvation or unexpected within-cycle duplicate.

RSS 0 and RSS 1 each produced normal poll output on 8/8 ticks; RSS 2 did so on 6/8. Its other two selections were both `UCvhToxTqKbs0iUgM6MYjTGw`, whose public RSS request returned HTTP 200 and valid feed metadata but zero `<entry>` elements, so both post-fetch early returns were expected. Separately, external monitoring sent one non-cron `workers.dev` `FetchEvent` probe to each scheduled-only worker. Those three probes returned the expected HTTP 500 because these workers intentionally export no `fetch()` handler; they are not scheduled-worker failures and are excluded from the cron health totals.

Cloudflare adaptive analytics for the shared KV namespace reported this adjacent predeployment baseline for `15:30–16:05Z`: `2,3,10,3,6,6,6,1` writes per five-minute bucket, totaling 37 (average 4.625). The settled postdeployment buckets for `16:20–16:50Z` were `1,1,1,2,0,0,2`, totaling 7. The `16:55Z` bucket was still not reported on the final read-only query; a later `17:00Z` row reported 2 writes. Comparing the seven settled postdeployment buckets with the adjacent seven-bucket baseline slice `15:35–16:05Z` (35 writes) is about 80% lower. This is directional shared-namespace evidence, not RSS-only causation: API, posts, and aux also write to the namespace, and adaptive analytics can be approximate, delayed, or omit zero-valued groups.

No API, posts, aux, or retired `tubepulse-cron` worker was deployed during this change. Production KV was not mutated to manufacture traffic, and no test notification push was sent.

### 6.6 Historical one-minute RSS cadence restoration (2026-09-21)

After confirming that the corrected 25% merge/persistence policy materially reduced write churn at the temporary five-minute cadence, all three RSS schedules were restored to `* * * * *`. The handler selection tick was changed with the trigger to `floor((scheduledTime ?? Date.now()) / 60000)`, so each shard advances exactly one position per invocation instead of selecting the same channel repeatedly. The threshold, once-per-hour group limits, 24-hour refresh, and independent view versus likes/dislikes clocks described in §6.4 were not changed.

The comparison baseline captured before restoration at `2026-09-21T06:31Z` was **26 shared-namespace writes since 00:00 UTC**, with zero deletes and zero failed writes. That was approximately four writes/hour and a simple 96-write full-day projection at the five-minute cadence. It is historical context, not a claim about the one-minute result; the scheduled follow-up review will measure the difference after the new cadence has had time to run.

Only the three RSS workers were deployed:

| Worker | Version ID | Deployment timestamp (UTC) |
|--------|------------|----------------------------|
| `tubepulse-rss-0` | `3aa8a2bc-4491-485b-b193-262fbaa39b73` | `2026-09-21T06:44:46.471935Z` |
| `tubepulse-rss-1` | `ad6637f1-8c64-41f5-847b-4f475618f130` | `2026-09-21T06:45:00.662387Z` |
| `tubepulse-rss-2` | `4b21e6e8-46ef-44d3-a498-973286156235` | `2026-09-21T06:45:15.752754Z` |

Cloudflare's trigger read API immediately reported exactly one `* * * * *` schedule per worker, while live event metadata continued to show the previous `*/5 * * * *` trigger during propagation. A triggers-only reapply at `07:06Z` updated the schedule modification timestamps without uploading code or changing the active versions. One-minute dispatch began at `07:20:36Z`.

From `2026-09-21T07:20:36Z` through `2026-09-21T07:24:36Z`, five consecutive aligned ticks produced **15/15 successful scheduled `CronEvent`s** (five per worker). Every event explicitly reported `cron: "* * * * *"`, ran the expected 100%-active version, selected the next channel in its shard, and completed with outcome `ok`, zero exceptions, zero error-level logs, and no RSS/FCM warnings. No channel repeated within any shard's five-tick observation window.

During pre-propagation legacy-cadence ticks, several transient RSS HTTP warnings were observed across channel selections. Those invocations still completed with outcome `ok`, and affected channels were subsequently fetched normally during the qualifying window. The warnings are retained here separately from the clean post-propagation validation and did not prompt any subscription or KV mutation.

No API, posts, aux, or retired `tubepulse-cron` worker was deployed. Production KV was not edited, YouTube/FCM traffic was not triggered manually, and the later scheduled review remains the checkpoint for comparing the new write rate and deciding whether to commit or push.

### 6.7 Historical five-minute RSS cadence restoration (2026-10-03)

After the one-minute cadence was measured against a much larger active-channel set, only the three RSS schedules were returned to `*/5 * * * *`. The handler clock changed with each trigger to `floor((scheduledTime ?? Date.now()) / 300000)`, ensuring that one shard position advances per real invocation rather than skipping positions when a shard length shares a factor with five. Posts and aux remain at `* * * * *`; API and the retired combined cron remain unscheduled. The 25% metric threshold, independent view and like/dislike clocks, 24-hour forced refresh, semantic-change guard, notification behavior, and KV schema were not changed.

| Worker | Version ID | Deployment timestamp (UTC) |
|--------|------------|----------------------------|
| `tubepulse-rss-0` | `0bbca7b7-a476-4dd0-b437-06b7eb35c038` | `2026-10-03T17:59:07.589742Z` |
| `tubepulse-rss-1` | `e87f1465-a4b1-4cd5-bb9b-22e92957d078` | `2026-10-03T17:59:20.058200Z` |
| `tubepulse-rss-2` | `67f202ce-3f81-4cca-aa2e-0d22baed93dd` | `2026-10-03T17:59:31.418475Z` |

Cloudflare's schedule API reported exactly one `*/5 * * * *` trigger for each RSS shard, exactly one `* * * * *` trigger for posts and aux, and no triggers for API or the retired combined cron. During propagation, the new RSS versions briefly received the previous one-minute event metadata; those transitional events were excluded from cadence qualification. From `2026-10-03T18:05:57Z` through `18:10:57Z`, two consecutive aligned ticks produced **6/6 successful scheduled events**. Every event reported `cron: "*/5 * * * *"`, ran the intended 100%-active version, selected a channel, completed with outcome `ok`, and contained zero exceptions and no warning/error-level logs. Each shard selected a different channel on the second tick, demonstrating that the coupled five-minute selector advanced normally.

Historical RSS assessments observed changing fleet sizes and correspondingly changing shard rotations. Those time-stamped inventory counts are intentionally omitted; calculate any rollback latency from the live `channels:active` value using the formula in §3. The predeployment write estimate was a projection rather than a measured post-change outcome, and the larger active set plus other writers in the shared namespace add uncertainty. API/onboarding writes are independent of scheduler cadence and can still cause a high-write day. A full-day observation is required before treating the current reduction as measured.

No API, posts, aux, or retired cron worker was deployed, and production KV was not modified to manufacture traffic. The repository change remains uncommitted pending post-change measurement.

---

## 7. Firebase Cloud Messaging (FCM)

The active Home authority uses FCM v1 for notification fan-out through the shared helper. The API's dormant WebSub path and retained scheduled Workers contain the same helper for compatibility/rollback, but they are not active notification owners.

**Required secret:** `FIREBASE_SERVICE_ACCOUNT`. Production Home reads the mounted, ignored service-account file. Cloudflare Worker copies are needed only for a deliberately reconciled rollback or dormant-path test; never commit the JSON.

**How a push is sent:**

1. Read the service account JSON from `env.FIREBASE_SERVICE_ACCOUNT`
2. Extract the private key (PEM), strip literal `\n` escapes, base64-decode to get the PKCS8 DER
3. Build a JWT with header `{alg: 'RS256', typ: 'JWT'}` and payload `{ iss, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud, iat, exp }`
4. Sign with the private key using RSA-SHA256
5. POST to `https://oauth2.googleapis.com/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={jwt}` → get an OAuth access token
6. POST to `https://fcm.googleapis.com/v1/projects/{projectId}/messages:send` with the access token as a Bearer. The normalized profile capability selects one of two compatible message shapes:
   ```json
   {
     "message": {
       "token": "<device FCM token>",
       "notification": { "title": "...", "body": "..." },
       "data": { "videoId": "...", "channelId": "...", "channelName": "...", "videoLink": "..." },
       "android": { "priority": "high", "notification": { "channel_id": "new-videos", "tag": "video-..." } }
     }
   }
   ```
   Profiles advertising `notificationCapability: "local-v1"` instead receive a high-priority
   data-only message with string `notificationTitle`, `notificationBody`, `notificationTag` and
   `localRender: "1"` fields. Existing/no-capability profiles continue to receive the legacy shape.

**The FCM token can be null on `/register`.** The server accepts null tokens because the user might have denied notification permission. The device profile is still created so `/feed` and `/subscribe-channel` work. Push delivery is just disabled until a real token arrives via `onTokenRefresh`.

**Background push handler** (Android side, in `App.js`): capable data-only pushes are displayed immediately from their payload through the locally selected audible/silent channel, then the handler re-fetches `/feed`, updates local cache and requests a widget render best-effort. Legacy clients retain Android auto-display. The three mute actions alter only device-local sound state; they do not call this API, write D1, change unseen state or replace host-side DND.

**Capability activation is an API + active-host cutover.** The deployed `/register` handler must
persist `local-v1`, and the running Home authority image must pass that profile field through its
durable intent into `sendFCMPush`. Until both are active, an upgraded client intentionally keeps
receiving legacy background notifications without local action categories; a foreground legacy
message may still show actions because the app locally presents foreground messages. Activate and
verify both components together rather than diagnosing that mixed transitional behavior as random
Android action loss.

**Dead-token detection and cleanup:** FCM returns a structured error when a token is no longer valid (user uninstalled, app data cleared, token rotated without our knowledge). The error code is `UNREGISTERED` (HTTP 404) or `NotRegistered` in the body. When `sendFCMPush` sees this, it returns `{ sent: false, deadToken: true }` to the caller, which then calls `cleanupDeadDevice()` to remove the device's full state. Other error codes (`INVALID_ARGUMENT`, `INTERNAL`, `UNAVAILABLE`, `SENDER_ID_MISMATCH`) are transient or config errors and do **not** trigger cleanup — see §11 for the full policy.

---

## 8. Local development

### 8.1 Running a worker locally

```bash
# In one worker directory
source ../../secrets/load-secrets.sh   # sets CLOUDFLARE_* and YOUTUBE_API_KEY
npx wrangler dev                       # starts local miniflare on port 8787
```

Wrangler uses isolated local simulators for KV and D1. Their `.wrangler/` state is gitignored and is never a production seed.

**Secrets permissions:** the `secrets/` directory contains live credentials. The whole directory is gitignored (see `.gitignore` line 23), so perms are not enforced by git. After copying or creating the files, run `chmod 600 secrets/*.env secrets/*.json` and `chmod 700 secrets/*.sh` to make them private to your user. On Windows-native or NTFS-mounted filesystems (e.g. `/mnt/d/...` in WSL) the POSIX mode bits are ignored — security is then controlled by Windows ACLs.

### 8.2 D1 schema and canonical cutover

`worker/tubepulse-api/migrations/0001_canonical_store.sql` is idempotent. Provision the `tubepulse-canonical` database with a Western Europe location hint, keep read replication disabled, set its binding ID in `wrangler.toml`, and apply the migration before deploying the Worker. A safe production cutover is:

1. Build the new Home image while the active authority continues running.
2. Stop and drain Home so the local file lease is released and no canonical mutation can overlap the snapshot.
3. Deploy `tubepulse-api` with `TUBEPULSE_CANONICAL_BACKEND=d1` and a fresh explicit generation. The Worker fails fallback reads and mutations closed until that generation is activated.
4. Run `node src/home-authority-cli.mjs migrate-d1` in a one-off authority container. It exports the exact local canonical snapshot, stages bounded chunks, verifies the D1 manifest, activates the generation, rebuilds Durable Object baselines, and only then archives/clears obsolete KV-pending state.
5. Restart Home, verify authority/D1 status is current with no transaction or pending keys, and exercise read-only feed plus inert mutation canaries.

Never reuse a generation for a different snapshot. The old KV namespace is not dual-written after cutover. Rolling back after D1 has advanced requires stopping Home and reconciling an exact D1 snapshot into the chosen target; merely re-enabling old Cron Triggers would operate on stale data.

Authority recovery uses a set-based D1 snapshot query for all visible rows, then verifies the exact Home manifest before reactivation. It does not issue one D1 query per key, and a SQL `NULL` expiration is preserved as non-expiring. This keeps recovery below D1's per-invocation query limit while retaining the existing 10 MiB snapshot-export bound.

For complete host reconstruction, credential rotation, signed coordinator inspection, pending-journal constraints, quota safety, activation gates, and Windows unattended startup, follow [`self-host/RECOVERY.md`](../self-host/RECOVERY.md). Cloudflare account access cannot reveal existing Worker secret values; lost values must be rotated.

### 8.3 Deploying rollback Workers

The active scheduler is the Home authority and is deployed with `self-host/compose.authority.yaml`. The following loop only updates the triggerless Cloudflare rollback artifacts; it does not make them active and must not be paired with Cron Triggers while Home owns scheduling.

```bash
source secrets/load-secrets.sh
for worker in tubepulse-rss-0 tubepulse-rss-1 tubepulse-rss-2 tubepulse-posts tubepulse-aux; do
  (cd "worker/$worker" && npx wrangler deploy)
done
```

Deploy only affected rollback Workers when deliberately maintaining that path. All five production Cron Trigger lists remain empty; `tubepulse-cron` deliberately has none.

### 8.4 Pushing secrets to a worker

```bash
./secrets/set-worker-secrets.sh tubepulse-api
./secrets/set-worker-secrets.sh tubepulse-rss-0
./secrets/set-worker-secrets.sh tubepulse-rss-1
./secrets/set-worker-secrets.sh tubepulse-rss-2
./secrets/set-worker-secrets.sh tubepulse-posts
./secrets/set-worker-secrets.sh tubepulse-aux
```

This pushes secrets via `wrangler secret put`. Run it only for a Worker that genuinely requires the changed secret. Active discovery and notification credentials live in Home's mounted secret files; do not copy the Home Data API key or FCM credential into unnecessary Workers. Retained scheduled Workers need notification credentials only during an explicitly reconciled rollback.

### 8.5 Tailing live logs

```bash
source secrets/load-secrets.sh
npx wrangler tail tubepulse-rss-0
npx wrangler tail tubepulse-posts
npx wrangler tail tubepulse-aux
```

Live-streamed logs from a deployed rollback Worker. With Cron Triggers disabled, no scheduled events are expected in normal production.

---

## 9. Common operations

### Adding a new endpoint to the API worker

1. Add the handler function in `worker/tubepulse-api/index.js` (use the existing `handleX(request, env, ctx)` pattern)
2. Add a route entry in the main router near line 1729 (look for `path === '/...'` blocks)
3. Test with `npx wrangler dev` and curl
4. Deploy with `npx wrangler deploy`

### Adding a new scheduled job

1. Add active work to the Home scheduler while reusing the established shared helper/notification path; keep the retired `tubepulse-cron/index.js` unchanged.
2. Update the appropriate Home/shared handler and focused tests. Change a retained RSS/posts/aux wrapper only when rollback parity requires it.
3. Run `npm run check:workers` and `npm run check:self-host`; deploy Home through the documented authority flow and verify scheduler status without enabling Cloudflare Cron Triggers.

### Rotating the FCM service account

1. Generate a new key in the Firebase console: `https://console.firebase.google.com/project/tubepulse-470a1/settings/serviceaccounts/adminsdk`
2. Save the new JSON to `secrets/fcm-service-account.json` (overwrite)
3. Verify the new key is the right size: `node -e "const k=JSON.parse(require('fs').readFileSync('secrets/fcm-service-account.json','utf8')); const b=Buffer.from(k.private_key.replace(/-----[^-]+-----|\n/g,''),'base64'); console.log('PKCS8 DER bytes:', b.length);"` — should print `1217`. Anything else is corrupted.
4. Recreate only `home-authority` with the established Compose procedure so the mounted secret is reloaded without replacing `data-authority` or overlapping the scheduler lease.
5. Verify Home readiness/current state and observe the next legitimate notification result. Do not manufacture a user-visible push. Update a retained Worker's secret only if an explicitly authorized rollback requires that Worker to become a notification owner.

### Debugging canonical state

D1 can be inspected with read-only SQL in the Cloudflare dashboard or `wrangler d1 execute --remote` when the operator credential has D1 read permission. Avoid selecting raw values in shared logs; compare manifest hashes/counts through the signed coordinator status. For an application-level check, the API Worker's authenticated `/feed` returns the selected canonical state when Home fallback is active.

### Manually forcing a dead-device cleanup (for testing)

Do not invalidate a production token, plant credentials, invoke dormant WebSub, or add a temporary production endpoint. Exercise dead-token cleanup with the existing mocked Worker/Home tests. A real cleanup should be observed only when FCM naturally reports `UNREGISTERED`, then verified through redacted state/status evidence.

### Monitoring free tier usage

Cloudflare's dashboard shows daily usage at `https://dash.cloudflare.com/<account_id>/workers/overview`; D1 usage and query history are under Storage & databases → D1. The frozen KV namespace remains visible under Workers KV but should show no active canonical writes after cutover. YouTube Data API quota is at `https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas`.

---

## 10. File layout

```
worker/
├── README.md                  ← you are here
├── archive/
│   └── tubepulse-resolver/    ← legacy resolver worker archive; reference only
├── tubepulse-api/             ← app-facing HTTP worker
├── tubepulse-rss-0/           ← triggerless rollback RSS shard 0
├── tubepulse-rss-1/           ← triggerless rollback RSS shard 1
├── tubepulse-rss-2/           ← triggerless rollback RSS shard 2
├── tubepulse-posts/           ← triggerless rollback post wrapper
├── tubepulse-aux/             ← triggerless rollback aux wrapper
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

**Verified end-to-end** during the v3.0.19 development cycle: stale device profiles from the duplicate-UUID race, both pointing to the same FCM token, were merged into a single new `android:*` device in one `register` call. All subscriptions survived. The scan-based migration and lookup-based migration cooperated correctly.

