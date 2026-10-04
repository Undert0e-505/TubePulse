# TubePulse - Project Status

**Last updated:** 2026-10-04
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
| `tubepulse-api` | Production deployment `6df41e5a-6618-423a-a5a7-c9e75c74c0a7`, version `0af435b6-b642-4820-91e0-fa0692d6aff3`, serves the unchanged app URL. Every authenticated feed uses the unified Home store over VPC while current, with Cloudflare KV fallback. |
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
| RSS shard workers | `worker/tubepulse-rss-0/`, `worker/tubepulse-rss-1/`, `worker/tubepulse-rss-2/` | Rotating RSS polling and video notification fan-out |
| Posts worker | `worker/tubepulse-posts/` | Rotating community-post polling and notification fan-out |
| Aux worker | `worker/tubepulse-aux/` | Bounded nag/prewarn work and legacy upcoming-bucket drain |
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

- Video detection moved from the three rotating RSS shards to Home on 2026-10-04. Home now checks all 85 active channels once at every five-minute boundary; the first production sweep covered 85/85 in 3.4 seconds with no failure or retry. This replaces the former roughly 140-minute worst-case rotation. The retained RSS Worker deployments have no Cron Triggers.
- The unified Home authority is **production-active**. One `data-authority` runtime/store handles signed all-device mutation replication, five-minute all-channel video sweeps, hourly all-channel post sweeps, aux minute work, and all-device private-VPC feeds. Its exact signed seed contained 721 canonical records. It performs no periodic full pull, publishes changed keys only, and uses 650 scheduler/950 total daily write caps with deferred-key coalescing and a 300-write app reserve. The first live sweep applied 33 changed keys, left zero queued/conflicted/pending keys, and delivered one natural notification only after the public Home-backed feed visibility barrier passed. All 12 known profiles returned `200` from the Home route through the unchanged production API URL.
- The self-host preview is additive and local-only until an operator configures it. Current APK behavior and production Worker deployments are unchanged by the preview.
- The earlier single-device gateway/full-mirror experiment remains disabled. Its periodic full pull was replaced by the unified authority's one-time exact seed plus signed deltas; there is no canary selector in the production feed path.
- The optional `selfhost` APK is separately identified as TubePulse Preview and debug-signed. It gates normal initialization on a health-tested runtime Home URL, permits later changes from Settings, and never falls back to production. Its isolated Compose pilot uses a separate `data-pilot` mount and a fail-closed local-only profile that disables Cloudflare synchronization/writes. Its generated Firebase metadata is a build shim only; this pilot sends a null token until `com.tubepulse.app.selfhost` is registered as a distinct Firebase Android app and push is explicitly enabled.
- YouTube Data API usage is intended for handle/channel resolution and avatar/bootstrap fallback paths. Community-post cron polling uses the isolated InnerTube latest-post helper and remains inert unless the global community-post gate is enabled. When enabled, it polls active subscribed channels; a non-empty allowlist can narrow that set.
- API and all five active scheduled workers share the same KV namespace according to their wrangler configs.
- WebSub code remains present but should be treated as dormant unless live verification proves otherwise.
- KV schema and helper logic are duplicated between worker files and have known drift; see [worker/CONTRACTS.md](worker/CONTRACTS.md) before changing worker behavior.

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
