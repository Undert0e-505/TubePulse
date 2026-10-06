# TubePulse — Architecture Specification

**Version:** Current architecture reference for the v4.x app line. See [STATUS.md](STATUS.md) for current checked-in version and operational caveats.
**Date:** 2026-04-19 (initial), updated through the Home Data API and D1 canonical-backup cutovers on 2026-10-05
**Status:** Architecture reference. Explicitly labelled historical sections retain RSS/WebSub/KV design context; §15.6 and [STATUS.md](STATUS.md) describe current production.

---

## 1. Purpose of this document

This document is the architecture reference for TubePulse. For current repo status, version numbers, and deployment caveats, start with [STATUS.md](STATUS.md). It exists to:

- Specify an architecture that scales from a handful of users to many thousands without rework
- Eliminate the Cloudflare Workers KV list-operation bottleneck that took down the previous version
- Give Jimothy a concrete spec to implement against, rather than vibes

If a future change to TubePulse contradicts something in this doc, either the change is wrong or the doc needs updating first. Don't silently drift.

---

## 2. Problem framing

### 2.1 What TubePulse does

TubePulse is an Android app that notifies users when YouTube channels they care about post new content. Users add channels, the app pushes notifications when those channels publish videos or go live, and a configurable nag cycle nudges users about videos they haven't watched yet.

### 2.2 The load shape

Two fundamentally different things happen at different rates:

- **YouTube publishes a video on a tracked channel.** Sparse and unpredictable. A typical channel publishes 0–3 times per week. Across all subscribed channels in TubePulse, this fires whenever any of them publishes — bursty but low absolute volume.
- **Users care about being reminded of unwatched videos.** Continuous and predictable. Cron-driven, runs whether or not anything new happened.

The previous architecture conflated these — the cron iterated all devices on every cycle, regardless of whether anything was new. This is what burned through KV list operations.

### 2.3 Scale targets

The architecture must handle, without rework:

- 100 active devices
- 100 channels per device maximum
- Total subscriptions in the low thousands
- Daily KV operations within Cloudflare free tier under normal load
- Headroom for peak loads (e.g. a major channel doing a coordinated drop watched by many users)

Beyond this scale, paid tier ($5/mo) is acceptable. The architecture should not require redesign at any point — only additional capacity.

### 2.4 Non-goals

- iOS support (different push infrastructure)
- Multi-region failover (Cloudflare handles this)
- Real-time chat or comments
- Per-device or one-request-per-channel Data API polling; production instead uses fleet-wide batching and structural uploads playlists
- Detecting deleted videos (don't care about stale entries)

---

## 3. Core architectural principle: channel-first

**Channels are the unit of work. Devices are the unit of subscription.**

Every operation should ask "what's happening to this channel" first, then "who cares about this channel". The reverse direction — "what does this device care about" — is only used at subscription change time and when serving a feed request.

This inversion is the single most important decision in this document. The previous architecture was device-first: iterate devices, look up their channels, check for news. It scales as O(devices × channels). The channel-first architecture scales as O(channels with new content × subscribers per channel), which is dramatically smaller because most channels have nothing new on most days.

### 3.1 Why this matters mathematically

For 100 devices averaging 20 channels each with 50% overlap, you have ~1,000 unique channels and ~2,000 subscriptions. Assuming 0.5 publishes/channel/day across the catalogue, that's ~500 publish events/day.

Device-first cron, every 5 minutes:
- 100 devices × 20 channels checked = 2,000 ops per cycle
- 288 cycles/day = 576,000 ops/day
- Plus list operations to enumerate devices: 288/day, each potentially returning all 100 device keys
- Free tier dies inside the day.

Channel-first event-driven:
- 500 publishes/day × ~2 subscribers per publish × ~3 ops per push = 3,000 ops/day
- Free tier handles it comfortably with 30x headroom.

The architectural difference is roughly 100x at this scale, and it widens as you grow.

---

## 4. Component overview

```
YouTube Data API / InnerTube ──poll──▶ unified Home authority ──FCM──▶ Android
                                      │          ▲
                                      │ local KV │ signed VPC feed/mutations
                                      ▼          │
                              Cloudflare API Worker
                                      │
                                      ├── SQLite Durable Object ordering/baselines
                                      └── atomic changed-key deltas ──▶ Cloudflare D1
```

### 4.1 Components

| Component | Role | Triggered by |
|-----------|------|--------------|
| `tubepulse-api` | Current live app-facing REST API, Durable Object coordinator, D1 fallback, and dormant WebSub callback | HTTP requests on the unchanged `workers.dev` URL |
| Unified Home authority | Production app mutation/feed authority plus Data API video, InnerTube post, and aux scheduling | Local Docker timer + signed VPC ingress |
| Retained scheduled Workers | Triggerless RSS/posts/aux rollback and historical code | No active Cron Triggers |

| Cloudflare D1 | Active changed-key canonical backup and Worker fallback | API Worker through the D1 binding |
| Legacy Workers KV | Frozen point-in-time snapshot | Explicit quiesced rollback/reconciliation only; never automatic |
| Firebase Cloud Messaging | Push notifications to devices | Home authority after canonical visibility succeeds |
| Android app | UI, device-local cache, FCM receiver | User + push |

### 4.2 What is NOT a component

- No relational application model: D1 stores the existing opaque canonical key/value contract
- No external message queue; the Durable Object keeps the bounded pending-delta journal required for safe D1 publication
- No separate cloud cache layer; Home local KV serves current reads and D1 is the canonical cloud fallback
- No public Home ingress — the local authority is reached only through the Cloudflare Worker/VPC path

### 4.3 Historical RSS detection path (superseded 2026-10-05)

Google's `pubsubhubbub.appspot.com` hub was **shut down in 2024**. The WebSub handler remains in both workers for:
- Manual testing
- Compatibility with any future YouTube-compatible hub
- As a clean integration point for self-hosted hubs

This was the active video detection path before the Data API cutover. Three rotating **YouTube RSS feed** shard Workers ran on five-minute Cron Triggers, selected channels from `channels:active`, fetched the public Atom feed, and reconciled it against the recent cache plus durable known-video watermark. Their triggers are now disabled; the code is retained only for explicit rollback/history.

**Historical cost:** zero YouTube Data API units. The operational failure history and replacement are recorded in `STATUS.md`.

Current production uses the YouTube Data API for video discovery, uploads reconciliation, metadata, and metrics as well as subscribe/bootstrap work. There is no automatic RSS fallback.

---

## 5. Storage layer (local KV contract + Cloudflare D1)

### 5.1 Why the key/value contract remains

Home and the Worker modules still use the established key/value interface because:

- The "denormalised inverse views" pattern (§5.3) makes JOINs unnecessary
- The access pattern is overwhelmingly key-by-known-ID
- Preserving the interface avoids a risky application-schema rewrite during the storage cutover

Production's cloud adapter stores exact string values in a generic D1 table keyed by backend generation and canonical key. Expired rows behave as absent. A SQLite Durable Object remains the serialization, baseline, and pending-delta coordinator; each D1 commit uses content-hash preconditions and one atomic `batch()`. Batch improves latency/atomicity but does not reduce billed rows. Direct D1 binding reads use the primary database; read replication is not enabled.

The legacy Workers KV namespace is frozen at cutover. There is no automatic read or write fallback to that stale snapshot. A backend identity/generation fence prevents an old transaction from replaying against D1.

### 5.2 One canonical key space

All records live in one logical key space. Prefix conventions distinguish entity types. Home persists that key space locally; D1 is its coordinated changed-key backup and public-Worker fallback.

### 5.3 Key schema

All keys use `:` as separator, lowercase, with stable identifier components.

#### 5.3.1 Channel keys

```
channel:{channelId}:meta
  → JSON { name, avatarUrl, lastVideoId, addedAt }
  Read on:  feed/bootstrap and notification composition
  Written:  on bootstrap and bounded metadata repair; active uploads do not rewrite lastVideoId

channel:{channelId}:subscribers
  → JSON [deviceId, deviceId, ...]
  Read on:  Home notification fan-out
  Written:  on subscribe / unsubscribe

channel:{channelId}:websub
  → JSON { leaseExpiresAt, hmacSecret, lastVerified }
  Dormant compatibility state; not renewed by current production

channel:{channelId}:recent
  → JSON [ { videoId, title, publishedAt, type, ... }, ... ]  (last 15)
  Read on:  /feed, /bootstrap, scheduled/live processing
  Written:  by Home uploads reconciliation and hourly-gated top-three metrics
```

`type` is one of `video`, `live`, `live_scheduled`, `premiere`. See §7.2 for derivation rules.

#### 5.3.2 Device keys

```
device:{deviceId}:profile
  → JSON { fcmToken, createdAt, lastSeenAt, appVersion, platform }
  Read on:  every notification send to this device
  Written:  on /register, on token rotation

device:{deviceId}:settings
  → JSON { mode, nagInterval, dndStart, dndEnd, tapAction, ... }
  Read on:  every notification send (to filter by DND, decide nag mode)
  Written:  on settings change

device:{deviceId}:channels
  → JSON [channelId, channelId, ...]
  Read on:  /feed, /bootstrap
  Written:  on subscribe / unsubscribe

device:{deviceId}:override:{channelId}
  → JSON { mode?, nagInterval?, dndBypass?, muted? }
  Read on:  every notification send for this (device, channel) pair
  Written:  on per-channel settings change
  Note: only created when an override exists for this channel.
        Notification dispatch reads with a fallback to defaults.

device:{deviceId}:state:{channelId}
  → JSON { unwatched: [videoIds], lastNagAt, nagCount }
  Read on:  Home notification fan-out and /feed
  Written:  on notification state changes and /seen
  Note: keyed per (device, channel) to keep individual reads small and
        avoid hot-key contention on a single device:state blob
```

#### 5.3.3 Time-bucket keys

```
upcoming:{YYYY-MM-DDTHH:MM}
  → JSON [ { channelId, videoId, type, scheduledFor }, ... ]
  Read on:  every 5-min cron tick
  Written:  on WebSub push containing a future-dated video

nag:{YYYY-MM-DDTHH:MM}
  → JSON [ { deviceId, channelId, videoIds }, ... ]
  Read on:  every 15-min cron tick
  Written:  on WebSub push (for chill mode 4-hour nudges)
            on /seen (to remove already-seen entries)
            on settings change to relentless (to add re-nag entries)
```

Buckets are aligned to wall-clock minutes (5-min for upcoming, 15-min for nag) so the cron always reads "the bucket for now" without ambiguity.

#### 5.3.4 Index keys

```
channels:active
  → JSON [channelId, channelId, ...]
  Read on:  Home video/post scheduling
  Written:  on first subscriber added to a channel
            on last subscriber removed from a channel
  Note: This is the ONLY list-style index. We maintain it manually
        rather than using canonical list operations in the scheduler hot path. Note: the current API `/register` path intentionally uses the compatibility adapter's prefix list for slow-path FCM-token migration; see [worker/CONTRACTS.md](worker/CONTRACTS.md).
```

### 5.4 Canonical `list()` constraints and current exception

Most hot-path places where the previous version called `KV.list()` now either:

1. Has the data already (channel-first means we know which channel triggered the work)
2. Reads a maintained index key (`channels:active` for lease renewal)
3. Uses a time-bucketed key the cron reads directly

New canonical list calls in hot paths should be treated as suspicious. The current `/register` migration exception is documented in [worker/CONTRACTS.md](worker/CONTRACTS.md).

### 5.5 Historical Worker-era read/write estimates

The following estimates describe the superseded WebSub/Worker design. Current Home/D1 accounting is documented in §15.6.

| Operation | Reads | Writes |
|-----------|-------|--------|
| WebSub push (per subscriber on the channel) | 4 | 2 |
| /register (new device) | 1 | 1 |
| /subscribe-channel | 2 | 4 |
| /unsubscribe | 2 | 3 |
| /seen single video | 1 | 1 |
| /seen clear all for channel | 1 | 1 |
| /feed | 1 + N (where N = subscribed channels) | 0 |
| /bootstrap (per new channel) | 1 | 4 |
| /channel-override (set or update) | 0 | 1 |
| /settings | 0 | 1 |
| Upcoming cron tick (no events) | 1 | 0 |
| Upcoming cron tick (per event firing) | 2 | 2 |
| Nag cron tick (no nags due) | 1 | 0 |
| Nag cron tick (per nag firing) | 4 | 2 |
| Lease renewal cron tick | 1 + N (where N = channels needing renewal) | N |

The "4 reads per subscriber" on WebSub push is: profile + settings + override (if exists) + per-channel state.

These numbers should be verified against the actual implementation. Add KV op counters and log totals daily.

### 5.6 Channel cap

100 channels per device, enforced in the API layer at /subscribe-channel. Reject with 400 if the device's channel count is already at 100.

This is a soft cap — if the requirement changes, raising it requires no schema change, only an API constant.

---

## 6. Historical Worker-era cron jobs

Sections 6–14 retain the superseded Worker/WebSub/RSS design record. Their schedules and ownership are not current production instructions; use §15.6, [STATUS.md](STATUS.md), and [self-host/README.md](self-host/README.md) for current operations.

Four separate scheduled jobs in the same Worker, each with a single responsibility. Splitting them lets each run at its natural frequency without the others becoming a bottleneck. All four use the same KV namespace.

### 6.1 Upcoming events cron — every 5 minutes

```
*/5 * * * *
```

Reads the `upcoming:` bucket key for the current 5-minute window. For each entry:
- If `type == live_scheduled` and `scheduledFor` is exactly 30 minutes away, fire "live soon" notification
- If `type == live_scheduled` and `scheduledFor` has passed, fire "live now" notification and reschedule into the nag system

Cost per tick: 1 read minimum, 2 reads + 2 writes per event firing. Most ticks have nothing in the bucket.

### 6.2 RSS shard crons — historical rollback path

```
*/5 * * * *
```

This section documents the pre-cutover RSS implementation. Its Cron Triggers are disabled and it is not an automatic fallback.

1. Read `channels:active` index from KV and derive the active shard count
2. In each active shard, select one channelId from the sorted shard slice for the current five-minute epoch tick:
   - Fetch `https://www.youtube.com/feeds/videos.xml?channel_id={id}` (no API key, no quota)
   - Parse the Atom feed — extract videoId, title, publishedAt, thumbnail, link, **and views** (from `media:community/media:statistics/@_views`)
   - Compare against `channel:{channelId}:recent`
   - For each new videoId: update recent list, look up subscribers, send FCM
3. New videos flow through the same notification pipeline as WebSub pushes would

The shards therefore process up to three channels per five-minute tick. For `N` active channels, the selector activates `S = min(3, max(1, ceil(N / 5)))` shards and assigns the stable sorted list round-robin, so each shard contains either `floor(N / S)` or `ceil(N / S)` channels. A shard's full rotation is `5 minutes × its channel count`; expected detection is approximately half a rotation. `channels:active` is the source of truth for the current count, so time-stamped operational status should be used instead of embedding a changing production count here. Rotation coverage is tested for every active-channel count from 1 through 100.

**Historical quota cost:** 0 YouTube Data API units.

**Historical KV cost model:** one read per channel per tick (`channel:{id}:recent`), with writes when a view count changed or a new video was detected. This pre-D1 estimate is retained only as design history; the current Home/D1 path uses coordinated changed-key publication and D1 row budgets.

**Historical rationale for RSS:**
- RSS includes the data we need: videoId, title, publishedAt, thumbnail, link, AND view counts (from `media:statistics/@_views`)
- Zero YouTube Data API quota cost
- Less brittle than depending on the API staying within quota
- The same detection contract (new video → fan out to subscribers → FCM push) works identically
- This rationale was superseded when production adopted batched `channels.list`, uploads-playlist reconciliation, and separate batched statistics.

### 6.3 Nag cron — every 15 minutes

```
*/15 * * * *
```

Reads the `nag:` bucket key for the current 15-minute window. For each entry:
- Read device profile + settings + per-channel override
- Filter by DND, mode, etc. (override beats settings beats default)
- Send FCM notification
- Compute next nag time and schedule into the next bucket (chill: +4h; relentless: +nagInterval)

Cost per tick: 1 read minimum, 4 reads + 2 writes per nag firing.

15 minutes is fine for nags because nag frequency is configured in 5-min minimum increments — worst case a "5-minute" nag fires up to 15 minutes late. Document this in user-facing settings as "approximately every 5 minutes".

### 6.4 WebSub lease renewal cron — every 6 hours (DORMANT)

```
0 */6 * * *
```

**Currently a no-op.** The `pubsubhubbub.appspot.com` hub has been defunct since 2024. Kept in the schedule so we can flip it back on instantly if a compatible hub reappears. Code path reads `channels:active`, checks `channel:{channelId}:websub.leaseExpiresAt`, and would re-subscribe to the hub if needed.

### 6.5 What's NOT in any cron

- "Check channels for new videos" — done by the Data API poller (6.2), not by a device-iteration loop
- "Iterate devices to find unwatched videos" — devices already have local state; nags are pre-scheduled
- "Refresh channel metadata" — done lazily on next poll or bootstrap

---

## 7. WebSub push handling

**Status: dormant but intact.** Code is in `tubepulse-api/index.js` (`handleWebSubVerification`, `handleWebSubPush`). Not used as the active detection path since 2024. Kept for:
- Manual smoke tests
- Future YouTube-compatible hub revival
- Self-hosted hub integration

The active detection path is described in §6.2.

### 7.1 Verification (GET /websub)

Standard WebSub challenge-response. Read `channel:{channelId}:websub` to verify the request matches a subscription we initiated. Return the challenge token if valid, 404 otherwise.

### 7.2 Push delivery (POST /websub)

If a push ever does arrive (e.g. from a self-hosted hub), the handler does the same work as the Data API poller:

```
1. Verify HMAC signature against channel:{channelId}:websub.hmacSecret
2. Parse the Atom feed payload — extract videoId, title, publishedAt
3. Determine type:
   - publishedAt > now() + 5min  → live_scheduled (it's a future-dated entry)
   - title starts with "🔴" or contains "LIVE"  → live (heuristic, refine over time)
   - default                                    → video
4. Read channel:{channelId}:recent
5. If videoId is already in recent → ignore (WebSub can deliver duplicates)
6. Prepend new entry; trim to 15 most recent; write back
7. Read channel:{channelId}:subscribers
8. For each deviceId in subscribers:
   a. Read device:{deviceId}:profile + device:{deviceId}:settings
   b. Read device:{deviceId}:override:{channelId} (may be null — that's fine)
   c. Resolve effective settings: override fields beat base settings
   d. If muted via override → skip entirely
   e. If DND active and dndBypass not set and not a livestream
      → skip immediate notification; schedule a batched nag for end of DND
   f. Send FCM with appropriate payload
   g. Update device:{deviceId}:state:{channelId} with new unwatched videoId
   h. Schedule next nag in nag bucket (4h ahead for chill, nagInterval ahead for relentless)
9. If type == live_scheduled:
   - Write entry into upcoming:{publishedAt - 30min} bucket (heads-up)
   - Write entry into upcoming:{publishedAt} bucket (live-now)
```

### 7.3 Why WebSub is a hard requirement (historical, not current)

WebSub was the preferred path because it was push-based, free, and standard. The shutdown of Google's hub in 2024 changed the calculus. The fallback that was always sketched in the design is now the production path: poll the YouTube Data API on a cron schedule, with the same "process new video for channel" function the WebSub handler uses.

**Quota math (§6.2 revisited):** the five-minute detector batches up to 50 channel IDs per request. Capacity planning must use the active subscription set, safety reconciliation formula, event-driven metadata requests, and the configured daily reserve rather than a hard-coded fleet example.

---

## 8. API endpoints

All endpoints accept `deviceId` as authentication (device-generated UUID, registered on first launch). No JWT, no OAuth. The deviceId is the secret.

### 8.1 POST /register

Initial device registration or FCM token refresh.

Request: `{ deviceId, fcmToken, platform, appVersion }`
Response: `{ ok: true }`

Writes `device:{deviceId}:profile`. Idempotent — safe to call on every app launch.

### 8.2 POST /subscribe-channel

Add a channel to this device's subscription list.

Request: `{ deviceId, channelId }`
Response: `{ ok: true, alreadySubscribed: false, channel: { ... } }`

Logic:
1. Read `device:{deviceId}:channels`
2. If already at 100 channels, reject with 400
3. Add channelId; write back
4. Read `channel:{channelId}:subscribers`; add deviceId; write back
5. If `channel:{channelId}:meta` doesn't exist, run bootstrap (fetch RSS, write meta + recent)
6. If we just became the first subscriber, add to `channels:active` index and initiate WebSub subscription

### 8.3 POST /unsubscribe

Remove channel from this device. Logic mirrors subscribe in reverse. If we're removing the last subscriber, cancel WebSub subscription and remove from `channels:active`.

### 8.4 POST /seen

Mark videos as seen.

Request: `{ deviceId, channelId, videoIds?, clearAll? }`

Logic:
1. Read `device:{deviceId}:state:{channelId}`
2. Remove specified videoIds (or all if `clearAll: true`)
3. Write back
4. Pending nag bucket entries are not actively cleaned up — instead, when the nag cron tries to fire, it re-checks state and skips videos that are no longer unwatched

### 8.5 GET /feed

Get current feed for this device. Used for initial app load and pull-to-refresh.

Response: `{ channels: [{ channelId, meta, recent, unwatchedCount }, ...] }`

Reads `device:{deviceId}:channels`, then for each channel reads `meta`, `recent`, and `state` (per-device unwatched). N+1 reads but bounded by the 100-channel cap.

### 8.6 GET /resolve

Resolve a YouTube handle (`@MrBeast`) or username to a channelId.

Uses YouTube Data API (`channels.list?forHandle=...` with `forUsername` fallback). Costs 1 quota unit per call. Cache results in a `handle:{lowercased}` key for 7 days to avoid re-resolving.

### 8.7 POST /bootstrap

Initial fetch of channel data. Fetches the RSS feed, writes meta + recent, then returns to the client.

Synchronous (caller waits for the result) so the app can show the channel immediately after add.

### 8.8 POST /settings

Update device-level notification settings.

Request: `{ deviceId, settings: { mode, nagInterval, dndStart, dndEnd, tapAction, ... } }`

Writes `device:{deviceId}:settings`. Full replacement, not partial update.

### 8.9 POST /channel-override

Set or update per-channel notification override.

Request: `{ deviceId, channelId, override: { mode?, nagInterval?, dndBypass?, muted? } }` — any field can be omitted to inherit from device-level settings. Empty `override: {}` deletes the override entirely.

Writes `device:{deviceId}:override:{channelId}` (or deletes it if the override is empty).

---

## 9. Android app responsibilities

### 9.1 What the app does

- Maintains local cache of subscribed channels and their recent videos in AsyncStorage
- Renders the channel list and video list from local cache
- Calls `/subscribe-channel` and `/unsubscribe` when user adds/removes channels
- Calls `/seen` when user taps a video or "mark all seen" on a channel
- Calls `/register` on first launch and on FCM token rotation
- Calls `/feed` on pull-to-refresh and initial app load (after register)
- Receives FCM pushes and updates local cache + UI

### 9.2 What the app does NOT do

- Poll the API for updates (FCM is the source of truth for new content)
- Cache things server-side (the device is the cache)
- Try to be smart about backend state (treat `/feed` response as authoritative)

### 9.3 Local-first vs server-first

The app should feel instant. That means:

- Reads come from AsyncStorage first, network second
- Writes update AsyncStorage immediately, then call the API in the background
- API failures are visible but don't block the UI
- Pull-to-refresh shows the API as the merge target (server data wins on conflict)

### 9.4 Notification handling

When an FCM push arrives:

1. Update `state:{channelId}` in AsyncStorage to reflect new unwatched video
2. Update the local channel cache to include the new video in recent
3. If app is in foreground, refresh the visible UI silently
4. The notification itself is shown by Android regardless of app state

---

## 10. Failure modes and recovery

### 10.0 Current unified Home recovery boundary

The production authority is local-first with coordinated D1 backup, not the historical Worker/KV-only design described in the subsections below. Feed reads can fall back to D1 when Home is unavailable, while authenticated mutations fail closed whenever the Home/coordinator/VPC ordering contract cannot be guaranteed. Exact cloud recovery uses the active D1 generation plus the Durable Object baseline, transaction, and pending journal; frozen Workers KV is never an automatic source.

Current startup performs exact reconciliation when either the local or coordinator status is stale, including after an expired unclean-stop lease makes Home stale. It does not yet prove a full local-versus-D1 manifest when both persisted markers say `current`. Reconciliation also refuses while coordinator backup work is pending, so proposed always-verify startup must drain/retry that work within bounds before taking a recovery snapshot. It must never clear an unverified journal.

D1 covers the coordinated canonical key space, not host-only scheduler/quota JSON, notification-intent history, credentials, runtime configuration, or Windows startup policy. Notification delivery intentionally uses at-most-once behavior at an ambiguous FCM `sending` boundary: pending work can recover, but one push can be lost rather than duplicated after a crash. Upstream/network failure is a dependency outage, not permission for destructive restart or state reset.

The authoritative current-state audit, checked-in Windows startup supervisor, zero-local-backup reconstruction procedure, credential-rotation matrix, exact D1 reconcile sequence, failure branches, and safe activation checks are in [`self-host/RECOVERY.md`](self-host/RECOVERY.md). Sections 10.1–10.5 below document historical Worker-era failure assumptions and must not override that runbook.

### 10.1 WebSub subscription expires without renewal

Symptoms: stop receiving pushes for a channel.
Recovery: Lease renewal cron runs every 6 hours and renews anything within 24h of expiry. Worst case: 6h gap between detection of expiry and renewal.
Defense: 24h-ahead renewal window means we'd need 24h+ of cron downtime to actually miss anything.

### 10.2 KV write fails mid-operation

Symptoms: partial state — e.g. device is in `channel:subscribers` but channel isn't in `device:channels`.
Recovery: idempotent operations. Re-running subscribe is safe (it adds-if-not-present). Periodic consistency check job (weekly) reconciles by reading both sides of every relationship.
Defense: write the inverse-view keys in a consistent order so partial failure leaves a known partial state.

### 10.3 FCM send fails

Symptoms: notification never arrives.
Recovery: don't update nag state until FCM ack received. Next cron tick will retry (up to a max retry count).
Defense: log all FCM failures with the full payload to a `fcm_errors:{date}` key for diagnosis.

### 10.4 Device deleted from Play Store but FCM token still valid

Symptoms: pushes continue forever to a phantom user.
Recovery: FCM returns `NotRegistered` for uninstalled apps. On that error, delete `device:{deviceId}:*` keys and remove deviceId from all `channel:*:subscribers` arrays.
Defense: include cleanup-on-FCM-error as part of the standard send path.

### 10.5 KV throttling

Symptoms: 429 errors on writes when burst exceeds rate limits.
Recovery: API endpoints return 503 with Retry-After; app retries with exponential backoff. WebSub pushes don't retry from YouTube's side, but the next push for the same channel will catch us up.
Defense: alert at 80% of any KV limit and investigate before hitting the wall.

---

## 11. Observability

Cloudflare provides per-namespace KV operation counts in the dashboard, but only at daily granularity. For operational monitoring we need finer detail.

### 11.1 Metrics to capture

In a single `metrics:{YYYY-MM-DD}` key, append (or overwrite-with-merge):

```json
{
  "websub_pushes": 1234,
  "fcm_sends_success": 4567,
  "fcm_sends_failed": 12,
  "api_requests": { "register": 100, "subscribe-channel": 50, ... },
  "cron_runs": { "upcoming": 288, "nag": 96, "lease": 4 },
  "kv_ops": { "reads": 23456, "writes": 7890, "deletes": 12 }
}
```

Workers update this key in batches (e.g. flushed every 5 minutes from worker memory) to avoid one-write-per-event amplifying KV usage itself.

### 11.2 Alerts

- Cloudflare email alert at 80% of any KV limit (configured in dashboard)
- Daily summary: write the previous day's `metrics` key to a Telegram webhook
- WebSub subscription health: weekly job that verifies every `channels:active` entry has a non-expired lease

---

## 12. Implementation order

**All steps completed 2026-04-20 → 2026-06-02 (v3.0.0 → v3.0.13).** Kept here as the historical record of the build sequence.

1. **Set up KV namespace and a smoke-test Worker.** Create a few keys in the new schema, verify reads work.
2. **Build the channel-first WebSub handler.** Highest-value piece — both the hot path and the architectural inversion that makes everything else work. Test with a single subscribed channel before moving on.
3. **Build the API endpoints.** Register, subscribe, unsubscribe, seen, feed, resolve, bootstrap, settings, channel-override. Each should be unit-testable.
4. **Build the nag bucket cron.** Verify nag entries flow from WebSub push → bucket → fired notification.
5. **Build the upcoming events cron.** Verify scheduled livestreams fire heads-up and live-now correctly.
6. **Build the lease renewal cron.** Last because it's the slowest-ticking job and easiest to verify works.
7. **Update the app to talk to the new API.** Local cache, FCM payload handling, all endpoint calls.
8. **Observability.** Metrics key updates, alerts, daily summary push to Telegram.

**Post-v3 additions:**
- **YouTube Data API poller (Job 2.5)** — added after WebSub hub shutdown was confirmed. Replaces WebSub as the active detection path. Same fan-out logic, different input source.
- **FCM JWT signing fixes** — PKCS8 base64 padding, `\n` escape handling. Without these, no push could ever deliver.
- **v3.0.13 release pipeline** — `build-and-release.ps1` rewritten as a Windows-native Gradle build with GitHub release publishing. See [RELEASE.md](RELEASE.md) for current release-process risks and the target cleanup flow.

---

## 13. Things this document deliberately doesn't specify

- Code style or language choices within Workers
- Specific FCM payload structure (implementation detail)
- App UI layout or navigation (separate concern)
- YouTube Data API implementation details beyond the persisted detector/statistics budgets documented in §15.6
- Logging format (be consistent, but use whatever)

These can vary with implementation and will appear in the codebase as they're built.

---

## 14. Historical v3.1 deltas (2026-06-04)

v3.1 is a strict superset of v3.0 — the channel-first, zero-`KV.list()`, time-bucket architecture in §§1-12 is unchanged. The following sections were added or modified for the v3.1 release. For full design notes see [PLAN_v3.1.md](PLAN_v3.1.md); for the current shipping state see [STATUS.md](STATUS.md).

### 14.1 Likes + dislikes

- **RSS parser** in both workers extracts `media:starRating/@_count` (likes) and `media:statistics/@_dislikes` into the recent list and per-video state. Dislike counts from YouTube's public feed are zeroed out for almost all videos since Nov 2021 — captured for completeness, expected to be `0`.
- **Throttle**: same hourly top-of-list policy as view counts (§6.4 in [worker/README.md](worker/README.md)), but likes/dislikes write on **any change** (not the 5% threshold for views), since they're useful at any scale.
- **Backfill**: videos with `likes: 0, dislikes: 0` from pre-v3.1.1 are refreshed within an hour of the v3.1.1 deploy, the first time their channel's top video's metrics change.
- **App**: HomeScreen meta row now renders `age · likes · dislikes · views` with greyscale outline thumb icons (U+FE0E text-presentation + `COLORS.textDim` color). Zero values are skipped to keep the row tight.

### 14.2 Community posts

- **New KV key** `channel:{channelId}:recent:posts` — last 30 posts: `{ activityId, kind, text, thumbnail, link, publishedAt }`.
- **New KV key** `channel:{channelId}:firstPollAt:posts` — ISO timestamp of the first posts-cron run, drives the first-run guard (populate recent without notifying on first install or feature enable).
- **New cron job** `runCommunityPostsCron` — `mins === 0` (every hour). Polls YouTube Data API `activities.list` for each channel in `channels:active`. ~1 unit/channel/hour.
- **First-run guard**: on first poll for a channel, recent list is populated but no pushes fire. Subsequent polls notify on genuinely new posts.
- **Post IDs share `device:{id}:state:{channelId}.unwatched` with videos** via the `post:{activityId}` namespace — no separate state array, no separate seen endpoint, `/seen` accepts the namespaced IDs transparently.
- **Settings**:
  - Global `includeCommunityPosts` (boolean, default off, v3.1+). Toggled on in SettingsScreen.
  - Per-channel `includeCommunityPosts` override (tri-state null/true/false) — null inherits global.
- **App**: new post card in HomeScreen with thumbnail (or speech-bubble placeholder for text-only posts). "Posts" mini-header above post cards. Post tap → mark seen + open community tab.
- **Posts do NOT enter the nag cycle** — only the initial push fires. The plan did not require post nagging; adding it would need a parallel nag bucket and FCM payload differentiation. Flagged for v3.2.

### 14.3 Prewarn for scheduled livestreams

- **New KV key** `upcoming:events:list` — JSON array of currently-scheduled live events `{ channelId, videoId, scheduledFor, addedAt }`. Replaces the pre-v3.1 `upcoming:{bucket}` scheme.
- **New KV key** `upcoming:prewarn:{videoId}:{deviceId}` — set to the prewarnMinutes value when a prewarn push has been sent for that (event, device). Acts as a sentinel to prevent double-send.
- **New cron job** `runPrewarnCron` — every 5 min. Iterates `upcoming:events:list`, computes the per-device prewarn time (per-channel override → global setting → default 60 min), fires an FCM push if the window is open. Events pruned 24 h after `scheduledFor` along with their sent keys.
- **Repurposed** `runUpcomingCron` is now a **drain-only** job — reads the current `upcoming:{bucket}` and deletes it. This clears any pre-v3.1 bucket entries on the first tick after upgrade so the old "going live in 30 minutes" / "is live now!" pushes cannot fire for events scheduled before the upgrade.
- **Design**: the prewarn is the heads-up; the regular new-video push at live time is the "this just appeared" notification. There is no separate "is live now!" push. `type: 'live'` videos bypass DND by default.
- **Settings**:
  - Global `prewarnMinutes` (default 60, options 15/30/60/120/240/1440). 6-option picker in SettingsScreen.
  - Per-channel `prewarnMinutes` override (tri-state null/number) — null inherits global.
- **App**: prewarn push tap opens the YouTube watch URL for the scheduled video. The video is **not** marked as seen on tap — the prewarn is a reminder, the live-time push will still fire later.

### 14.4 Custom ConfirmDialog

- New `src/components/ConfirmDialog.js` — themed modal with dark backdrop, `COLORS.surface` card, `COLORS.danger` destructive button.
- New `src/components/Confirm.js` — promise-based `confirm({ title, message, confirmText, cancelText, destructive })` helper. Singleton state; reentrant calls queue (replace current prompt).
- Replaces `Alert.alert` for the channel-removal flow in `ChannelsScreen.removeChannel`. `App.js` mounts `<ConfirmHost />` inside `GestureHandlerRootView` (after the `NavigationContainer`) so the dialog can overlay any screen.
- Pure UI change, no server work, no new dependencies.

### 14.5 v3.1.1 bug fixes (shipped post-v3.1.0)

- **API `getFeedPostsForChannel` env bug**: the function was defined without an `env` parameter but referenced `env.TUBEPULSE_KV` inside, throwing `ReferenceError: env is not defined` on every `/feed` call. Fixed in commit `f985845` — the function now takes `env` as the first parameter, matching every other KV-touching helper.
- **Cron RSS likes/dislikes wiring**: the v3.1.0 likes/dislikes commit only modified the API's WebSub path. The cron's RSS parser (the actual hot path for new-video detection) never got `media:community` extraction, so all v3.1.0 videos had `likes: 0, dislikes: 0` stored. Fixed in commit `a4cc838` — `parseRSSFeed` now extracts likes/dislikes and the new-video enrichment writes them into `channel:{id}:recent` alongside views.
- **ConfirmDialog wiring**: v3.1.0 created the `ConfirmDialog` component but never wired it up. `ChannelsScreen.removeChannel` still called `Alert.alert` and `App.js` never mounted `<ConfirmHost />`. Fixed in `a4cc838` — `removeChannel` now uses `confirm({ destructive: true })` and `App.js` mounts the host.

---

## 15. Self-host runtime preview (2026-09-20)

The repository now includes an additive [`self-host/`](self-host/) package. It does not alter the deployed Cloudflare topology. The current app URL and every Wrangler deployment/configuration remain the production defaults.

### 15.1 Runtime boundary

Miniflare starts one workerd instance containing named entrypoints for the existing API, RSS shard, posts, and aux modules. Every entrypoint binds the same persisted local `TUBEPULSE_KV` namespace. A small Node listener owns operational routes, dispatches normal HTTP requests into the unchanged API Worker, and dispatches scheduled events on aligned boundaries.

```text
Node listener
  ├── /_tubepulse/status + authenticated admin control
  └── app routes ──> workerd: tubepulse-api ──┐
                                               ├── persistent local KV
aligned scheduler ──> workerd: rss/posts/aux ─┘
```

Posts and aux run once per aligned minute. All three RSS shards run once per aligned five-minute boundary. A per-entrypoint lock skips overlap rather than running the same handler concurrently. Standalone mode activates the scheduler at boot; mirror mode stores an explicit active/standby role and never automatically fails back.

Miniflare is primarily Cloudflare's local development/testing harness, so this capability is labeled preview. `self-host/src/runtime.mjs` is an adapter boundary for a future direct-workerd implementation.

### 15.2 Mirror consistency

Mirror synchronization is key-level three-way reconciliation among local state, current Cloudflare state, and a durable last-shared baseline. Content hashes and expirations are compared without storing values in the conflict ledger. Pull updates only clean local keys. Push is dry-run unless explicitly applied and verifies that current remote content/expiration still matches the baseline before every mutation. Conflicting values are retained on both sides.

The design does not provide a distributed transaction across related keys or multi-node leader election. Cloudflare's eventually consistent listing/value reads can also span different instants. Cached FCM access tokens, FCM lookup-index keys, and WebSub leases are excluded because they are installation-specific. See the [self-host operations guide](self-host/README.md) for recovery and backup requirements.

### 15.3 Client failover

`src/utils/api.js` keeps the historical `workers.dev` URL as its exact default. Builds may specify a primary and optional fallback through statically analyzable Expo public environment variables. Network failures and HTTP `429`, `502`, `503`, or `504` receive one fallback attempt. Client/auth errors do not. A successful fallback is sticky for that process; there is no implicit failback.

Fallback requests carry `X-TubePulse-Failover`. Optional automatic mirror takeover is off by default and additionally requires a successful app API route whose unchanged bearer profile matches the Cloudflare-derived sync baseline. The header is a signal, not authentication. Manual admin takeover remains the recommended initial operating model.

### 15.4 Side-by-side Android test client

The `selfhost` Android build type keeps the normal Java/Kotlin namespace but adds the application-ID suffix `.selfhost`, yielding `com.tubepulse.app.selfhost`. Android therefore treats it as a separate installation with separate app data, secure storage, widget receiver action, and launcher label. The build remains debuggable/debug-signed while React Native still runs `createBundleSelfhostJsAndAssets`; only the ordinary `debug` variant is excluded from bundling.

`scripts/Build-SelfHostApk.ps1` enables Preview mode and supplies a first-run URL suggestion, not an accepted endpoint. Before normal app initialization, the Preview UI validates the absolute URL, performs a read-only API health probe, and persists the accepted origin. Every API caller resolves that origin at request time; Settings can health-test and switch it without a rebuild, while Preview never falls back to production. A source-set manifest enables cleartext HTTP only for private/LAN hosts in this test build. The main manifest has no cleartext opt-in, and the normal `com.tubepulse.app` application ID remains unchanged.

The no-new-Worker pilot runs under a distinct `tubepulse-pilot` Compose project and binds local KV/runtime state from `self-host/data-pilot`, never the ordinary `self-host/data` directory. Its `TUBEPULSE_PILOT` runtime boundary requires standalone mode, disables Cloudflare synchronization credentials, and refuses automatic takeover, Cloudflare writes, or automatic push even if an operator attempts to enable them.

### Existing-app canary gateway (single-device production canary)

The app endpoint contract did not change for the 2026-10-04 canary. A default-off wrapper around the existing API handler identifies one explicitly configured canary from `SHA-256(Authorization bearer)` and routes only `GET /feed` to an authenticated, ready Home mirror. Missing/invalid/disabled gateway configuration immediately invokes the old handler without an extra KV read or origin fetch. Non-canaries, health, resolver, WebSub, admin/internal, and unknown routes always use the existing Cloudflare handler.

Canary mutations are deliberately asymmetric: execute Cloudflare first, preserve its response as canonical, then synchronously reproduce a successful mutation at Home. HMAC covers timestamp, unique request ID, operation, method, path/query, authorization digest, and body digest. Home rechecks that bearer against the configured canary fingerprint, permits only the explicit app allowlist, and must be mirror/standby with a recent successful conflict-free pull and the canary profile present; its scheduler therefore cannot send notifications. Enabling this dedicated origin role closes direct ordinary app API routes on the Home listener while retaining status and authenticated admin operations. Cloudflare remains the FCM owner.

If Home replication fails, Cloudflare writes one `gateway:canary:{fingerprint}:state` transition to `stale` (not one write per request). A stale or missing state forces Cloudflare reads. Only a short-lived receipt produced after a full Home reconciliation can restore `current`; one later successful mutation cannot. The origin serializes local gateway operations against mirror maintenance. A signed canonical mutation observed during an in-flight pull taints that snapshot for recovery, queues a fresh pull, and keeps reads on Cloudflare until the next pull proves no conflicts or pending local records. A signed automatic receipt may then restore `current`. Two schema-specific replay races select the canonical Cloudflare value: device profiles differing only in valid `lastSeenAt`, and newly created `channel:{id}:meta` objects differing only in valid numeric `addedAt`. Any other field, key, type, or timestamp difference remains quarantined. Network/auth/readiness errors, timeout, `429`, `5xx`, and incompatible Home replies fall back to Cloudflare. A well-formed non-retryable app `4xx` from a current Home read is semantic and is returned without replaying the read elsewhere.

This model cannot make two origins transactionally identical. If Cloudflare refuses a mutation or cannot persist the stale transition, instantaneous two-sided consistency is impossible. The gateway never promotes a Home-only mutation; it retains the canonical Cloudflare outcome and fails closed wherever stale state is observable. Disabling `TUBEPULSE_HOME_GATEWAY_ENABLED` is the routing rollback. The initial production mirror and signed reconciliation are complete for one canary; every expansion still requires a fresh explicit review rather than broadening the fingerprint selector.

The selected ingress is private Workers VPC rather than a public Home URL. A `TUBEPULSE_HOME_VPC` fetcher binding targets a VPC Service fixed to Docker-internal `gateway-origin:8788`; a remotely managed named Tunnel and digest-pinned `cloudflared` sidecar provide outbound-only connectivity. VPC mode is explicit and requires the fetcher binding. Its fetch uses an absolute `Request` without a redirect-mode override because Workers VPC rejects that otherwise-valid option before dispatch; public-origin mode retains both its HTTPS requirement and `redirect: "error"`. Both transports use the same HMAC, replay, identity, allowlist, readiness, stale-state, and timeout rules, and feature-off still delegates before any KV read or network fetch.

The temporary local-package `google-services.json` exists only to satisfy the Gradle plugin and is deleted after each build. It does not create a Firebase registration, so local API testing and notification delivery are separate milestones: the app can register with a null FCM token, but push support needs a real Firebase Android app for the suffixed package.

### 15.5 Known boundary risks

- An ambiguous Cloudflare/local handoff can duplicate a notification.
- Standby API traffic can create local dirty state while schedulers remain off.
- Production fallback configuration is fixed at APK build time. The separate Preview package has one runtime-selected endpoint and no production fallback.
- A LAN HTTP test APK trusts cleartext traffic and must not be distributed as a production build.
- The side-by-side package does not inherit a valid FCM registration merely because build-time Firebase metadata was rewritten.
- Cloudflare REST synchronization consumes Cloudflare KV quota.
- Operators must explicitly coordinate Cloudflare scheduler state and local takeover; this preview never changes production resources.

### 15.6 Unified Home production authority

The scheduled-worker replacement is a separate process from both the retired app gateway experiment and the standalone Preview pilot. Video discovery is Data API-only in active mode: every aligned five-minute cycle batches sorted unique active IDs into `channels.list` groups of at most 50, compares persisted public `videoCount`, and reconciles only changed/missing-baseline uploads playlists. Production currently uses two detector requests per cycle, costing 576 general units/day. A bounded six-hour first-page safety pass adds at most `active channels × 4` general units/day and catches count-neutral replacement and propagation lag. Playlist/video/statistics results enter the existing canonical key schema and notification path; there is no parallel notifier and no `search.list` dependency. The scheduler reuses the existing post poller for an all-eligible-channel hourly sweep and the existing aux routine each minute. Configurable post cadence carries an explicit daily-quota projection and guard.

Only each channel's dynamic app-visible top three videos are eligible for statistics polling. Their adaptive cadence remains intact; when a visible item becomes deleted/private, the promoted cached item is immediately due because non-visible poll clocks are pruned. The durable known-video watermark is independent of this optimization, so promotion cannot replay a notification. `commentCount` is collected into durable local observation state for possible future activity work, but comment movement is excluded from cadence and can never cause a canonical publication. A latest comment value may piggyback on a recent-video write already required by structure or allowed view/like persistence. Community-post structural changes persist immediately, while `fetchedAt`, relative-age labels, rotating delivery signatures, and same-hour engagement movement remain no-ops. Missing metrics hydrate once; any normalized known view/like change may persist once per UTC hour, and unchanged canonical metrics are forced fresh after 24 hours. The active upload path does not rewrite channel metadata merely to advance compatibility field `lastVideoId`.

Three fail-closed modes exist: shadow measures local mutations and notification decisions with no remote writes or FCM network request; standby does no scheduled work; active requires an independent write flag, notification flag, live-trigger-disable confirmation, Firebase credential, and exact activation latch. A persisted exclusive lease, heartbeat, overlap guard, in-progress channel list, timeout, and retry/backoff make a single runner restartable without knowingly duplicating a completed channel. Shadow publication compares final local state with canonical state and classifies predicted writes by key family/reason, including a distinct metrics-only category.

Moving compute does not eliminate canonical writes. An earlier 2026-10-04 exercise proved that making Cloudflare KV the scheduler's live backing store is not viable on the free tier: its frequent full mirror exceeded the available read budget. It also exposed notification-before-feed visibility and was rolled back before this unified design replaced it.

The implemented successor is one local authority/runtime/store. Signed Cloudflare-first mutations for every authenticated device and scheduled polling share one global Durable Object lease followed by one local lease, so lock order is deterministic. Home polls local KV and publishes an exact changed-key journal. The SQLite-backed coordinator stores conditional baselines and resumable transactions; genuine divergence marks the authority stale. Authenticated `GET /feed` is routed for all devices over the private VPC binding to that same store only while current, with D1 canonical fallback. This strong Home read path—not a fixed propagation sleep—is the notification visibility barrier.

Cloudflare D1 backup publication has two conservative row-write budgets: 45,000 estimated scheduler rows/day and 50,000 total estimated rows/day, reserving 5,000 for app mutations under the free plan's 100,000-row daily allowance. Every logical mutation is charged as three rows before execution: a precondition-guard insert, the canonical row mutation, and guard cleanup. Tables use `WITHOUT ROWID` primary keys and no secondary indexes. At the scheduler cap, the coordinator durably coalesces the latest change per key and retries on later ticks after the UTC reset. An API mutation first flushes any overlapping deferred keys from its reserve before the application handler runs, preventing stale-base overwrites such as `/seen` racing a new video. Home polling/feed service continues, but FCM for a batch whose canonical backup is deferred is suppressed: a subsequent VPC outage must not recreate push-with-missing-content on the D1 fallback. WebSub pushes are acknowledged without writes/FCM while Home traffic ownership is active, and verification handshakes persist no lease state.

Configuration and traffic activation are separate latches. Production initially cut over to Home on 2026-10-04 after disabling/draining all scheduled Workers and importing an exact signed snapshot. The D1 migration later quiesced Home, staged the full authoritative snapshot under an explicit backend generation, verified its exact manifest, atomically activated that generation, and only then archived obsolete KV-pending state. The old KV namespace is frozen and never dual-written or selected automatically. Safe rollback after new D1 writes therefore requires another quiesced exact reconciliation; the retained Workers additionally require an explicit frozen-KV acknowledgement latch before their scheduled handlers do anything.

Community-post cache comparisons discard rotating YouTube thumbnail delivery parameters when the stable image origin/path is unchanged, and ignore relative-age label churn when the cached post has the same valid `publishedAt`. Structural post changes remain immediate. Engagement observations hydrate missing values, persist any normalized known numeric change at most once per UTC hour, and force a refresh after 24 hours, using `fetchedAt` as the persisted observation clock.

The final subscriber leaving removes the channel from `channels:active`, which stops video and post polling. Display/subscriber caches are cleaned through the coordinated backup journal, while `channel:{id}:known:videos` remains durable so a later resubscribe cannot replay historical uploads.

Host availability and disaster recovery are deliberately separate from this data-plane design. Compose health proves only HTTP liveness/service identity—not authority readiness/current state or scheduler progress. The checked-in Windows supervisor starts Docker minimized, applies Compose idempotently, and separately evaluates signed coordinator/D1 readiness and scheduler progress without clearing stale/pending state or restarting for dependency outages. A verified per-user Startup shortcut now invokes it at interactive sign-in; the idempotent live test passed without replacing the healthy container, while a real reboot test remains outstanding. The elevated Scheduled Task route is optional because cross-account UAC task ACLs can exclude the auto-login profile. After total disk loss, GitHub plus active D1/DO and the existing cloud projects reconstruct canonical service; secrets rotate and host-only scheduler/quota/notification state follows conservative loss rules. See [`self-host/RECOVERY.md`](self-host/RECOVERY.md).

Operational monitoring is a separate, non-authoritative Compose project. A bounded aggregate-only host endpoint and read-only Cloudflare GraphQL collector feed localhost Prometheus/Grafana; they cannot mutate canonical state and carry no authority credential. Five-minute UTC snapshots and time series remain under ignored repo-root `logs/`, with explicit retention limits. Monitoring startup is asynchronous/best-effort after authority readiness, so observability failure cannot block or restart production. See [`monitoring/README.md`](monitoring/README.md).

---

## Appendix A: Glossary

- **WebSub**: W3C standard for content distribution. YouTube exposes RSS feeds via the PubSubHubbub hub at `pubsubhubbub.appspot.com`. Subscribers receive HTTP POSTs when content updates.
- **HMAC**: Hash-based message authentication code. WebSub uses HMAC-SHA1 to verify push payload authenticity.
- **FCM**: Firebase Cloud Messaging. Google's push notification service for Android.
- **Cron trigger**: Cloudflare Workers feature that runs a Worker on a schedule (cron expression).
- **KV**: Cloudflare's edge key-value store. Eventually consistent, edge-cached, free-tier-limited.
- **Lease**: WebSub subscriptions expire after a finite period (we use 5 days). Must be renewed.
- **Nag**: TubePulse-specific term for repeated reminder notifications about unwatched videos.
- **DND**: Do Not Disturb. User-configured time windows where notifications are suppressed.
- **Override**: Per-channel customisation of notification behaviour, taking precedence over device-level settings.
