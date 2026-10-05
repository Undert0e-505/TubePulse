# TubePulse - Project Status

**Last updated:** 2026-10-05
**Current repo branch:** `master`
**Current app version in repo:** `3.5.2`
**Android versionCode/versionName in repo:** `352` / `3.5.2`
**Repo:** [Undert0e-505/TubePulse](https://github.com/Undert0e-505/TubePulse)
**Platform:** Android only (React Native + Expo)

This is the current source-of-truth status document for repo work. For detailed backend design, see [ARCHITECTURE.md](ARCHITECTURE.md), [worker/README.md](worker/README.md), and the active worker contract inventory in [worker/CONTRACTS.md](worker/CONTRACTS.md). For app release process and cleanup guidance, see [RELEASE.md](RELEASE.md). [MIGRATION_PLAN.md](MIGRATION_PLAN.md) and [PLAN_v3.1.md](PLAN_v3.1.md) are historical/planning records unless this file explicitly says otherwise.

---

## Current Repo State

Repo evidence as of this document update:

| Area | Current evidence |
|---|---|
| App version | `app.json` has `expo.version = 3.5.2` |
| Android version | `android/app/build.gradle` has `versionCode 352`, `versionName "3.5.2"` |
| API base URL | `src/utils/api.js` uses `EXPO_PUBLIC_TUBEPULSE_API_URL` when built with one and otherwise preserves `https://tubepulse-api.jimothyoakley55.workers.dev`; optional fallback is disabled unless separately configured |
| Release script | `build-and-release.ps1` is the current local release path |
| API worker config | `worker/tubepulse-api/wrangler.toml` defines worker `tubepulse-api`, KV namespace `52e77ca9f5f6493e89d2478c8d3055ec`, and VPC Service binding `TUBEPULSE_HOME_VPC`; the live `workers.dev` endpoint remains enabled without a committed custom route |
| Scheduled worker configs | Cron Trigger arrays are empty for RSS0/1/2, posts, aux, API, and the retired combined cron; one local Home authority now owns scheduled work |
| Self-host preview | `self-host/` runs the existing Worker sources with persistent local KV in standalone or mirror/standby mode; adding it did not deploy or change production Cloudflare resources |
| Side-by-side Preview APK | Android build type `selfhost` produces package `com.tubepulse.app.selfhost` / label `TubePulse Preview`, bundles JavaScript without Metro, requires a health-tested runtime Home URL, and permits LAN cleartext only in that test variant |
| Legacy resolver archive | `worker/archive/tubepulse-resolver/` preserves the old `tubepulse-resolver` source/config for reference only |

Live route verification on 2026-06-25 confirmed Cloudflare serves the app-facing API at `https://tubepulse-api.jimothyoakley55.workers.dev/`. Old notes claiming the `workers.dev` API route is unreachable are stale.

---

## Worker Deployment Status

The five active scheduled workers were restored and redeployed on 2026-09-01 after stale Cron Trigger records stopped dispatching. Current deployment IDs and post-deploy invocation evidence are recorded below.

| Worker | Deployment state |
|---|---|
| `tubepulse-rss-0` | Version `0bbca7b7-a476-4dd0-b437-06b7eb35c038`; deployment retained, Cron Triggers disabled at the Home cutover. |
| `tubepulse-rss-1` | Version `e87f1465-a4b1-4cd5-bb9b-22e92957d078`; deployment retained, Cron Triggers disabled at the Home cutover. |
| `tubepulse-rss-2` | Version `67f202ce-3f81-4cca-aa2e-0d22baed93dd`; deployment retained, Cron Triggers disabled at the Home cutover. |
| `tubepulse-posts` | Version `ed33187c-9c79-4fa7-b215-72194117feb6`; deployment retained, Cron Triggers disabled at the Home cutover. Home checks posts hourly. |
| `tubepulse-aux` | Version `ea9347cf-67db-4a49-a8d6-7bd671cedd08`; deployment retained, Cron Triggers disabled at the Home cutover. Home runs aux each minute. |
| `tubepulse-cron` | Retired no-op retained under its historical name with `crons = []`. |
| `tubepulse-api` | Production deployment `86965f82-97f1-42a6-8730-9c7dd13588ba`, version `35b661e9-d615-44b5-8d6a-26544a53fea8`, serves the unchanged app URL. Every authenticated feed uses the unified Home store over VPC while current, with Cloudflare KV fallback; authenticated mutations are Home-first with deferred KV backup. |
| `worker/archive/tubepulse-resolver` | Not deployed; archive remains reference-only. |

The checked-in app version is `3.5.2` with Android `versionCode 352`. Worker deployment is separate from app APK release; community-post rollout required both worker deployment and app release.

v3.3.1 is an app-only widget parity patch. It aligns the Android widget with HomeScreen feed selection so old community posts do not override newer videos in the widget.

Community-post worker/app support is enabled only when `TUBEPULSE_ENABLE_COMMUNITY_POSTS` is set to `1`, `true`, or `yes`. When enabled, cron polls active subscribed channels from `channels:active`. `TUBEPULSE_COMMUNITY_POST_CHANNEL_ALLOWLIST` is optional and narrows polling only when non-empty; missing or blank means all active channels are eligible. First-poll seeding remains silent to avoid old-post spam for newly added channels.

---
## Active Components

| Component | Path | Current role |
|---|---|---|
| React Native / Expo app | `App.js`, `src/`, `app.json` | Android app UI, FCM registration/handling, widget integration, local cache/settings |
| Native Android project | `android/` | Expo prebuild/native Android support, widget receiver/resources, release APK build target |
| Local Android test build | `android/app/src/selfhost/`, `scripts/Build-SelfHostApk.ps1` | Side-by-side debug-signed Preview APK with a health-tested, persisted runtime Home URL and no production fallback; does not mutate the main application ID or version |
| Release script | `build-and-release.ps1` | Windows-native local APK build/sign/copy, version bump, commit/push, GitHub release creation/upload |
| API worker | `worker/tubepulse-api/` | App-facing HTTP API worker in source: register, subscribe/unsubscribe, feed, resolve, bootstrap, settings, seen, dormant WebSub endpoints |
| RSS shard workers | `worker/tubepulse-rss-0/`, `worker/tubepulse-rss-1/`, `worker/tubepulse-rss-2/` | Triggerless rollback deployments; Home reuses the RSS processing code |
| Posts worker | `worker/tubepulse-posts/` | Triggerless rollback deployment; Home reuses the community-post poller hourly |
| Aux worker | `worker/tubepulse-aux/` | Triggerless rollback deployment; Home reuses bounded nag/prewarn work each minute |
| Retired cron stub | `worker/tubepulse-cron/index.js` | No-op compatibility deployment; shared helpers remain in `shared.mjs` |
| Legacy resolver archive | `worker/archive/tubepulse-resolver/` | Historical standalone resolver worker (`tubepulse-resolver`), superseded by `worker/tubepulse-api` `/resolve`; reference only |
| Self-host preview | `self-host/` | Local workerd-backed API/scheduler, persistent KV, conflict-detecting Cloudflare sync, admin controls, Docker/Windows helpers |

---

## Verified API Route State

Last verified: 2026-10-04.

The app-facing API route is currently reachable at:

`https://tubepulse-api.jimothyoakley55.workers.dev`

Safe read-only checks showed:

- `GET /` returned `200 OK` from Cloudflare with JSON body `{"status":"ok","version":"3.0.0","worker":"tubepulse-api","architecture":"channel-first"}`.
- `GET /__route_probe_readonly__` returned `404 Not Found` from Cloudflare, proving the hostname routes to a worker even for unknown paths.

Keep these version labels distinct:

- App/release version evidence in this repo is `3.5.2` with Android `versionCode 352`.
- API worker health response reports `version: "3.0.0"`; this appears to be a stale or independently versioned health label, not the app release version.

`worker/tubepulse-api/wrangler.toml` still has a comment saying "No HTTP routes" and no explicit `routes` or `workers_dev` setting. That comment/config is incomplete relative to live Cloudflare behavior. Do not change route/app config or delete worker files until the deployed Cloudflare settings are intentionally reviewed.

---

## Current Release Process

The current repo release path is `build-and-release.ps1`.

Summary behavior from the script:

1. Bump `app.json` and `android/app/build.gradle` to the requested version.
2. Run `npm install --no-audit --no-fund`.
3. Build Android release APK with `android\gradlew.bat assembleRelease --no-daemon`.
4. Sign the APK using `android/app/debug.keystore`.
5. Copy the APK to repo root as `TubePulse-vX.Y.Z.apk`.
6. For full releases, guard against untracked non-ignored files, then `git add -A`, commit, push current branch, create/update GitHub release through the GitHub API, and upload the APK.

`build-and-release.sh` is not the current release path in this repo.

Known risks and the intended safer target flow are documented in [RELEASE.md](RELEASE.md). App APK releases and Cloudflare Worker deployments are separate processes.

---

## Current Backend Summary

- Video detection moved from the three rotating RSS shards to Home on 2026-10-04, then from RSS to the YouTube Data API on 2026-10-05. Home now checks the complete active fleet with two batched `channels.list` requests at every five-minute boundary. The retained RSS Worker deployments have no Cron Triggers and are not an automatic fallback.
- The unified Home authority is **production-active**. One `data-authority` runtime/store handles signed all-device mutation replication, five-minute all-channel video sweeps, hourly all-channel post sweeps, aux minute work, and all-device private-VPC feeds. Its exact signed seed contained 721 canonical records. It performs no periodic full pull, publishes changed keys only, and uses 900 scheduler/950 total daily write caps with deferred-key coalescing and a 50-write app reserve. The first live sweep applied 33 changed keys, left zero queued/conflicted/pending keys, and delivered one natural notification only after the public Home-backed feed visibility barrier passed. All 12 known profiles returned `200` from the Home route through the unchanged production API URL.
- The self-host preview is additive and local-only until an operator configures it. Current APK behavior and production Worker deployments are unchanged by the preview.
- The earlier single-device gateway/full-mirror experiment remains disabled. Its periodic full pull was replaced by the unified authority's one-time exact seed plus signed deltas; there is no canary selector in the production feed path.
- The optional `selfhost` APK is separately identified as TubePulse Preview and debug-signed. It gates normal initialization on a health-tested runtime Home URL, permits later changes from Settings, and never falls back to production. Its isolated Compose pilot uses a separate `data-pilot` mount and a fail-closed local-only profile that disables Cloudflare synchronization/writes. Its generated Firebase metadata is a build shim only; this pilot sends a null token until `com.tubepulse.app.selfhost` is registered as a distinct Firebase Android app and push is explicitly enabled.
- YouTube Data API usage now owns active video discovery, uploads-playlist reconciliation, metadata, and engagement statistics as well as handle/avatar/bootstrap work. Statistics polling is restricted dynamically to the app-visible top three videos per channel; a deletion/private transition promotes the next cached item immediately without weakening the durable known-video watermark or replaying a notification. Community-post polling continues to use the isolated InnerTube helper.
- Community-post structural changes remain immediate, while observation-only `fetchedAt`, relative-age labels, rotating thumbnail signatures, and sub-threshold engagement movement do not rewrite the canonical cache. Missing observations hydrate once; a strictly greater-than-25% metric change may persist at most once per UTC hour, with a forced refresh after 24 hours.
- The active upload path no longer rewrites channel metadata solely to advance compatibility field `lastVideoId`. When the final subscriber removes a channel, the channel leaves `channels:active` and polling stops; display/subscriber state is cleaned through the bounded backup path while the known-video watermark remains for safe resubscription.
- The current app-facing Worker deployment is version `fa626e36-e02d-4532-98e6-eb83ba6c22b3`. Deployment credentials remain outside the repository.
- API and all five active scheduled workers share the same KV namespace according to their wrangler configs.
- WebSub code remains present but should be treated as dormant unless live verification proves otherwise.
- KV schema and helper logic are duplicated between worker files and have known drift; see [worker/CONTRACTS.md](worker/CONTRACTS.md) before changing worker behavior.

### 2026-10-05 YouTube RSS 404 incident (historical; superseded by Data API cutover)

Home's five-minute RSS sweeps began receiving generic `404 Not Found` responses from the `YouTube RSS Feeds server`. This is an active operational incident, not evidence that a channel ID is invalid:

- The Home host and the Home container returned the same generic 404 for known-valid official YouTube channel feeds. At the same time, an independent external request to the identical official feed reached an XML response.
- Home completed full-fleet sweeps successfully before failures appeared progressively and eventually affected every channel.
- Without a process restart or configuration change, Home recovered to complete success for several cycles. Failures then returned progressively and again affected the complete fleet.
- The retired RSS baseline made one feed request per active channel per five-minute sweep. Retries were concentrated inside the sweep and multiplied a complete-failure burst.
- The failure was already complete before the later `/seen` API deployment, and the scheduler/request-construction files were unchanged by that deployment.

The timing, independent external success, identical host/container result, and spontaneous recovery make YouTube edge throttling or anti-abuse treatment of the Home public IP the leading explanation. That is an inference, not a confirmed formal rate limit: YouTube returned 404, not 429, and the response contained no rate-limit reason. Treat this separately from Cloudflare quota handling and the `/seen` persistence repair. Avoid multiplying retries while this condition persists; confirm recovery with known-valid feeds and a complete sweep before declaring polling healthy.

### Production RSS resilience rollout (historical intermediate state)

The tested mitigation was deployed on 2026-10-05 in the required order: the signed API probe first as Worker version `35b661e9-d615-44b5-8d6a-26544a53fea8`, then the unified Home service using its existing persistent `data-authority` store. The replacement honored the previous scheduler lease until its TTL expired rather than bypassing it, then started healthy at `04:22:44Z` with authority replication still `current`.

- Each aligned five-minute epoch got a deterministic pseudo-random unique channel order split into five balanced cohorts. One cohort ran per minute, sequentially, with one bounded attempt per channel and no immediate 404 retry. This spread the retired RSS workload instead of concentrating the full fleet and retries at a boundary.
- No small sample can declare RSS unavailable. The circuit requires every unique active channel to have been attempted once in the same complete staggered cycle and every result to fail in the same class. Partial/mixed failure remains normal `rss` mode.
- A signed, replay-protected `tubepulse-api` authority route independently checks a fixed known-valid feed and at most one strict active channel from Cloudflare egress. It cannot proxy a caller URL, returns only bounded status/XML classification, and performs no KV access. Remote success classifies `home-egress-throttled`; remote uncertainty classifies `rss-probe-inconclusive`; neither permits Data API fallback.
- Only matching full-fleet Home failure plus independent Cloudflare failure can enter `rss-global-down-api-fallback`. With a configured key, Home derives `UU…` uploads playlists and uses `playlistItems.list` at no more than two channels/minute. It never uses `search.list`, shares the existing known/high-watermark path, silently seeds missing state, and automatically lengthens its nominal one-hour coverage to remain below the combined configured quota after posts projection and reserve.
- Circuit/quota state survives restart. Home probes back off 15, then 30, capped at 60 minutes; two consecutive valid Home feeds are required to return through `rss-recovering` to `rss`. Fallback quota accounting follows the DST-aware `America/Los_Angeles` Google quota day. Source outages preserve last-good cache, `/seen`, feeds, posts, aux, notifications already represented in state, and Home authority `current` status.
- Redacted status includes source mode, circuit reason/times, independent classifications, request/attempt/skipped counters, last-good RSS/API timestamps, fallback requests/failures/quota/cap/reset, and calculated coverage interval without channel/device identities.

The first complete production cycle covered the unique active fleet exactly once, sequentially at concurrency one, with zero retries. Every Home request returned the same `http-404` class. Only after the final cohort completed did the circuit open. Both bounded Cloudflare-egress classifications were `network`, so the independent result was inconclusive; the scheduler correctly entered `rss-probe-inconclusive`, retained stale cache, scheduled a bounded Home probe, and made zero Data API fallback requests despite its configured key. The next tick stayed in backoff, ran aux successfully, made no RSS/API request, and left authority `current` with no lease or scheduler error. Public Home-backed feed and no-op `/seen` canaries returned `200` with unchanged state. No notification was produced, the coordinator retained zero pending backup keys, and coordinated KV writes increased by only one across rollout observation. All legacy Cron Trigger lists remained empty.

### Production YouTube Data API cutover

The unified Home authority switched to `youtube-api` mode on 2026-10-05. Active mode requires a Home API-key secret and cannot automatically fall back to RSS. Every aligned five-minute cycle batches channel IDs in groups of 50, compares public `videoCount`, reconciles only changed/missing/safety-due uploads playlists, and polls engagement metrics in 50-video batches. `search.list` is not used. General/statistics quota state is persisted and reset at DST-aware Pacific midnight.

The initial deployment exposed a migration defect: detector counts were captured before all established playlists had been reconciled, and the running image used the steady-state reconciliation cap. `@ForbesBreakingNews` therefore remained at a stale cached upload while the live playlist had newer videos. The corrected migration path uses a separate bounded initialization cap and requires `lastReconciledAt` for every channel; its catch-up cycle reconciled every remaining channel, recovered the missing Forbes uploads, and left the complete fleet initialized with zero deferred. Subsequent steady-state cycles use two detector calls, reconcile only due channels, and batch statistics separately.

Production verification returned `200` with `X-TubePulse-Authority-Route: home` for both the public feed and a no-op `/seen`. The public Forbes feed led with the 08:00:31Z video and contained its thumbnail, view, like, and comment counts. The four-video notification crossed the public-feed visibility barrier and was delivered once. At verification time the persisted quota totals were 183 general units and 46 statistics units, with zero API failures.

The later write-efficiency deployment pruned metric scheduling state to the dynamic visible top three per channel. The first cycle hydrated newly eligible second/third items; the next adaptive cycle checked fewer videos in three batched statistics requests while the detector still used two requests with zero failures. The first live hourly post pass was intentionally not treated as steady state: its 52 backup writes included four real new posts, a silent first seed, missing-clock hydration, valid engagement changes, and video metric updates. A deterministic integration test proves an eligible post poll containing only sub-threshold metrics/observation metadata produces zero KV puts. One channel continues to exceed the existing 2 MiB InnerTube response ceiling; that pre-existing parser limit is recorded for follow-up rather than hidden as a successful poll.

At the last reliable observation after the 11:00Z pass on 2026-10-05, the signed coordinator was current with no pending backup keys and reported 745 total coordinated operations: 739 scheduler publication and 6 API. The limits were 950 total, 900 scheduler publication, and a 50-operation app reserve, resetting at 00:00Z. These are timestamped same-day observations, not a measured normal daily rate; a full-day observation is still required.

---

## Documentation Authority

Use these docs this way:

| Document | Status |
|---|---|
| `STATUS.md` | Current repo status and operational caveats |
| `README.md` | Product overview, project map, common commands |
| `RELEASE.md` | Current app release process, risks, and target cleanup flow |
| `ARCHITECTURE.md` | Architecture reference; may still contain historical diagrams/sections |
| `worker/README.md` | Backend/worker reference; route claims require live verification where noted |
| `self-host/README.md` | Preview standalone/mirror setup, sync safety, takeover, backups and recovery |
| `MIGRATION_PLAN.md` | Historical migration record |
| `PLAN_v3.1.md` | Historical v3.1 planning/release record |

---

## Remaining Documentation Concerns

- `worker/tubepulse-api/wrangler.toml` still contains a stale/incomplete route comment; live `workers.dev` route is verified reachable, but the repo config does not explain why.
- Several older docs still contain historical v3.1/v3.0 detail that may be useful but should not override this status document.
- Some markdown files contain encoding artifacts in old prose/diagrams. This pass did not rewrite all historical content.
