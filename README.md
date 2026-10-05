# TubePulse

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/Undert0e-505/TubePulse)](https://github.com/Undert0e-505/TubePulse/releases)
[![Platform](https://img.shields.io/badge/platform-Android-green.svg)](https://github.com/Undert0e-505/TubePulse)
[![Cloudflare Workers](https://img.shields.io/badge/backend-Cloudflare%20Workers-F38020.svg)](https://workers.cloudflare.com/)
[![React Native](https://img.shields.io/badge/built%20with-React%20Native%20%2F%20Expo-61DAFB.svg)](https://expo.dev/)

TubePulse is an open-source Android app for YouTube channel notifications, including community posts. Its public API remains on Cloudflare Workers; the production scheduler can run as a unified local Home authority and uses Firebase Cloud Messaging for push delivery.

It is designed for people who want direct, lightweight YouTube notifications without relying entirely on the YouTube app's notification behaviour.

- **Android only** — no iOS support planned
- **MIT licensed** — forkable, modifiable, self-hostable
- **Self-hostable backend** — Cloudflare Workers remain the default; an additive local-runtime preview is available

## Features

- Subscribe to YouTube channels by handle (`@handle`) or channel ID
- Receive Android push notifications for new videos (every active channel is checked by Home every five minutes)
- Receive Android push notifications for YouTube community posts (text, images, polls)
- Home screen feed showing latest videos and posts from all tracked channels
- Android home screen widget with latest videos and posts
- Per-channel notification overrides (mode, DND, prewarn time, community posts opt-out)
- Scheduled livestream prewarn — get notified before a stream goes live
- Nag cycle — configurable re-notifications for unwatched videos
- Cloudflare public API plus an optional unified local scheduler/authority
- Optional standalone or Cloudflare-mirror self-host preview with local persistent KV
- Firebase Cloud Messaging push delivery
- MIT licensed and forkable

## Screenshots

![TubePulse Android home feed showing YouTube channel notifications and community posts](docs/screenshots/home-feed.jpg)

*Home feed — videos and community posts from subscribed channels*

![TubePulse channel management screen](docs/screenshots/channel-list.jpg)

*Channel list — add channels by handle, remove or reorder tracked channels*

![TubePulse notification settings screen](docs/screenshots/settings.jpg)

*Settings — tap action, notification mode, nag interval, DND, livestream prewarn, community posts*

## Why TubePulse?

YouTube's in-app notifications can be inconsistent, especially for community posts. The subscription feed mixes in recommendations, buries creators you follow, and the bell notification is unreliable. TubePulse provides a small, inspectable notification path using a self-hosted backend and an Android client.

**Note:** Community post detection depends on unofficial YouTube web data structures and may need maintenance over time if YouTube changes those surfaces. TubePulse is not affiliated with YouTube or Google.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Android app | React Native + Expo |
| Push notifications | Firebase Cloud Messaging (FCM) via HTTP v1 API |
| Backend | Cloudflare public API plus the self-host/Home runtime |
| Storage | Persistent local KV with changed-key Cloudflare KV backup |
| Video detection | Batched YouTube Data API channel detection every five minutes, uploads-playlist reconciliation, and adaptive batched statistics |
| Community post detection | InnerTube polling of every eligible channel hourly |
| Widgets | react-native-android-widget |
| Auth | Persistent device UUID (Bearer token, independent of FCM token rotation) |

## Project Status

**Active early release / personal-public project.**

- **v3.3.2** includes reliable multi-device subscription reconciliation.
- Community post support exists but depends on unofficial YouTube web data structures, so it may need maintenance if YouTube changes.
- The app is Android-only. No iOS support is planned.
- An experimental, functional [self-host preview](self-host/README.md) can run the existing Worker sources locally or as a conflict-detecting Cloudflare standby. It is not deployed to the maintainer's production account by its addition.
- See [STATUS.md](STATUS.md) for current repo status and operational caveats.
- See [RELEASE.md](RELEASE.md) for the release process.

---

## Self-host preview

The additive [`self-host/`](self-host/) package runs the existing API and scheduled Worker modules through a workerd-backed local runtime. It supports standalone operation, persistent local KV, explicit Cloudflare reconciliation, and Docker/Windows operation. A debug-signed `TubePulse Preview` APK can be installed beside the main app, selects a health-tested Home URL at runtime, and never falls back to production. Its documented pilot Compose profile uses an isolated `data-pilot` directory and hard-disables Cloudflare sync/write behavior. A private Workers VPC canary was exercised on 2026-10-04 without a public Home hostname or inbound router port, then disabled after its full five-minute mirror was shown to consume about 233,000 KV reads/day at 811 records.

Production switched to the **unified Home authority** on 2026-10-04: one process/store owns signed all-device mutation execution and the consolidated scheduler, polls community posts hourly, and runs aux work each minute. On 2026-10-05 video detection moved to the YouTube Data API: every aligned five-minute cycle batches active channels into the two `channels.list` requests required by the current fleet, then reconciles uploads playlists only for migration/change/safety-due channels and batches video statistics. The unchanged public Worker URL serves every authenticated `/feed` from this local store over Workers VPC when the authority is current, with bounded Cloudflare-KV fallback. Authenticated app mutations also run on Home through the signed VPC ingress while a Durable Object provides global ordering. Successful exact deltas are durably coalesced for later Cloudflare-KV backup, so `/seen` and the other app writes do not consume or depend on Cloudflare KV reads/writes at request time. Home publishes only changed keys to Cloudflare backup storage; the coordinator caps scheduler backup writes at 900/day and total coordinated writes at 950/day, reserving 50 writes for app mutations. Deferred backup changes are coalesced, and notification intents are suppressed while their backup publication is deferred. No periodic namespace pull runs after the one-time signed snapshot. The RSS, posts, and aux Cloudflare Cron Triggers are disabled; their Worker deployments are retained for rollback. There is no automatic RSS fallback.

Start with the [self-host guide](self-host/README.md) for its preview limitations, five-minute setup, synchronization safety model, Cloudflare Tunnel guidance, backups, and recovery procedure.

---

## Detailed Architecture

> Current repo status: see [STATUS.md](STATUS.md). Historical planning docs are not authoritative for current release/deployment state.
> App release process and cleanup plan: see [RELEASE.md](RELEASE.md). Worker deployments are separate from app APK releases.

### Current App Line
The current checked-in app version is `3.5.2`. The v3.1 feature line below is retained as a historical feature summary; see [STATUS.md](STATUS.md) for current repo status and caveats.

Community posts in v3.3.0 are enabled for active subscribed channels when the global worker feature gate is on. Newly added channels are silently seeded before future community-post notifications, so old posts are not pushed as new.

v3.3.1 fixes widget/HomeScreen feed parity so the widget uses the same latest video/community-post selection rules as the app.

- **Like & dislike counts in the video card meta row** — shown next to the publish time and view count, so you can see what the community thinks of a video at a glance.
- **📝 Community posts in the feed** — channel community posts (text, images, polls) are now polled hourly and rendered in the home feed under a "Posts" mini-header. Posts have their own blue dot for unseen items, get marked as seen like videos, and respect the same global + per-channel opt-out settings.
- **⏰ Prewarn time for scheduled livestreams** — pick how early you want to be notified before a scheduled livestream goes live (15m, 30m, 1h, 2h, 4h, or 1d — default 1h). Per-channel override available. At the moment the livestream actually goes live, the regular new-video notification fires; the prewarn is the heads-up, the regular push is the "this just appeared" notification.
- **🗨️ Custom ConfirmDialog** — replacing `Alert.alert` for the channel-removal confirmation. Themed to match the rest of the app (`COLORS.surface` background, `COLORS.danger` for the destructive action).

### Detailed Features

#### 📺 Channel Tracking
- Add channels by handle (`@handle`) — no URLs, no pasting video links
- Resolves handles to channel IDs via YouTube Data API v3 (proxied through Cloudflare Worker)
- **Channel ID is the primary key** — handles can change, but channel IDs don't. Once resolved at add-time, the channel is tracked by ID even if the creator rebrands.
- Draggable channel list — reorder by priority
- Per-channel avatars cached locally
- Comes with two default channels to get you started — remove or add your own

> **Note:** Each device registers independently. There's no cross-device sync — if you install TubePulse on two phones, each manages its own channel list and settings.

### ⚡ New-Video Detection
TubePulse detects new uploads through the YouTube Data API from the production Home authority. The old RSS shard deployments remain triggerless rollback assets and are not an automatic fallback. Originally TubePulse used **WebSub** (PubSubHubbub), but Google's `pubsubhubbub.appspot.com` hub was shut down in 2024.

**Active path:**
- **Two batched channel checks every five minutes** — `channels.list` accepts at most 50 IDs per request; the current fleet therefore costs 576 general quota units/day for detection.
- **Structural discovery** — only channels with a changed public `videoCount` need `playlistItems.list`; a six-hour bounded safety pass catches count-neutral changes. `search.list` is not used.
- **Batched engagement metrics** — `videos:batchGetStats` supplies views, likes, and comments for up to 50 videos per request from its separate statistics bucket. Only each channel's app-visible top three are eligible; polling backs off as those videos age or stay static.
- **Latency** — normally at most one five-minute Home cycle plus request time. Last-good feed data remains available during transient API failures.
- **Quota guarded** — request counters persist across restart, reset at Pacific midnight, and retain configured reserves below the 10,000-unit daily limits.

**WebSub (dormant):** the `/websub` endpoints and handler code remain in the workers for:
- Manual testing
- Future YouTube-compatible hub revival
- Self-hosted hub integration

When a new video is detected, Home publishes the canonical feed state and then pushes it to eligible devices through FCM after the public-feed visibility barrier passes. Dormant WebSub state remains for compatibility. When the final subscriber removes a channel, it leaves `channels:active` immediately so polling stops; one-off backup cleanup is published while the durable known-video watermark is retained for a safe future resubscribe.

**Scheduled event detection (v3.1):** Data API video metadata with a future scheduled start is treated as a scheduled livestream/premiere. The actual upload publication time remains separate from the scheduled start so a future event cannot advance the new-video watermark:
- Stored silently when detected — no immediate notification
- **Prewarn push** fired at the user's chosen offset (default 1h, options 15m–1d) before the scheduled start. Body shows the actual remaining time so the user sees accurate information even if the cron is a few minutes late.
- **At the scheduled time, the regular new-video push fires** — the same `type: 'live'` notification as any other upload. There is no separate "is live now!" notification; the prewarn is the heads-up, the regular push is the "this just appeared" notification. Livestreams bypass DND.
- Then nagged like any other unwatched video until you watch it

**Community posts (v3.1):** the production Home scheduler checks every eligible channel once per hour through InnerTube. It captures text posts, image posts, and polls. A first-run guard prevents notification floods on first install. Posts respect the same global `includeCommunityPosts` setting and per-channel override as videos. Posts do not enter the nag cycle — only the initial push fires.

Shorts are currently not filtered — they're treated as regular uploads.

### 🔔 Smart Notifications

TubePulse's notification system is built around **nagging**, not polling. You control how often you're allowed to be nagged about an unwatched video:

- **Nag interval** — 5m / 15m / 30m / 1h / 2h (default 15m)
- **Chill mode** (default) — notify once, then nudge every 4 hours until you watch it
- **Relentless mode** — re-nag every nag interval until you watch the video
- **Per-channel overrides** — set different notification modes, DND, prewarn time, and post opt-out per creator
- **DND scheduling** — blocks non-livestream pushes during custom silent hours (default 22:00–07:00). Livestreams (`type: 'live'`) bypass DND by default; regular new-video, prewarn, and post pushes respect DND unless the per-channel override sets `dndBypass: true`. Videos that arrive during DND are held and delivered when DND ends by the nag cycle.
- **DND batching** — when DND ends and multiple unwatched videos are pending for the same channel, TubePulse sends a single per-channel summary (e.g. `ChannelName - 3 unwatched`) instead of flooding you with individual notifications. The batch groups by channel — you'll get one notification per channel with its unwatched count, not one per video.

When Home detects a new video, TubePulse notifies eligible devices after canonical publication (unless DND is active). Home's minute aux job then handles re-notifications on the user's chosen schedule.

### 👆 Tap Actions — Video vs Channel

When you tap a notification or a video in the feed:

- **Video tap** — opens that specific video in YouTube, marks only that video as watched
- **Channel tap** — opens the channel page in YouTube, marks **all** unwatched videos and posts from that channel as watched (bundle clear)

This is the key interaction: video tap for "I've seen this one", channel tap for "I'm going to their channel and clearing my backlog".

### 🏠 Home Feed
- All new videos and community posts from tracked channels, newest first
- Unseen videos and posts highlighted with a blue dot
- Video rows: thumbnail, title, channel avatar, meta row (age · likes · dislikes · views)
- Post rows: thumbnail OR speech-bubble placeholder (greyscale shrunk channel avatar inside a rounded-rect bubble with a small triangular tail), header ("Posted" / "Posted an image" / "Posted a poll"), truncated body (3 lines)
- Tap a video to open it in YouTube; tap a post to open the channel's community tab
- Long-press a video to copy its link

### 📱 Home Screen Widget
- Android home screen widget showing latest videos and community posts
- Compact rows with thumbnail, title, channel avatar, and post cards
- Seen items dimmed so new uploads stand out
- Tap video to open in YouTube, tap pfp to open channel, tap post to open community tab
- Respects `tapAction` setting (channel mode sends all taps to the channel)

### 🎨 Dark Theme
- Full dark mode with translucent surfaces
- Clean, minimal interface — no clutter, no ads, no recommendations
- Designed for one-handed use

### Architecture

### Overview - Current Repo Evidence

```
YouTube Data API / InnerTube ──poll──▶ unified Home authority ──FCM──▶ Phone
                                      │          ▲
                                      │ local KV │ signed VPC feed/mutations
                                      ▼          │
                              Cloudflare API Worker ─────────────▶ App
                                      │
                                      └──durable coalesced deltas──▶ Cloudflare KV backup

The API Worker retains a signed, bounded RSS diagnostic route for historical
rollback tooling, but the active Home scheduler does not call it. Legacy
scheduled Workers remain triggerless.
```

**Verified API route:** as of 2026-06-25, `GET /` on `https://tubepulse-api.jimothyoakley55.workers.dev` returns Cloudflare-served health JSON identifying `worker: "tubepulse-api"` and `architecture: "channel-first"`. The health JSON reports `version: "3.0.0"`; keep that separate from the app version `3.3.1`. The wrangler config comment saying no HTTP routes is stale/incomplete, so review Cloudflare settings before changing routing.

**Key principle:** Channels are the unit of work. Devices are the unit of subscription.  
Every operation asks "what's happening to this channel" first, then "who cares about this channel".  
This inverts the old device-first approach and eliminates `KV.list()` entirely.

**Detection paths in v3.1:**
- **Active (videos):** Home batches active channels through `channels.list`, reconciles changed uploads playlists against a durable known-video watermark, and fans out new videos after canonical publication.
- **Active (posts, v3.1):** Home polls every eligible active channel through InnerTube once per hour. Zero Data API quota cost.
- **Active (prewarn, v3.1):** Home's minute aux job checks `upcoming:events:list` and fires per-device prewarn pushes when each device's window is active.
- **Dormant:** WebSub handlers in both workers exist but the hub is shut down; `/websub` endpoint still works for manual testing or future hub revival.
- **YouTube Data API:** active video discovery and metrics plus occasional handle resolution/avatar work. Posts still use InnerTube; aux and FCM do not consume YouTube quota.

### API Worker (`tubepulse-api`)

This is the current live app-facing API worker. The app client points to `https://tubepulse-api.jimothyoakley55.workers.dev`, and live `GET /` verification on 2026-06-25 returned the worker health JSON. `worker/tubepulse-api/wrangler.toml` still has a stale/incomplete route comment, so do not use that comment alone for cleanup decisions.
The central Cloudflare Worker. Handles:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/register` | POST | Register/update device profile. `fcmToken` is optional (null accepted so a user who denied notification permission can still subscribe channels and use the app). Idempotent — safe to call on every launch and on FCM token refresh. |
| `/subscribe-channel` | POST | Add a channel to this device. Triggers a cached Data API avatar lookup and structural uploads-playlist bootstrap when needed. |
| `/unsubscribe` | POST | Remove a channel from this device. Removes the device from the channel's subscriber list; if the subscriber list goes empty, the channel is removed from the `channels:active` index. |
| `/seen` | POST | Mark videos/posts as watched. `{ channelId, ids: [videoId, "post:activityId", ...] }` for taps, `{ channelId, clearAll: true }` for channel-tap. Post IDs are namespaced with `post:` so they share the `deviceState.unwatched` array with videos without collision. |
| `/feed` | GET | Fetch current video + post data for all tracked channels. Production serves authenticated feeds from the unified Home store over VPC while current, with bounded Cloudflare-KV fallback. Each post carries an `unwatched` flag mirroring the video pattern. |
| `/resolve` | GET | Resolve `@handle` → channelId + name + avatar (YouTube Data API, key stays server-side). Result cached 7 days in `handle:{lowercase}`. |
| `/bootstrap` | POST | Fetch channel metadata and recent uploads through the Data API structural path. |
| `/settings` | POST | Update notification settings (full replacement). Includes `prewarnMinutes` (v3.1). |
| `/channel-override` | POST | Set/update per-channel notification override. Empty override deletes it. Supports `prewarnMinutes` and `includeCommunityPosts` overrides (v3.1). |
| `/websub` | GET | WebSub verification handshake — **dormant**, responds with `hub.challenge` if any verification request ever arrives. |
| `/websub` | POST | WebSub push from YouTube — **dormant**, code path intact for future hub revival or self-hosted hub integration. |

**Per-request flow (`/subscribe-channel` example):**
1. Look up the device profile (from `Authorization: Bearer <deviceId>`) — must exist
2. Read channel meta from KV; if missing, fetch avatar via YouTube Data API (1 quota unit, cached forever)
3. Read channel recent from KV; if missing, obtain the uploads playlist and fetch recent items plus batched metadata/statistics
4. Add `deviceId` to the channel's `subscribers` list (if not already there)
5. Add `channelId` to the device's `channels` list (if not already there)
6. Add `channelId` to `channels:active` (if this is the first subscriber)
7. Return the channel meta + recent videos to the app

**YouTube Data API usage:** Two five-minute `channels.list` detector calls cost 576 general units/day. Six-hour first-page reconciliation costs up to `active channels × 4` general units/day; changed-channel detail and metadata requests are event-driven. Engagement metrics use the separate `videos:batchGetStats` bucket. Persisted Pacific-day counters and reserves keep both buckets below their configured daily limits.

### Background scheduler

Production scheduling moved to the unified local Home authority on 2026-10-04. On 2026-10-05 its video source moved from RSS to batched Data API discovery. It checks all active channels every five minutes, polls eligible community posts hourly through InnerTube, and runs bounded aux work each minute. The five Cloudflare scheduled Worker deployments and old combined cron remain triggerless rollback artifacts.

| Runtime | Live cadence | Work per invocation |
|---|---|---|
| Home video detector | Every five minutes | Two batched `channels.list` requests for the current fleet; changed/migration/safety-due uploads playlists enter the shared watermark and notification path. |
| Home posts sweep | Hourly | Polls every eligible channel with InnerTube and preserves first-poll suppression. |
| Home aux | Every minute | Processes bounded nag/prewarn work and drains legacy upcoming buckets. |
| `tubepulse-rss-0/1/2`, `tubepulse-posts`, `tubepulse-aux` | Disabled (`crons = []`) | Retained code/deployments for stop-Home-first rollback only. |

Home publishes changed keys to `TUBEPULSE_KV` as a bounded backup while the public API serves current feeds from Home over Workers VPC. The retained scheduled-only Workers intentionally do not export `fetch()`, so opening their `workers.dev` URLs is not a valid health check.

### Data Model (Cloudflare KV) — v3.1

| Key Pattern | Contents |
|-------------|----------|
| `channel:{channelId}:meta` | Channel name, avatarUrl, compatibility/bootstrap `lastVideoId`, addedAt; active upload detection does not rewrite metadata solely for `lastVideoId` |
| `channel:{channelId}:subscribers` | Array of deviceIds tracking this channel |
| `channel:{channelId}:websub` | WebSub state: leaseExpiresAt, hmacSecret, lastVerified (dormant — no longer used) |
| `channel:{channelId}:recent` | Last 15 videos: videoId, title, publishedAt, type, thumbnail, link, **views**, **likes**, **dislikes**, **viewsLastCheckedHour** (view persistence UTC hour), and **likesLastCheckedHour** (likes/dislikes persistence UTC hour) |
| `channel:{channelId}:recent:posts` | Latest community post plus persisted engagement clock/metrics; structural changes are immediate while observation-only churn is suppressed |
| `channel:{channelId}:firstPollAt:posts` | ISO timestamp of first posts-cron run for this channel (drives the first-run guard) |
| `device:{deviceId}:profile` | fcmToken (nullable), platform, appVersion, createdAt, lastSeenAt |
| `device:{deviceId}:settings` | mode, nagInterval, dndEnabled, dndStart, dndEnd, dndTimezone, tapAction, includeCommunityPosts, prewarnMinutes, etc. |
| `device:{deviceId}:channels` | Array of channelIds this device tracks |
| `device:{deviceId}:override:{channelId}` | Per-channel overrides: mode?, nagInterval?, dndBypass?, muted?, includeCommunityPosts? (v3.1, tri-state null/true/false), prewarnMinutes? (v3.1, tri-state null/number) |
| `device:{deviceId}:state:{channelId}` | Per-device per-channel state: unwatched[] (videos by videoId, posts by `post:{activityId}`), lastNagAt, nagCount |
| `upcoming:events:list` | Array of currently-scheduled live events: { channelId, videoId, scheduledFor, addedAt }. Pruned 24h after live. (v3.1) |
| `upcoming:prewarn:{videoId}:{deviceId}` | Set to the prewarnMinutes value when a prewarn push has been sent for that (event, device). Cleaned when the event is pruned. (v3.1) |
| `upcoming:{bucket}` | Pre-v3.1 only — drained by the new `runUpcomingCron` on the first tick after upgrade |
| `nag:{bucket}` | Nag entries for a 15-min window |
| `channels:active` | Index of all channels with at least one subscriber |
| `handle:{lowercase}` | Cached handle→channelId resolution (7-day TTL) |

**Zero `KV.list()` calls.** The `channels:active` index replaces all list operations.

### App → Server Communication

1. **On launch**: `POST /register` with FCM token (null if notification permission denied) — creates/updates device profile
2. **On channel add**: `POST /subscribe-channel` with channelId → cached Data API metadata + structural uploads-playlist bootstrap
3. **On channel remove**: `POST /unsubscribe` with channelId → device removed from channel's subscriber list (with a custom ConfirmDialog confirmation in v3.1)
4. **On settings change**: `POST /settings` with updated settings (app uses `notificationMode` UX name, server stores as `mode`); includes `prewarnMinutes` and `includeCommunityPosts` in v3.1
5. **On per-channel override**: `POST /channel-override` with channelId + override (or empty to clear). Supports `prewarnMinutes` and `includeCommunityPosts` overrides in v3.1, both tri-state (null = inherit, value = override)
6. **On notification tap**:
   - Video tap → `POST /seen { channelId, ids: [id] }`
   - Channel tap → `POST /seen { channelId, clearAll: true }`
   - Post tap (v3.1) → `POST /seen { channelId, ids: ["post:activityId"] }`, then open the channel's community tab
   - Prewarn tap (v3.1) → open the YouTube watch URL for the scheduled video. The video is NOT marked as seen on tap (the prewarn is a reminder; the live-time push will still fire later)
7. **On feed refresh**: `GET /feed` → returns cached data from KV, merged with per-device state to compute `unwatched` flags on both videos and posts
8. **On FCM token refresh**: `POST /register` with the new token (handled by `onTokenRefresh` in App.js)

**Device identity:** Each device generates a persistent UUID on first launch. This UUID is the auth token and primary key — independent of the FCM token, which is stored as a mutable field on the device record and updated on token refresh. This avoids orphan records when FCM tokens rotate.

### Notification Flow

```
Video uploaded on YouTube                              Channel posts on YouTube
         │                                                     │
         ▼                                                     ▼
Home batches every active channel every five minutes Home polls eligible post channels
and reconciles due uploads playlists                 through InnerTube once per hour
         │                                                     │
         ▼                                                     ▼
Diff against channel:{id}:recent → new videoIds       Diff against channel:{id}:recent:posts
         │                                                     │
         ├─ Type 'live_scheduled' (future publishedAt)?       │
         │   → append to upcoming:events:list                 │
         │   → runPrewarnCron will iterate and fire           │
         │     per-device prewarn pushes                      │
         │                                                     │
         ▼                                                     ▼
For each new video, look up channel:{id}:subscribers  For each new post, look up subscribers
         │                                                     │
         ├─ DND active for this device?                       ├─ Global includeCommunityPosts off
         │   → New videos: livestreams bypass DND by default  │  AND no per-channel override?
         │   → Upcoming-event heads-up + nag cycle:           │  → skip
         │     only bypass if dndBypass is set                │
         ▼                                                     ▼
Device receives notification                        Device receives notification
         │                                                     │
         ├─ User taps (video) → mark seen, open video         ├─ User taps (post) →
         ├─ User taps (channel) → clear all, open channel     │  mark post seen, open community tab
         ├─ User ignores → nag cycle re-notifies              ├─ User ignores → no nag (posts don't
         │                                                     │  enter the nag cycle in v3.1)
         ▼                                                     ▼
Nag Cycle (every 15 min, scheduled into nag:{bucket} keys)
         │
         ├─ Relentless: re-nag if nagInterval elapsed
         ├─ Chill: nudge if 4h elapsed
         ├─ DND active (no dndBypass)? → skip
         ├─ Video seen? → drop from batch
         │
         ▼
Repeat until user watches
```

The Home YouTube Data API poller is the active new-video detection path. RSS shards and their probe/circuit code are retained only for explicit rollback/history; there is no automatic RSS fallback. The WebSub handlers in the workers are dormant but intact.

## Project Structure

```
TubePulse/
├── src/
│   ├── screens/
│   │   ├── HomeScreen.js          # Main feed — new videos and posts from all channels
│   │   ├── ChannelsScreen.js      # Add/remove/reorder channels, per-channel settings
│   │   └── SettingsScreen.js      # Nag interval, mode, DND, prewarn, posts toggle, tap action
│   ├── components/
│   │   ├── TubePulseWidget.js     # Android home screen widget
│   │   ├── widgetTaskHandler.js   # Widget render handler — reads from AsyncStorage
│   │   ├── TimeSpinner.js         # DND time picker
│   │   ├── ConfirmDialog.js       # Themed modal dialog (v3.1, replaces Alert.alert)
│   │   └── Confirm.js             # Promise-based confirm({...}) helper that renders ConfirmDialog (v3.1)
│   ├── utils/
│   │   ├── api.js                 # REST client for the Cloudflare Worker (v3 endpoints)
│   │   ├── apiEndpointPolicy.mjs  # Build-time primary/fallback and sticky retry policy
│   │   ├── notifications.js       # Android notification channels
│   │   ├── fcm.js                 # Firebase Cloud Messaging setup + handlers
│   │   ├── storage.js             # AsyncStorage wrapper
│   │   └── constants.js           # Colours, defaults, nag intervals, prewarn options, storage keys, preseeded channels
│   └── App.js                     # Navigation, FCM setup, notification tap handling, init
├── worker/
│   ├── README.md                  # Cloud architecture — KV schema, endpoints, cost analysis
│   ├── archive/
│   │   └── tubepulse-resolver/     # Historical standalone resolver worker; reference only
│   ├── tubepulse-api/
│   │   ├── index.js               # API Worker — v3.1 channel-first + posts + prewarn
│   │   └── wrangler.toml
│   ├── tubepulse-rss-{0,1,2}/    # Triggerless rollback RSS Workers; inactive in production
│   ├── tubepulse-posts/          # Triggerless rollback post Worker; Home reuses poller
│   ├── tubepulse-aux/            # Triggerless rollback aux Worker; Home reuses aux logic
│   └── tubepulse-cron/
│       ├── index.js               # Retired no-op compatibility entrypoint
│       ├── shared.mjs             # Shared scheduled-worker helpers
│       └── wrangler.toml          # No Cron Trigger
├── self-host/                     # Preview local runtime, sync, scheduler, tests, Docker + Windows helpers
│   ├── src/                       # Runtime adapter, service, reconciliation and CLI
│   ├── test/                      # Local/mock-only unit and integration tests
│   └── README.md                  # Public setup, operation, backup and recovery guide
├── scripts/
│   └── Build-SelfHostApk.ps1      # Self-contained, side-by-side TubePulse Preview test APK
├── secrets/                       # All gitignored — live credentials only
│   ├── README.md                  # Operator docs for secrets
│   ├── cloudflare.env             # CF account ID + API token
│   ├── youtube.env                # YouTube Data API key
│   ├── fcm-service-account.json   # Firebase service account (1217-byte PKCS8)
│   ├── load-secrets.sh            # Sources env + generates per-worker .dev.vars
│   └── set-worker-secrets.sh      # Pushes secrets to workers via wrangler
├── ARCHITECTURE.md                # v3 architecture specification
├── PLAN_v3.1.md                   # Historical v3.1 implementation plan
├── STATUS.md                      # Current repo status and operational caveats
├── MIGRATION_PLAN.md              # v1→v2→v3 migration plan (historical record)
├── build-and-release.ps1           # Windows-native app release script
├── RELEASE.md                      # Current release process, risks, and target flow
├── app.json                       # Expo config
├── package.json
└── .gitignore
```

## Settings Reference

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `tapAction` | `video` / `channel` | `video` | `video` = tap video opens video, tap pfp opens channel. `channel` = everything opens the channel. Applies to notifications, app feed, and widget. Posts always open community tab regardless. |
| `notificationMode` | `chill` / `relentless` | `chill` | Chill = nudge every 4h; Relentless = re-nag every interval |
| `nagInterval` | 5 / 15 / 30 / 60 / 120 | 15 | Minutes between nag attempts for unwatched videos |
| `dndEnabled` | boolean | false | Block all notifications during DND hours |
| `dndStart` | HH:MM | 22:00 | DND start time |
| `dndEnd` | HH:MM | 07:00 | DND end time |
| `dndTimezone` | IANA tz string | `UTC` | IANA timezone used to evaluate DND (e.g. `Europe/London`). The shipped `DEFAULT_SETTINGS` is `'UTC'`; the app overrides this on first launch via `getLocalTimezone()` (Intl API) and sends it to the server on every `/register` and `/settings`, so by the time DND is actually checked the device's local zone is in use. Without this, the worker would evaluate DND in UTC and notifications would fire at the wrong local time. |
| `perChannelNotifications` | boolean | false | Enable per-channel notification overrides |
| `includeCommunityPosts` | boolean | false | Show channel community posts in your feed (v3.1) |
| `prewarnMinutes` | 15 / 30 / 60 / 120 / 240 / 1440 | 60 | How early to fire a prewarn push before a scheduled livestream (v3.1) |

### Per-Channel Overrides

When `perChannelNotifications` is enabled, long-press a channel to configure:
- Notification mode (relentless/chill)
- DND override with custom hours
- Community posts opt-out (Global / On / Off, v3.1)
- Prewarn time (Override switch + 15m/30m/1h/2h/4h/1d picker, v3.1)

## Known Limitations (v3.1)

- **Posts do not enter the nag cycle.** Only the initial push fires for posts; no 4-hour reminders. Adding it would need a parallel nag bucket and FCM payload differentiation. Flagged for v3.2.

## Getting Started

```bash
# Install dependencies
npm install

# Start development server
npx expo start

# Run on Android
npx expo run:android
```

For a self-contained LAN test client that installs beside the main app, start the local backend and run:

```powershell
npm run build:android:selfhost -- --ApiUrl http://192.168.1.20:8788
```

The resulting ignored `dist/TubePulse-Preview-<version>-debug.apk` uses package `com.tubepulse.app.selfhost`, launcher label `TubePulse Preview`, and a bundled JavaScript payload. Its first-launch URL is health-tested and can later be changed from Settings without rebuilding. See the [no-new-Worker pilot](self-host/README.md#no-new-worker-preview-pilot) for Docker/LAN setup, the Firebase notification limitation, and installation instructions.

## Deploying Workers

```bash
# Deploy API worker source (app-facing API in repo; verify live route state first)
cd worker/tubepulse-api && npx wrangler deploy

# Optional rollback-only Worker deploys (do not enable Cron Triggers while Home owns scheduling)
for worker in tubepulse-rss-0 tubepulse-rss-1 tubepulse-rss-2 tubepulse-posts tubepulse-aux; do
  (cd "worker/$worker" && npx wrangler deploy)
done
```

Before worker cleanup, note that the app's workers.dev API URL is verified reachable, while the repo wrangler comment remains stale/incomplete; review deployed Cloudflare settings before route/config changes.

For the full cloud architecture — KV schema, endpoint reference, FCM details, cost analysis, free tier budget — see **[worker/README.md](worker/README.md)**.

Required Cloudflare secrets:
- `YOUTUBE_API_KEY` — Home authority for active discovery/metrics/bootstrap; API Worker for handle resolution where configured
- `FIREBASE_SERVICE_ACCOUNT` — Home authority for active FCM; retained Workers need it only during an explicit rollback
- `TUBEPULSE_KV` — configured KV binding for the public API and triggerless rollback Workers; Home journals bounded backup deltas into it

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

Forks and contributions are welcome under the MIT License.
