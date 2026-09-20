# Active Worker Contracts

**Last updated:** 2026-09-20
**Status:** Current-state inventory for the active Cloudflare Workers. This document records observed contracts, coupling, and known drift. It is not a refactor plan, and it does not imply that every behavior described here is ideal.

Use this file before changing `worker/tubepulse-api/` or any active scheduled worker. If code changes alter endpoint behavior, KV keys, notification payloads, cron cadence, bindings, or deployment assumptions, update this contract in the same commit.

---

## Active Workers

| Worker | Path | Role | Trigger type | KV binding | KV namespace | Deployment note |
|---|---|---|---|---|---|---|
| `tubepulse-api` | `worker/tubepulse-api/` | Live app-facing REST API plus dormant WebSub callback endpoints | HTTP `fetch` | `TUBEPULSE_KV` | `52e77ca9f5f6493e89d2478c8d3055ec` | Live `workers.dev` route was verified on 2026-06-25. `GET /` identifies `worker: "tubepulse-api"`. Wrangler config has no explicit route and contains a stale/incomplete route comment. |
| `tubepulse-rss-0/1/2` | `worker/tubepulse-rss-{0,1,2}/` | RSS/video detection shards; one selected channel per active shard per tick | Cloudflare scheduled event, `*/5 * * * *` | `TUBEPULSE_KV` | `52e77ca9f5f6493e89d2478c8d3055ec` | Scheduled-only. Distinct `RSS_SHARD_INDEX`; durable `known:videos` watermark prevents deletion cascades. |
| `tubepulse-posts` | `worker/tubepulse-posts/` | Time-rotated community-post polling | Cloudflare scheduled event, `* * * * *` | `TUBEPULSE_KV` | `52e77ca9f5f6493e89d2478c8d3055ec` | Selects one eligible channel per tick and spaces selections across an hour. |
| `tubepulse-aux` | `worker/tubepulse-aux/` | Bounded nag/prewarn work and legacy bucket drain | Cloudflare scheduled event, `* * * * *` | `TUBEPULSE_KV` | `52e77ca9f5f6493e89d2478c8d3055ec` | Processes at most five nag entries per invocation. |
| `tubepulse-cron` | `worker/tubepulse-cron/` | Retired compatibility stub; shared helpers remain in `shared.mjs` | None (`crons = []`) | `TUBEPULSE_KV` | `52e77ca9f5f6493e89d2478c8d3055ec` | Deliberate no-op. Never use as the active background deployment target. |

All active workers use `compatibility_date = "2025-04-01"` and Cloudflare account `77bb7769185bbfeb53feef16b9f72803` in their wrangler configs.

Community-post runtime behavior is behind `TUBEPULSE_ENABLE_COMMUNITY_POSTS`. The production posts config currently enables it with `true`; missing or any value other than `1`, `true`, or `yes` disables it.

When enabled, community-post polling applies to all channel IDs in `channels:active`. `TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST` is an optional staged-rollout/debug narrowing control: a non-empty value restricts polling; missing or blank means all active channels are eligible.

The API health endpoint currently returns `version: "3.0.0"`. App release evidence in the repo is `3.3.3` with Android `versionCode 337`. Treat these as separate labels until the worker health version is intentionally changed. The 2026-09-01 scheduled-worker repair did not deploy `tubepulse-api`, did not deploy the archived resolver, and did not change the app release/version.

## Archived Workers

`worker/archive/tubepulse-resolver/` contains the historical standalone resolver worker. It is retained for reference only and should not be deployed or edited unless deliberately restoring historical resolver behavior.

---

## API Endpoint Inventory

| Method | Path | Purpose | Auth | KV effects | External calls | Notification side effects | Risk |
|---|---|---|---|---|---|---|---|
| `GET` | `/` | Health check. Returns `status`, `version: "3.0.0"`, `worker`, and `architecture`. | None | None | None | None | Low |
| `OPTIONS` | `*` | CORS preflight. | None | None | None | None | Low |
| `POST` | `/register` | Create/update device profile, preserve or rotate FCM token, and migrate old device IDs that share an FCM token. | `Authorization: Bearer <deviceId>` | Reads/writes `device:{id}:profile`, `fcm:lookup:{token}`, settings/channels/state during migration; deletes old device state; uses `KV.list({ prefix: 'device:' })` for slow-path migration. | None | None | High |
| `POST` | `/subscribe-channel` | Add a channel to a device, populate inverse subscriber list, bootstrap channel meta/recent data, and enqueue dormant WebSub subscription attempt on first subscriber. | Bearer deviceId | Reads/writes `device:{id}:channels`, `channel:{id}:subscribers`, `channel:{id}:meta`, `channel:{id}:recent`, `channels:active`, `channel:{id}:websub`. | YouTube Data API for channel meta when missing; YouTube RSS for recent videos; Data API fallback for recent videos; WebSub hub POST attempt. | None directly. | High |
| `POST` | `/unsubscribe` | Remove device from channel, delete per-channel device state/override, and clean channel cache if it was the last subscriber. | Bearer deviceId | Reads/writes/deletes `device:{id}:channels`, `channel:{id}:subscribers`, `device:{id}:state:{channelId}`, `device:{id}:override:{channelId}`, channel cache/post cache via cleanup. | WebSub unsubscribe POST attempt. | None | Medium |
| `POST` | `/seen` | Mark video IDs or post IDs as watched, or clear all unwatched state for one channel. | Bearer deviceId | Reads/writes `device:{id}:state:{channelId}`. Removes seen IDs from `unwatched`. When `unwatched` becomes empty, resets `nagCount` to 0 and `lastNagAt` to null so the next unread item starts a fresh nag cadence. | None | Affects future nag eligibility. | Medium |
| `GET` | `/feed` | Return subscribed channels with meta, recent videos, and per-device unwatched flags. Community posts are returned only when `TUBEPULSE_ENABLE_COMMUNITY_POSTS` is enabled. | Bearer deviceId | Reads `device:{id}:settings`, `device:{id}:profile`, `device:{id}:channels`, channel meta/recent, and device state. When community posts are enabled, also reads post cache and overrides. | None | None | Medium |
| `GET` | `/resolve` | Resolve a `handle` or `channelId` to canonical channel info. | Bearer deviceId | Reads `device:{id}:profile`; reads/writes `handle:{lowercase}` cache. | YouTube Data API `channels.list`. | None | Medium |
| `POST` | `/bootstrap` | On-demand channel meta/recent refresh for a channel already tracked by the device. | Bearer deviceId | Reads/writes device/channel keys, `channels:active`, and `channel:{id}:websub`. | YouTube Data API, YouTube RSS, WebSub hub POST attempt. | None directly. | High |
| `POST` | `/settings` | Replace device-level notification settings. | Bearer deviceId | Writes `device:{id}:settings`. | None | Changes future notification filtering/nag/prewarn behavior. | Medium |
| `POST` | `/channel-override` | Set or delete per-channel notification override. | Bearer deviceId | Writes or deletes `device:{id}:override:{channelId}`. | None | Changes future notification filtering/nag/prewarn/community-post behavior. | Medium |
| `GET` | `/websub` | Dormant WebSub verification handshake. | None | Reads/writes/deletes `channel:{id}:websub`. | None | None | Dormant/Medium |
| `POST` | `/websub` | Dormant WebSub push processing path. Parses feed XML, writes recent/meta/state, and fans out FCM. Nag processing is owned by `tubepulse-aux`. | HMAC when matching WebSub state exists | Reads/writes channel recent/meta/subscribers, device profile/settings/override/state, `upcoming:events:list`; can cleanup dead devices. | FCM; only called if a WebSub-compatible source posts to it. | Sends push notifications and can prune dead devices. | Dormant/High |

Important exception: `/register` intentionally uses `KV.list({ prefix: 'device:' })` for slow-path FCM-token migration. Documentation should not claim zero `KV.list()` calls globally. Active scheduled workers are designed not to call `KV.list()`.

---

## Cron And Background Inventory

| Function | Cadence | Purpose | KV effects | External calls | FCM side effects | Risk | Notes |
|---|---|---|---|---|---|---|---|
| RSS shard scheduled handler | Every five minutes per Worker | Select one channel from the active shard and run watermark-protected RSS detection. | Reads active/recent/known/meta/subscriber/device state; writes changed cache/watermark/device state and `nag:active`. | YouTube RSS; FCM only for new eligible content. | Sends upload/live pushes; can prune dead devices. | High | Selection uses a five-minute epoch tick. With 19 active channels, shard sizes are 7/6/6 and a complete rotation takes at most 35 minutes. |
| Posts scheduled handler | Every minute | Select one eligible channel using an hour-spaced time rotation and reconcile its latest InnerTube post. | Reads/writes post cache, known IDs, first-poll sentinel, subscriber/device state, and `nag:active`. | InnerTube; FCM only for an unknown new post. | First poll is silent; rollback/restoration is suppressed. | High | With six channels, each channel is selected once per hour. |
| Aux `runNag` / `runPrewarn` | Every minute | Drain current legacy bucket, process a bounded nag batch, then check prewarns if no nag fired. | Reads/writes `nag:active`, upcoming events/prewarn sentinels, and device state. | FCM when due. | Sends reminder and prewarn pushes; can prune dead devices. | High | Nag cadence remains timestamp-based; per-minute invocation does not imply per-minute notifications. |

RSS selection is driven by `floor((scheduledTime ?? Date.now()) / 300000)`, which advances once per `*/5` trigger. Using raw epoch minutes would advance by five and can starve shard positions when the shard length shares a factor with five. Local rotation coverage exercises active-channel counts 1 through 30.

---

## KV Schema Inventory

| Key | Owner/use | Shape or purpose | Current notes |
|---|---|---|---|
| `channel:{id}:meta` | Shared | Channel display/cache metadata such as `name`, `avatarUrl`, `lastVideoId`, `addedAt`. | Written by API bootstrap/subscribe and cron RSS updates. |
| `channel:{id}:subscribers` | Shared | JSON array of `deviceId`s subscribed to the channel. | API mutates on subscribe/unsubscribe; cron reads for fan-out and cleanup. |
| `channel:{id}:websub` | Mostly API/dormant | WebSub lease/HMAC state. | WebSub is currently dormant/stale; API can still write/read this key. |
| `channel:{id}:recent` | Shared | Recent video array containing structural fields, `views`, `likes`, `dislikes`, and optional `viewsLastCheckedHour` / `likesLastCheckedHour` UTC-hour persistence clocks. | API can bootstrap; RSS is the active updater. Existing cached metrics are preserved except for policy-eligible refreshes of the latest entry; RSS order, structural changes, additions, and removals still persist. |
| `channel:{id}:recent:posts` | Shared | Latest community post array, currently empty or one item. Post objects use canonical `id: "post:{postId}"`, preserve `publishedText`, include `fetchedAt`, `publishedAt`, and `publishedAtSource` when InnerTube relative age can be estimated, and may include optional `likeCount`/`likeText` or `viewCount`/`viewText` when those fields are exposed directly on the InnerTube post renderer. `likeCount: 0` is a real explicit value; null/missing means unknown or unavailable. | Written/read only when `TUBEPULSE_ENABLE_COMMUNITY_POSTS` is enabled; API/cron dead-channel cleanup deletes it even when disabled. Existing cached posts without `publishedAt` or metrics remain valid; cron enriches the same latest post once and then preserves that timestamp to avoid hourly drift. Missing metrics are unknown, not zero. |
| `channel:{id}:firstPollAt:posts` | Shared cleanup, cron writer | ISO timestamp sentinel for community-post first-run guard. | Written only when `TUBEPULSE_ENABLE_COMMUNITY_POSTS` is enabled; API/cron dead-channel cleanup deletes it even when disabled. |
| `channel:{id}:known:posts` | Cron writer, shared cleanup | Bounded JSON array of canonical community post IDs such as `post:{postId}`. | Notification/deletion watermark only, not display history. Capped at 20 IDs. API/cron dead-channel cleanup deletes it even when disabled. |
| `device:{id}:profile` | Shared | Device profile with FCM token, platform, app version, created/last seen timestamps. | API writes; API/cron read. |
| `device:{id}:settings` | Shared | Device notification settings. | API writes full replacement; cron/API read. |
| `device:{id}:channels` | Shared | JSON array of subscribed channel IDs for the device. | API writes; API reads for `/feed`; cleanup reads. |
| `device:{id}:override:{channelId}` | Shared | Per-channel notification override. | API writes/deletes; cron/API read. |
| `device:{id}:state:{channelId}` | Shared | Per-device/channel state, including `unwatched` (array of videoId strings and `post:{activityId}` strings), `lastNagAt` (timestamp or null), `nagCount` (number). `lastNagAt` and `nagCount` are reset to null/0 by `/seen` when `unwatched` becomes empty. | API `/seen` writes; cron/API notification paths write/read. |
| `channels:active` | Shared | JSON array of channels with at least one subscriber. | API writes on first/last subscriber; cron reads for polling. |
| `nag:{bucket}` | Legacy | **Unused** — pending nag entries from the old 15-min bucket system. No longer read or written by any code path. Replaced by timestamp-based `runNagCron` in commit `f093630`. | (none) | (none) |
| `upcoming:{bucket}` | Legacy/shared | Pre-v3.1 scheduled-live bucket. | Cron drains only; active code should not add new entries. |
| `upcoming:events:list` | Shared, mostly cron | Global list of scheduled live events. | API WebSub and cron RSS can append; cron prewarn reads/prunes. |
| `upcoming:prewarn:{videoId}:{deviceId}` | Cron-only | Sentinel that a prewarn was sent for a device/event. | Present in cron key builders only. |
| `handle:{lowercase}` | API-only | Cached handle resolution result. | API `/resolve` reads/writes. |
| `fcm:lookup:{fcmToken}` | API-only | Reverse FCM token to deviceId migration index. | Present in API key builders only; cleanup drift means cron cleanup does not currently clear it. |

---

## Known Drift And Risks

- **Key builder drift:** narrowed and deployed for cron on 2026-06-25. API and cron both define `fcmLookup` and `firstPollAtPosts`; cron still has cron-only `prewarnSent`. Shared keys are still duplicated manually.
- **`cleanupDeadChannel` drift:** API and cron cleanup both delete `channel:{id}:subscribers`, `channel:{id}:recent:posts`, `channel:{id}:firstPollAt:posts`, and `channel:{id}:known:posts` when removing dead channel state.
- **`cleanupDeadDevice` drift:** narrowed and deployed for cron on 2026-06-25. Cron cleanup now reads the profile and deletes `fcm:lookup:{token}` when `profile.fcmToken` exists, while still cleaning channel state if the profile is already missing.
- **Duplicated `sendFCMPush`:** API and cron each define their own FCM OAuth/sign/send helper.
- **Notification payload shape compatibility:** fixed and deployed for cron on 2026-06-25. Cron `sendFCMPush` now accepts the existing flat `payload.title`/`payload.body` shape and the nested `payload.notification.title`/`payload.notification.body` shape used by prewarn/community-post callers. Flat fields remain the preferred shape for new callers.
- **DND/settings logic duplication:** effective notification settings are rebuilt in API WebSub, RSS cron, nag cron, prewarn cron, and community-post logic.
- **RSS/feed parsing duplication:** API and cron parse YouTube Atom/RSS separately, with small differences in field handling.
- **Stale/dormant WebSub behavior:** WebSub subscribe/unsubscribe/push code remains, but the public PubSubHubbub hub URL is believed defunct. Do not assume WebSub is active without live verification.
- **Hardcoded API callback URL in cron:** `runLeaseCron` uses `https://tubepulse-api.jimothyoakley55.workers.dev/websub`.
- **Stale health version:** API `GET /` reports `version: "3.0.0"` while app release evidence is `3.3.3` / Android `versionCode 337`.
- **Documentation drift:** older architecture/history sections may still imply zero global `KV.list()` use, active WebSub assumptions, or older Data API polling behavior. Treat this document and `STATUS.md` as the current operational starting point.

---

## Guardrails For Future Edits

- Do not change API and cron KV keys independently without updating this contract.
- Do not modify notification payload shape without checking every `sendFCMPush` caller in both workers.
- Do not assume WebSub is active without live route and hub verification.
- Do not edit `worker/archive/tubepulse-resolver/` unless deliberately restoring historical resolver behavior.
- Prefer small commits with validation after worker changes.
- Keep worker code, wrangler config, docs, and app URL assumptions in sync when deployment behavior changes.

---

## Local Validation

Run this lightweight syntax check before and after worker behavior changes:

```bash
npm run check:workers
```

The command runs syntax checks against the API, retired stub/shared module, all five active scheduled entrypoints, and the posts parser, then runs focused schedule/rotation, RSS merge-policy, and watermark coverage:

- `worker/tubepulse-api/index.js`
- `worker/tubepulse-cron/index.js` and `shared.mjs`
- `worker/tubepulse-rss-0/1/2/index.js`
- `worker/tubepulse-posts/index.js` and `community-posts.mjs`
- `worker/tubepulse-aux/index.js`
- `worker/test-scheduled-worker-rotation.mjs`
- `worker/test-rss-recent-merge.mjs`
- `worker/tubepulse-rss-0/test-rss-watermark.mjs`

This is intentionally narrow. It catches JavaScript parse errors without deploying workers, calling live APIs, changing KV state, or requiring a test framework.

---
## Suggested Next Steps

1. Add lightweight static checks for worker syntax and contract-sensitive patterns.
2. Fix docs contradictions around `KV.list()`, branch/status wording, and dormant WebSub history.
3. Consider shared modules only after checks exist and the current contracts are covered.
