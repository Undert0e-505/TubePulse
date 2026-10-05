# Active Worker Contracts

**Last updated:** 2026-10-05
**Status:** Current-state inventory for the active Cloudflare Workers. This document records observed contracts, coupling, and known drift. It is not a refactor plan, and it does not imply that every behavior described here is ideal.

Use this file before changing `worker/tubepulse-api/` or any active scheduled worker. If code changes alter endpoint behavior, canonical keys, notification payloads, cron cadence, bindings, or deployment assumptions, update this contract in the same commit.

---

## Active Workers

| Worker | Path | Role | Trigger type | Storage binding | Canonical status | Deployment note |
|---|---|---|---|---|---|---|
| `tubepulse-api` | `worker/tubepulse-api/` | Live app-facing REST API plus dormant WebSub callback endpoints | HTTP `fetch` | `TUBEPULSE_D1` plus frozen `TUBEPULSE_KV` | D1 selected by explicit backend generation | Existing `workers.dev` route is unchanged. |
| `tubepulse-rss-0/1/2` | `worker/tubepulse-rss-{0,1,2}/` | Retained RSS/video detection shards | None (`crons = []`) | Frozen `TUBEPULSE_KV` | Not current | Rollback-only; handler is a no-op unless the frozen-KV acknowledgement latch is explicitly enabled. |
| `tubepulse-posts` | `worker/tubepulse-posts/` | Retained time-rotated community-post poller | None (`crons = []`) | Frozen `TUBEPULSE_KV` | Not current | Rollback-only; same explicit acknowledgement latch. |
| `tubepulse-aux` | `worker/tubepulse-aux/` | Retained bounded nag/prewarn worker | None (`crons = []`) | Frozen `TUBEPULSE_KV` | Not current | Rollback-only; same explicit acknowledgement latch. |
| `tubepulse-cron` | `worker/tubepulse-cron/` | Retired compatibility stub; shared helpers remain in `shared.mjs` | None (`crons = []`) | Legacy `TUBEPULSE_KV` | Not current | Deliberate no-op. Never use as the active background deployment target. |

Compatibility dates are defined per Worker in tracked Wrangler configuration; the API uses the newer runtime required by Workers VPC. Account and binding identifiers remain in those configs rather than this operational contract.

Community-post runtime behavior is behind `TUBEPULSE_ENABLE_COMMUNITY_POSTS`. The production posts config currently enables it with `true`; missing or any value other than `1`, `true`, or `yes` disables it.

When enabled, community-post polling applies to all channel IDs in `channels:active`. `TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST` is an optional staged-rollout/debug narrowing control: a non-empty value restricts polling; missing or blank means all active channels are eligible.

Active production video discovery is owned only by the unified Home authority. It uses batched `channels.list` change detection, structural uploads-playlist reconciliation, batched video metadata/statistics, and the existing `channel:{id}:known:videos` watermark. The triggerless RSS workers are not an automatic fallback. `/bootstrap` uses the same structural uploads path and never `search.list`; `/resolve` remains an occasional Data API operation.

The API health endpoint's `version` is a backend contract label, not the Android release version. Treat those labels separately until the health schema is intentionally versioned with the app.

The completed one-device gateway is retained default-off for rollback/history. The production successor is the separately latched unified authority wrapper. With `TUBEPULSE_HOME_AUTHORITY_ENABLED` false it delegates without a DO or Home call. With configuration enabled but `TUBEPULSE_HOME_AUTHORITY_TRAFFIC_ENABLED` false, signed reconciliation controls are available while every app request stays on the prior path. Traffic activation routes authenticated feeds for all devices to the same private-VPC Home store used by the scheduler, while D1 fallback remains bounded and available. Authenticated app mutations keep their API contract but execute canonically on Home under global-then-local lease order; successful exact deltas enter the coordinator's durable deferred D1-backup queue without requiring a request-time canonical read. Home failure fails closed rather than creating split brain. Active WebSub pushes are acknowledged without processing to prevent a second detection/FCM owner.

## Archived Workers

`worker/archive/tubepulse-resolver/` contains the historical standalone resolver worker. It is retained for reference only and should not be deployed or edited unless deliberately restoring historical resolver behavior.

---

## API Endpoint Inventory

| Method | Path | Purpose | Auth | Canonical effects | External calls | Notification side effects | Risk |
|---|---|---|---|---|---|---|---|
| `GET` | `/` | Health check. Returns `status`, `version: "3.0.0"`, `worker`, and `architecture`. | None | None | None | None | Low |
| `OPTIONS` | `*` | CORS preflight. | None | None | None | None | Low |
| `POST` | `/register` | Create/update device profile, preserve or rotate FCM token, and migrate old device IDs that share an FCM token. | `Authorization: Bearer <deviceId>` | Reads/writes `device:{id}:profile`, `fcm:lookup:{token}`, settings/channels/state during migration; deletes old device state; uses `KV.list({ prefix: 'device:' })` for slow-path migration. | None | None | High |
| `POST` | `/subscribe-channel` | Add a channel to a device, populate inverse subscriber list, repair missing metadata, and bootstrap recent data. | Bearer deviceId | Reads/writes `device:{id}:channels`, `channel:{id}:subscribers`, `channel:{id}:meta`, `channel:{id}:recent`, `channels:active`. | YouTube Data API structural channel/uploads path. | None directly. | High |
| `POST` | `/unsubscribe` | Remove device from channel, delete per-channel device state/override, and stop polling/clean display caches if it was the final subscriber. | Bearer deviceId | Reads/writes/deletes `device:{id}:channels`, `channel:{id}:subscribers`, `device:{id}:state:{channelId}`, `device:{id}:override:{channelId}`, `channels:active`, channel/post display caches. Retains `channel:{id}:known:videos` for safe resubscribe. | Dormant WebSub unsubscribe POST attempt. | None | Medium |
| `POST` | `/seen` | Mark video IDs or post IDs as watched, or clear all unwatched state for one channel. | Bearer deviceId | Reads/writes `device:{id}:state:{channelId}`. Removes seen IDs from `unwatched`. When `unwatched` becomes empty, resets `nagCount` to 0 and `lastNagAt` to null so the next unread item starts a fresh nag cadence. | None | Affects future nag eligibility. | Medium |
| `GET` | `/feed` | Return subscribed channels with meta, recent videos, and per-device unwatched flags. Community posts are returned only when `TUBEPULSE_ENABLE_COMMUNITY_POSTS` is enabled. | Bearer deviceId | Reads `device:{id}:settings`, `device:{id}:profile`, `device:{id}:channels`, channel meta/recent, and device state. When community posts are enabled, also reads post cache and overrides. | None | None | Medium |
| `GET` | `/resolve` | Resolve a `handle` or `channelId` to canonical channel info. | Bearer deviceId | Reads `device:{id}:profile`; reads/writes `handle:{lowercase}` cache. | YouTube Data API `channels.list`. | None | Medium |
| `POST` | `/bootstrap` | On-demand channel meta/recent refresh for a channel already tracked by the device, including repair of missing cached metadata. | Bearer deviceId | Reads/writes device/channel keys and `channels:active`. | YouTube Data API `channels.list`, `playlistItems.list`, and batched video metadata/statistics. | None directly. | High |
| `POST` | `/settings` | Replace device-level notification settings. | Bearer deviceId | Writes `device:{id}:settings`. | None | Changes future notification filtering/nag/prewarn behavior. | Medium |
| `POST` | `/channel-override` | Set or delete per-channel notification override. | Bearer deviceId | Writes or deletes `device:{id}:override:{channelId}`. | None | Changes future notification filtering/nag/prewarn/community-post behavior. | Medium |
| `GET` | `/websub` | Dormant WebSub verification handshake. | None | Reads/writes/deletes `channel:{id}:websub`. | None | None | Dormant/Medium |
| `POST` | `/websub` | Dormant WebSub push processing path. Parses feed XML, writes recent/meta/state, and fans out FCM. Nag processing is owned by `tubepulse-aux`. | HMAC when matching WebSub state exists | Reads/writes channel recent/meta/subscribers, device profile/settings/override/state, `upcoming:events:list`; can cleanup dead devices. | FCM; only called if a WebSub-compatible source posts to it. | Sends push notifications and can prune dead devices. | Dormant/High |
| `POST` | `/_tubepulse/authority/rss-probe` | Retained bounded RSS diagnostic from the superseded outage gate. Accepts only an optional strict channel ID and constructs fixed YouTube feed URLs. The active scheduler does not call it. | Authority HMAC + timestamp + replay guard | None | YouTube RSS for a known-valid official feed and at most one active feed. | None | Legacy/Medium. |

Important exception: `/register` intentionally uses the canonical adapter's prefix `list({ prefix: 'device:' })` for slow-path FCM-token migration. Documentation should not claim zero canonical list calls globally. Active scheduled workers are designed not to list the complete key space.

---

## Cron And Background Inventory

The production scheduler is the unified local Home authority in `self-host/`. It performs batched Data API video discovery every five minutes, polls eligible community posts hourly, and runs aux work each minute. `tubepulse-api` remains the public interface and coordinates exact all-device mutation deltas plus Home-backed feeds over VPC. The five scheduled Worker deployments remain rollback artifacts with no Cron Triggers. The separate `home-scheduler` shadow profile remains test-only and cannot send FCM or publish remote mutations.

| Function | Cadence | Purpose | KV effects | External calls | FCM side effects | Risk | Notes |
|---|---|---|---|---|---|---|---|
| Home Data API video detector | Every five minutes | Batch channel counts, reconcile changed/migration/safety-due uploads playlists, and poll adaptive video statistics with durable watermark protection. | Local-first; publishes only journaled changed keys to D1 backup. | `channels.list`, `playlistItems.list`, `videos.list`, `videos:batchGetStats`; FCM only after public-feed visibility. | Sends upload/live pushes after barrier; can prune dead devices. | High | Production-active since 2026-10-05; no automatic RSS fallback. |
| Home posts sweep (reuses posts handler) | Hourly | Poll every eligible channel and reconcile its latest InnerTube post. | Local-first; publishes only journaled changed keys. | InnerTube; FCM only after public-feed visibility. | First poll is silent; rollback/restoration is suppressed. | High | Quota guard reports the all-channel projection. |
| Home aux (`runNag` / `runPrewarn`) | Every minute | Drain current legacy bucket, process a bounded nag batch, then check prewarns if no nag fired. | Local-first; publishes changed state under the authority lease. | FCM when due and visibility-safe. | Sends reminder and prewarn pushes; can prune dead devices. | High | Notification eligibility remains timestamp-based. |

Retained Cloudflare shard selection is driven by `floor((scheduledTime ?? Date.now()) / 300000)`, which advances once per five-minute rollback trigger. Home instead derives one deterministic pseudo-random order per five-minute epoch and splits it into five balanced cohorts. Coverage tests exercise active-channel counts 1 through 100, prove exactly-once membership/balance/restart reproducibility, and keep shard behavior compatible for rollback.

---

## Canonical key schema inventory

| Key | Owner/use | Shape or purpose | Current notes |
|---|---|---|---|
| `channel:{id}:meta` | Shared | Channel display/cache metadata such as `name`, `avatarUrl`, compatibility/bootstrap `lastVideoId`, `addedAt`. | Written by API bootstrap/subscribe; Home may repair missing display metadata but active upload detection does not rewrite it solely for `lastVideoId`. |
| `channel:{id}:subscribers` | Shared | JSON array of `deviceId`s subscribed to the channel. | API mutates on subscribe/unsubscribe; cron reads for fan-out and cleanup. |
| `channel:{id}:websub` | Mostly API/dormant | WebSub lease/HMAC state. | WebSub is currently dormant/stale; API can still write/read this key. |
| `channel:{id}:recent` | Shared | Recent video array containing structural fields, nullable `views`, `likes`, `comments`, `dislikes`, and per-metric UTC-hour persistence clocks. Decimal strings, including `"0"`, are known counts; null/missing means hidden or unavailable. | Home Data API discovery is the active updater. New entries hydrate metrics in the same cycle; any later normalized known view/like change may persist once per UTC hour, and unchanged values force a refresh after 24 hours. Comment observations are durable in local Home state and cannot independently dirty this canonical key; the latest comment value may piggyback on a structural or allowed view/like write. |
| `channel:{id}:recent:posts` | Shared | Latest community post array, currently empty or one item. Post objects use canonical `id: "post:{postId}"`, preserve `publishedText`, include `fetchedAt`, `publishedAt`, and `publishedAtSource` when InnerTube relative age can be estimated, and may include optional `likeCount`/`likeText` or `viewCount`/`viewText` when those fields are exposed directly on the InnerTube post renderer. `likeCount: 0` is a real explicit value; null/missing means unknown or unavailable. | Written/read only when `TUBEPULSE_ENABLE_COMMUNITY_POSTS` is enabled; API/cron dead-channel cleanup deletes it even when disabled. Structural/new content changes persist immediately. Existing cached posts without a clock or known metric hydrate once. Otherwise rotating YouTube `sqp`/`rs` delivery parameters, relative-label churn backed by the same valid `publishedAt`, `fetchedAt` alone, and same-hour metric movement are no-ops. Any normalized known numeric change may persist once per UTC hour; every observation is forced fresh after 24 hours. Missing metrics are unknown, not zero. |
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

- **Canonical backend generation:** the API selects D1 only when `TUBEPULSE_CANONICAL_BACKEND=d1` and the configured generation matches the Durable Object replication state plus D1's active manifest. Mismatch is fail-closed; no automatic read/write fallback to legacy KV is allowed.
- **D1 atomic publication:** a multi-key journal is applied as one four-statement D1 `batch()` using a JSON delta set, content-hash guard rows, delete/put set operations, and guard cleanup. A failed guard aborts every mutation. Retrying an already-applied transaction is idempotent because the next hash is accepted.
- **D1 recovery snapshots:** recovery reads all visible canonical rows with one bounded set query rather than one query per key. SQL `NULL` expiration remains non-expiring when records are normalized; changing it to zero would incorrectly hide permanent rows.
- **D1 accounting:** the coordinator reserves three estimated rows per logical key mutation, with 45,000 scheduler / 50,000 total estimated-row caps and a 5,000 app reserve. Batching does not reduce billed rows. The schema uses `WITHOUT ROWID` primary keys and no secondary indexes.
- **Frozen KV rollback:** old pending KV deltas are cleared only after exact Home→D1 manifest verification and are archived as migration metadata. Retained scheduled Worker handlers require an explicit frozen-KV acknowledgement latch and still must not run until an operator has reconciled that snapshot after stopping Home.

- **Key builder drift:** narrowed and deployed for cron on 2026-06-25. API and cron both define `fcmLookup` and `firstPollAtPosts`; cron still has cron-only `prewarnSent`. Shared keys are still duplicated manually.
- **`cleanupDeadChannel` drift:** API and cron cleanup both remove the channel from `channels:active` and delete subscriber/display/post state. They deliberately retain `channel:{id}:known:videos`, so a later resubscribe does not replay old uploads.
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

- Do not change API and cron canonical keys independently without updating this contract.
- Do not reuse a D1 backend generation for different content or bypass exact manifest verification.
- Do not enable D1 read replication until all correctness-sensitive fallback reads use an explicit sequential-consistency session.
- Do not enable the frozen-KV rollback latch merely because Cron Triggers are available; stop Home and reconcile the target snapshot first.
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
