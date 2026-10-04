# Active Worker Contracts

**Last updated:** 2026-10-04
**Status:** Current-state inventory for the active Cloudflare Workers. This document records observed contracts, coupling, and known drift. It is not a refactor plan, and it does not imply that every behavior described here is ideal.

Use this file before changing `worker/tubepulse-api/` or any active scheduled worker. If code changes alter endpoint behavior, KV keys, notification payloads, cron cadence, bindings, or deployment assumptions, update this contract in the same commit.

---

## Active Workers

| Worker | Path | Role | Trigger type | KV binding | KV namespace | Deployment note |
|---|---|---|---|---|---|---|
| `tubepulse-api` | `worker/tubepulse-api/` | Live app-facing REST API plus dormant WebSub callback endpoints | HTTP `fetch` | `TUBEPULSE_KV` | `52e77ca9f5f6493e89d2478c8d3055ec` | Live `workers.dev` route was verified on 2026-06-25. `GET /` identifies `worker: "tubepulse-api"`. Wrangler config has no explicit route and contains a stale/incomplete route comment. |
| `tubepulse-rss-0/1/2` | `worker/tubepulse-rss-{0,1,2}/` | Retained RSS/video detection shards | None (`crons = []`) | `TUBEPULSE_KV` | `52e77ca9f5f6493e89d2478c8d3055ec` | Rollback-only; exact prior cadence is `*/5 * * * *`. |
| `tubepulse-posts` | `worker/tubepulse-posts/` | Retained time-rotated community-post poller | None (`crons = []`) | `TUBEPULSE_KV` | `52e77ca9f5f6493e89d2478c8d3055ec` | Rollback-only; exact prior wrapper cadence is `* * * * *`. |
| `tubepulse-aux` | `worker/tubepulse-aux/` | Retained bounded nag/prewarn worker | None (`crons = []`) | `TUBEPULSE_KV` | `52e77ca9f5f6493e89d2478c8d3055ec` | Rollback-only; exact prior cadence is `* * * * *`. |
| `tubepulse-cron` | `worker/tubepulse-cron/` | Retired compatibility stub; shared helpers remain in `shared.mjs` | None (`crons = []`) | `TUBEPULSE_KV` | `52e77ca9f5f6493e89d2478c8d3055ec` | Deliberate no-op. Never use as the active background deployment target. |

All active workers use `compatibility_date = "2025-04-01"` and Cloudflare account `77bb7769185bbfeb53feef16b9f72803` in their wrangler configs.

Community-post runtime behavior is behind `TUBEPULSE_ENABLE_COMMUNITY_POSTS`. The production posts config currently enables it with `true`; missing or any value other than `1`, `true`, or `yes` disables it.

When enabled, community-post polling applies to all channel IDs in `channels:active`. `TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST` is an optional staged-rollout/debug narrowing control: a non-empty value restricts polling; missing or blank means all active channels are eligible.

The API health endpoint currently returns `version: "3.0.0"`. App release evidence in the repo is `3.3.3` with Android `versionCode 337`. Treat these as separate labels until the worker health version is intentionally changed. The 2026-09-01 scheduled-worker repair did not deploy `tubepulse-api`, did not deploy the archived resolver, and did not change the app release/version.

The completed one-device gateway is retained default-off for rollback/history. The production successor is the separately latched unified authority wrapper. With `TUBEPULSE_HOME_AUTHORITY_ENABLED` false it delegates without a DO or Home call. With configuration enabled but `TUBEPULSE_HOME_AUTHORITY_TRAFFIC_ENABLED` false, signed reconciliation controls are available while every app request stays on the prior path. Traffic activation routes authenticated feeds for all devices to the same private-VPC Home store used by the scheduler, while Cloudflare-KV fallback remains bounded and available. App mutations retain their existing API contract and Cloudflare-first response semantics; exact conditional deltas replicate to Home under the global-then-local lease order. A missed preflight durably marks global stale or fails closed, and ordinary later success cannot clear it. Active WebSub pushes are acknowledged without processing to prevent a second detection/FCM owner.

## Archived Workers

`worker/archive/tubepulse-resolver/` contains the historical standalone resolver worker. It is retained for reference only and should not be deployed or edited unless deliberately restoring historical resolver behavior.

---

## API Endpoint Inventory

| Method | Path | Purpose | Auth | KV effects | External calls | Notification side effects | Risk |
|---|---|---|---|---|---|---|---|
| `GET` | `/` | Health check. Returns `status`, `version: "3.0.0"`, `worker`, and `architecture`. | None | None | None | None | Low |
| `OPTIONS` | `*` | CORS preflight. | None | None | None | None | Low |
| `POST` | `/register` | Create/update device profile, preserve or rotate FCM token, and migrate old device IDs that share an FCM token. | `Authorization: Bearer <deviceId>` | Reads/writes `device:{id}:profile`, `fcm:lookup:{token}`, settings/channels/state during migration; deletes old device state; uses `KV.list({ prefix: 'device:' })` for slow-path migration. | None | None | High |
| `POST` | `/subscribe-channel` | Add a channel to a device, populate inverse subscriber list, repair missing avatar metadata, bootstrap recent data, and enqueue dormant WebSub subscription attempt on first subscriber. | Bearer deviceId | Reads/writes `device:{id}:channels`, `channel:{id}:subscribers`, `channel:{id}:meta`, `channel:{id}:recent`, `channels:active`, `channel:{id}:websub`. | YouTube Data API for missing avatar metadata; YouTube RSS for recent videos; Data API fallback for recent videos; WebSub hub POST attempt. | None directly. | High |
| `POST` | `/unsubscribe` | Remove device from channel, delete per-channel device state/override, and clean channel cache if it was the last subscriber. | Bearer deviceId | Reads/writes/deletes `device:{id}:channels`, `channel:{id}:subscribers`, `device:{id}:state:{channelId}`, `device:{id}:override:{channelId}`, channel cache/post cache via cleanup. | WebSub unsubscribe POST attempt. | None | Medium |
| `POST` | `/seen` | Mark video IDs or post IDs as watched, or clear all unwatched state for one channel. | Bearer deviceId | Reads/writes `device:{id}:state:{channelId}`. Removes seen IDs from `unwatched`. When `unwatched` becomes empty, resets `nagCount` to 0 and `lastNagAt` to null so the next unread item starts a fresh nag cadence. | None | Affects future nag eligibility. | Medium |
| `GET` | `/feed` | Return subscribed channels with meta, recent videos, and per-device unwatched flags. Community posts are returned only when `TUBEPULSE_ENABLE_COMMUNITY_POSTS` is enabled. | Bearer deviceId | Reads `device:{id}:settings`, `device:{id}:profile`, `device:{id}:channels`, channel meta/recent, and device state. When community posts are enabled, also reads post cache and overrides. | None | None | Medium |
| `GET` | `/resolve` | Resolve a `handle` or `channelId` to canonical channel info. | Bearer deviceId | Reads `device:{id}:profile`; reads/writes `handle:{lowercase}` cache. | YouTube Data API `channels.list`. | None | Medium |
| `POST` | `/bootstrap` | On-demand channel meta/recent refresh for a channel already tracked by the device, including repair of a missing cached avatar. | Bearer deviceId | Reads/writes device/channel keys, `channels:active`, and `channel:{id}:websub`. | YouTube Data API, YouTube RSS, WebSub hub POST attempt. | None directly. | High |
| `POST` | `/settings` | Replace device-level notification settings. | Bearer deviceId | Writes `device:{id}:settings`. | None | Changes future notification filtering/nag/prewarn behavior. | Medium |
| `POST` | `/channel-override` | Set or delete per-channel notification override. | Bearer deviceId | Writes or deletes `device:{id}:override:{channelId}`. | None | Changes future notification filtering/nag/prewarn/community-post behavior. | Medium |
| `GET` | `/websub` | Dormant WebSub verification handshake. | None | Reads/writes/deletes `channel:{id}:websub`. | None | None | Dormant/Medium |
| `POST` | `/websub` | Dormant WebSub push processing path. Parses feed XML, writes recent/meta/state, and fans out FCM. Nag processing is owned by `tubepulse-aux`. | HMAC when matching WebSub state exists | Reads/writes channel recent/meta/subscribers, device profile/settings/override/state, `upcoming:events:list`; can cleanup dead devices. | FCM; only called if a WebSub-compatible source posts to it. | Sends push notifications and can prune dead devices. | Dormant/High |

Important exception: `/register` intentionally uses `KV.list({ prefix: 'device:' })` for slow-path FCM-token migration. Documentation should not claim zero `KV.list()` calls globally. Active scheduled workers are designed not to call `KV.list()`.

---

## Cron And Background Inventory

The production scheduler is the unified local Home authority in `self-host/`. It reuses the pollers below in one process/store: all active video channels every five minutes, eligible community-post channels hourly, and aux work each minute. `tubepulse-api` remains the public interface and coordinates exact all-device mutation deltas plus Home-backed feeds over VPC. The five scheduled Worker deployments remain rollback artifacts but have no Cron Triggers. The separate `home-scheduler` shadow profile remains test-only and cannot send FCM or publish remote mutations.

| Function | Cadence | Purpose | KV effects | External calls | FCM side effects | Risk | Notes |
|---|---|---|---|---|---|---|---|
| Home video sweep (reuses RSS handler) | Every five minutes | Poll every active channel once and run watermark-protected RSS detection. | Local-first; publishes only journaled changed keys to KV backup. | YouTube RSS; FCM only after public-feed visibility. | Sends upload/live pushes after barrier; can prune dead devices. | High | The live 85-channel sweep replaces shard rotation. |
| Home posts sweep (reuses posts handler) | Hourly | Poll every eligible channel and reconcile its latest InnerTube post. | Local-first; publishes only journaled changed keys. | InnerTube; FCM only after public-feed visibility. | First poll is silent; rollback/restoration is suppressed. | High | Quota guard reports the all-channel projection. |
| Home aux (`runNag` / `runPrewarn`) | Every minute | Drain current legacy bucket, process a bounded nag batch, then check prewarns if no nag fired. | Local-first; publishes changed state under the authority lease. | FCM when due and visibility-safe. | Sends reminder and prewarn pushes; can prune dead devices. | High | Notification eligibility remains timestamp-based. |

RSS selection is driven by `floor((scheduledTime ?? Date.now()) / 300000)`, which advances once per five-minute trigger. The code and trigger must use the same step; using raw epoch minutes at this cadence would advance by five and can skip positions when a shard length shares a factor with five. Local rotation coverage exercises active-channel counts 1 through 100, including both the 71-channel assessment baseline and the 74-channel deployment-time set.

---

## KV Schema Inventory

| Key | Owner/use | Shape or purpose | Current notes |
|---|---|---|---|
| `channel:{id}:meta` | Shared | Channel display/cache metadata such as `name`, `avatarUrl`, `lastVideoId`, `addedAt`. | Written by API bootstrap/subscribe and cron RSS updates. |
| `channel:{id}:subscribers` | Shared | JSON array of `deviceId`s subscribed to the channel. | API mutates on subscribe/unsubscribe; cron reads for fan-out and cleanup. |
| `channel:{id}:websub` | Mostly API/dormant | WebSub lease/HMAC state. | WebSub is currently dormant/stale; API can still write/read this key. |
| `channel:{id}:recent` | Shared | Recent video array containing structural fields, nullable `views`, `likes`, `dislikes`, and optional `viewsLastCheckedHour` / `likesLastCheckedHour` UTC-hour persistence clocks. Decimal strings, including `"0"`, are known counts; null/missing means hidden or unavailable. | API can bootstrap; RSS is the active updater. Existing cached metrics are preserved except for policy-eligible refreshes of the latest entry; RSS order, structural changes, additions, and removals still persist. API bootstrap preserves RSS metrics (or the equivalent Data API statistics fallback) and seeds both clocks. |
| `channel:{id}:recent:posts` | Shared | Latest community post array, currently empty or one item. Post objects use canonical `id: "post:{postId}"`, preserve `publishedText`, include `fetchedAt`, `publishedAt`, and `publishedAtSource` when InnerTube relative age can be estimated, and may include optional `likeCount`/`likeText` or `viewCount`/`viewText` when those fields are exposed directly on the InnerTube post renderer. `likeCount: 0` is a real explicit value; null/missing means unknown or unavailable. | Written/read only when `TUBEPULSE_ENABLE_COMMUNITY_POSTS` is enabled; API/cron dead-channel cleanup deletes it even when disabled. Existing cached posts without `publishedAt` or metrics remain valid; cron enriches the same latest post once and then preserves that timestamp to avoid hourly drift. Cache refresh ignores rotating YouTube `sqp`/`rs` thumbnail delivery parameters when origin/path is unchanged and ignores relative-label churn only with an unchanged valid `publishedAt`; real path/content/metric changes and label changes without a valid timestamp still refresh. Missing metrics are unknown, not zero. |
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
| `gateway:canary:{sha256}:state` | API gateway only | Privacy-preserving route state for the configured canary (`current` or `stale`) plus non-sensitive transition metadata. | Written only on state transitions; never mirrored to Home. Code defaults off, while one explicitly configured production canary is currently `current`. |

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
- `worker/test-api-gateway.mjs`
- `worker/tubepulse-rss-0/test-rss-watermark.mjs`

This is intentionally narrow. It catches JavaScript parse errors without deploying workers, calling live APIs, changing KV state, or requiring a test framework.

---
## Suggested Next Steps

1. Add lightweight static checks for worker syntax and contract-sensitive patterns.
2. Fix docs contradictions around `KV.list()`, branch/status wording, and dormant WebSub history.
3. Consider shared modules only after checks exist and the current contracts are covered.
