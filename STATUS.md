# TubePulse - Project Status

**Last updated:** 2026-10-06
**Current repo branch:** `master`
**Current app version in repo:** `4.0.0`
**Android versionCode/versionName in repo:** `400` / `4.0.0`
**Repo:** [Undert0e-505/TubePulse](https://github.com/Undert0e-505/TubePulse)
**Platform:** Android only (React Native + Expo)

This is the current source-of-truth status document for repo work. For detailed backend design, see [ARCHITECTURE.md](ARCHITECTURE.md), [worker/README.md](worker/README.md), and the active worker contract inventory in [worker/CONTRACTS.md](worker/CONTRACTS.md). For app release process and cleanup guidance, see [RELEASE.md](RELEASE.md). [MIGRATION_PLAN.md](MIGRATION_PLAN.md) and [PLAN_v3.1.md](PLAN_v3.1.md) are historical/planning records unless this file explicitly says otherwise.

---

## Current Repo State

Repo evidence as of this document update:

| Area | Current evidence |
|---|---|
| App version | `app.json` has `expo.version = 4.0.0` |
| Android version | `android/app/build.gradle` has `versionCode 400`, `versionName "4.0.0"` |
| API base URL | `src/utils/api.js` uses `EXPO_PUBLIC_TUBEPULSE_API_URL` when built with one and otherwise preserves `https://tubepulse-api.jimothyoakley55.workers.dev`; optional fallback is disabled unless separately configured |
| Release script | `build-and-release.ps1` is the current local release path |
| API worker config | `worker/tubepulse-api/wrangler.toml` defines worker `tubepulse-api`, active D1 binding/generation, Durable Object coordinator, VPC Service binding `TUBEPULSE_HOME_VPC`, and frozen legacy KV binding; the live `workers.dev` endpoint remains enabled without a committed custom route |
| Scheduled worker configs | Cron Trigger arrays are empty for RSS0/1/2, posts, aux, API, and the retired combined cron; one local Home authority now owns scheduled work |
| Home runtime and preview | `self-host/` contains the production unified Home authority plus isolated standalone/mirror preview tooling; production uses its persistent `data-authority` store and D1 coordinator path |
| Side-by-side Preview APK | Android build type `selfhost` produces package `com.tubepulse.app.selfhost` / label `TubePulse Preview`, bundles JavaScript without Metro, requires a health-tested runtime Home URL, and permits LAN cleartext only in that test variant |
| Legacy resolver archive | `worker/archive/tubepulse-resolver/` preserves the old `tubepulse-resolver` source/config for reference only |

Live verification after the 2026-10-05 D1 cutover confirmed Cloudflare still serves the app-facing API at the unchanged `workers.dev` URL and routes current authenticated feeds through Home while it is healthy.

The repository also contains an aggregate-only localhost operations stack under `monitoring/`. It provisions Prometheus and Grafana, stores bounded ignored history under `logs/`, and uses only a read-only Account Analytics token. Its host endpoint and Cloudflare collector expose service/count distributions without installation/channel identifiers or content. Startup is best-effort after authority readiness and cannot block or restart the production authority. See [`monitoring/README.md`](monitoring/README.md).

The stack was activated locally on 2026-10-06. Live validation proved a successful real aggregate host/Cloudflare sample, an up Prometheus target, provisioned Grafana datasource/dashboard, safe listener defaults, privacy-safe generated snapshots, and monitoring-only restart recovery without replacing or interrupting the authority container. Historical monitoring begins at activation; it is not reconstructed from Cloudflare.

Same-LAN anonymous Viewer access is enabled for Grafana on the production host through ignored host configuration plus a Windows Firewall rule restricted to the active physical interface, the Private profile, `LocalSubnet`, and TCP port 3000. Prometheus, the collector, and authority status remain loopback-only. The tracked default for a fresh clone is still loopback-only; [`monitoring/README.md`](monitoring/README.md) documents inspection, DHCP/address caveats, and removal.

---

## Worker Deployment Status

The scheduled Worker deployments below are retained rollback/history assets. Their Cron Triggers are disabled; current scheduling belongs exclusively to Home. Historical deployment IDs are recorded for provenance, not as activation instructions.

| Worker | Deployment state |
|---|---|
| `tubepulse-rss-0` | Version `0bbca7b7-a476-4dd0-b437-06b7eb35c038`; deployment retained, Cron Triggers disabled at the Home cutover. |
| `tubepulse-rss-1` | Version `e87f1465-a4b1-4cd5-bb9b-22e92957d078`; deployment retained, Cron Triggers disabled at the Home cutover. |
| `tubepulse-rss-2` | Version `67f202ce-3f81-4cca-aa2e-0d22baed93dd`; deployment retained, Cron Triggers disabled at the Home cutover. |
| `tubepulse-posts` | Version `ed33187c-9c79-4fa7-b215-72194117feb6`; deployment retained, Cron Triggers disabled at the Home cutover. Home checks posts hourly. |
| `tubepulse-aux` | Version `ea9347cf-67db-4a49-a8d6-7bd671cedd08`; deployment retained, Cron Triggers disabled at the Home cutover. Home runs aux each minute. |
| `tubepulse-cron` | Retired no-op retained under its historical name with `crons = []`. |
| `tubepulse-api` | Serves the unchanged app URL. Every authenticated feed uses the unified Home store over VPC while current, with D1 fallback; authenticated mutations are Home-first with deferred atomic D1 backup. See the production D1 cutover section for the currently verified deployment. |
| `worker/archive/tubepulse-resolver` | Not deployed; archive remains reference-only. |

The checked-in app version is `4.0.0` with Android `versionCode 400`. Worker deployment is separate from app APK release; this release does not imply a Worker deployment.

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
| RSS shard workers | `worker/tubepulse-rss-0/`, `worker/tubepulse-rss-1/`, `worker/tubepulse-rss-2/` | Triggerless rollback deployments; Home reuses shared watermark/notification helpers but does not fetch RSS |
| Posts worker | `worker/tubepulse-posts/` | Triggerless rollback deployment; Home reuses the community-post poller hourly |
| Aux worker | `worker/tubepulse-aux/` | Triggerless rollback deployment; Home reuses bounded nag/prewarn work each minute |
| Retired cron stub | `worker/tubepulse-cron/index.js` | No-op compatibility deployment; shared helpers remain in `shared.mjs` |
| Legacy resolver archive | `worker/archive/tubepulse-resolver/` | Historical standalone resolver worker (`tubepulse-resolver`), superseded by `worker/tubepulse-api` `/resolve`; reference only |
| Home runtime and preview | `self-host/` | Production unified authority plus isolated preview modes, persistent local key/value storage, D1 reconciliation, admin controls, and Docker/Windows helpers |

---

## Verified API Route State

Last verified: 2026-10-05 after the D1 canonical cutover.

The app-facing API route is currently reachable at:

`https://tubepulse-api.jimothyoakley55.workers.dev`

Safe read-only checks showed:

- `GET /` returned `200 OK` from Cloudflare with JSON body `{"status":"ok","version":"3.0.0","worker":"tubepulse-api","architecture":"channel-first"}`.
- `GET /__route_probe_readonly__` returned `404 Not Found` from Cloudflare, proving the hostname routes to a worker even for unknown paths.

Keep these version labels distinct:

- App/release version evidence in this repo is `4.0.0` with Android `versionCode 400`.
- API worker health response reports `version: "3.0.0"`; this appears to be a stale or independently versioned health label, not the app release version.

`worker/tubepulse-api/wrangler.toml` intentionally commits no custom route. The live `workers.dev` endpoint remains enabled and unchanged; route ownership is separate from the app release version.

---

## Current Release Process

The current repo release path is `build-and-release.ps1`.

Summary behavior from the script:

1. Bump `app.json` and `android/app/build.gradle` to the requested version.
2. Run `npm install --no-audit --no-fund`.
3. Build Android release APK with `android\gradlew.bat assembleRelease --no-daemon`.
4. Sign the APK using `android/app/debug.keystore`.
5. Copy the APK to ignored `dist/TubePulse-vX.Y.Z.apk`.
6. For full releases, reject unexpected worktree content, stage only `app.json` and `android/app/build.gradle`, commit, push the current branch, create/update the GitHub release through the GitHub API, and upload the verified APK.

`build-and-release.sh` is not the current release path in this repo.

Known risks and the intended safer target flow are documented in [RELEASE.md](RELEASE.md). App APK releases and Cloudflare Worker deployments are separate processes.

---

## Current Backend Summary

- Video detection moved from the three rotating RSS shards to Home on 2026-10-04, then from RSS to the YouTube Data API on 2026-10-05. Home now checks the complete active fleet with two batched `channels.list` requests at every five-minute boundary. The retained RSS Worker deployments have no Cron Triggers and are not an automatic fallback.
- The unified host authority is **production-active**. One `data-authority` runtime/store handles signed all-device mutation replication, five-minute all-channel video sweeps, hourly all-channel post sweeps, aux minute work, and all-device private-VPC feeds. It performs no periodic full pull and publishes changed keys only. The D1 coordinator reserves three estimated rows per logical mutation and enforces 45,000 scheduler / 50,000 total estimated rows per UTC day, leaving a 5,000-row app reserve. Notification delivery still requires the public host-backed feed visibility barrier. One-off pushes retain durable at-most-once recovery; reminder nags are transient, rebuilt from the current app-visible feed and processed through a restart-safe rotating `nag:active` batch.
- The self-host preview is additive and local-only until an operator configures it. Current APK behavior and production Worker deployments are unchanged by the preview.
- The earlier single-device gateway/full-mirror experiment remains disabled. Its periodic full pull was replaced by the unified authority's one-time exact seed plus signed deltas; there is no canary selector in the production feed path.
- The optional `selfhost` APK is separately identified as TubePulse Preview and debug-signed. It gates normal initialization on a health-tested runtime Home URL, permits later changes from Settings, and never falls back to production. Its isolated Compose pilot uses a separate `data-pilot` mount and a fail-closed local-only profile that disables Cloudflare synchronization/writes. Its generated Firebase metadata is a build shim only; this pilot sends a null token until `com.tubepulse.app.selfhost` is registered as a distinct Firebase Android app and push is explicitly enabled.
- YouTube Data API usage now owns active video discovery, uploads-playlist reconciliation, metadata, and engagement statistics as well as handle/avatar/bootstrap work. Statistics polling is restricted dynamically to the app-visible top three videos per channel; a deletion/private transition promotes the next cached item immediately without weakening the durable known-video watermark or replaying a notification. Comment counts remain requested and are persisted only as local Home observations unless they can piggyback on a canonical write already required for structure or an allowed view/like update; comment-only movement publishes nothing. Community-post polling continues to use the isolated InnerTube helper.
- Community-post structural changes remain immediate, while observation-only `fetchedAt`, relative-age labels, rotating thumbnail signatures, and same-hour engagement movement do not rewrite the canonical cache. Missing observations hydrate once; any normalized known metric change may persist at most once per UTC hour, with a forced refresh after 24 hours.
- The active upload path no longer rewrites channel metadata solely to advance compatibility field `lastVideoId`. When the final subscriber removes a channel, the channel leaves `channels:active` and polling stops; display/subscriber state is cleaned through the bounded backup path while the known-video watermark remains for safe resubscription.
- The app-facing Worker retains the unchanged public URL. Deployment credentials remain outside the repository.
- The API Worker uses D1 as its active canonical backup/fallback. The old KV binding is frozen; all retained scheduled Workers are triggerless and fail closed unless an explicit stale-snapshot rollback latch is enabled after reconciliation.
- WebSub code remains present but should be treated as dormant unless live verification proves otherwise.
- The logical key/value schema and some helper logic are duplicated between worker files and have known drift; see [worker/CONTRACTS.md](worker/CONTRACTS.md) before changing worker behavior.

### 2026-10-05 YouTube RSS 404 incident (historical; superseded by Data API cutover)

Home's former five-minute RSS sweeps began receiving generic `404 Not Found` responses from the `YouTube RSS Feeds server`. This was an operational incident in the superseded RSS path, not evidence that a channel ID was invalid:

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

The later write-efficiency deployment pruned metric scheduling state to the dynamic visible top three per channel. The first cycle hydrated newly eligible second/third items; the next adaptive cycle checked fewer videos in three batched statistics requests while the detector still used two requests with zero failures. The first live hourly post pass was intentionally not treated as steady state: its backup writes included real new posts, a silent first seed, missing-clock hydration, valid engagement changes, and video metric updates. Under the then-active percentage policy, a deterministic integration test proved a post poll containing only sub-threshold metrics/observation metadata produced zero puts. The current policy instead permits any known metric change in a new UTC hour while preserving same-hour no-op behavior. A pre-existing oversized InnerTube response continues to exceed the 2 MiB parser ceiling; that limit is recorded for follow-up rather than hidden as a successful poll.

Historical pre-D1 observation: after the 11:00Z pass on 2026-10-05, the KV-era coordinator was current with no pending backup keys and remained below its then-active operation caps. Those values are not current D1 limits or a measured normal daily rate.

### Production D1 canonical cutover

On 2026-10-05 the active cloud canonical backup/fallback moved from Workers KV to the `tubepulse-canonical` D1 database without changing the public Worker URL. Worker version `dab5d125-abfb-46fb-aa47-f38062a28d31` selects backend generation `production-v1`. Home was stopped and drained, its exact current canonical snapshot was staged in bounded chunks, and D1 was activated only after the staged manifest matched exactly. The Durable Object then rebuilt its hash baselines and archived/cleared the obsolete KV pending queue. Home restarted on the same persistent `data-authority` store.

The old KV namespace is now a frozen point-in-time snapshot: it is not read, written, or selected automatically. Retained scheduled Workers have no Cron Triggers and their scheduled handlers additionally require an explicit frozen-KV acknowledgement latch. Safe rollback after D1 advances requires a new quiesced exact reconciliation; enabling the latch alone is unsafe.

The D1 coordinator uses one atomic four-query `batch()` for a complete logical transaction, with content-hash guard rows preventing partial or stale-baseline commits. It estimates three rows written per logical mutation and enforces 45,000 scheduler / 50,000 total estimated rows per UTC day, leaving 5,000 rows for app mutations. Seed/retry row work is included in the exposed daily counter. D1 batching reduces round trips but not billed rows, and read replication remains disabled.

Restart validation exposed and corrected a recovery-only query-shape defect: D1 canonical snapshots now read visible rows in one bounded set query instead of issuing one query per key, and SQL `NULL` expiration remains non-expiring rather than becoming zero. Home completed an exact automatic reconciliation after the fix; the coordinator returned to current with no transaction or pending backup.

### 2026-10-05 production resilience and recovery tooling

Core application recovery exists: the authority Compose stack uses `restart: unless-stopped`, a 45-second shutdown grace period, persistent `data-authority` storage, a reconnecting tunnel, and an HTTP/service-identity health check. That health check is liveness-only: Docker can report healthy while authority is stale/not ready or scheduler progress is stuck. If an unclean-stop lease expires and Home becomes stale, startup can restore the exact canonical state from the active D1 generation plus the Durable Object journal. A live status audit has demonstrated automatic stale-authority reconciliation. Feed reads fall back to D1 during Home/tunnel failure; ordered authenticated mutations fail closed. Frozen Workers KV is never a cloud recovery source.

The repository now includes a bounded Windows authority startup supervisor plus a non-administrator per-user Startup installer. The production auto-login profile has the verified shortcut installed. A safe live invocation completed with local authority ready/current, the signed D1 coordinator ready/current with no pending transaction, scheduler progress fresh, and the already-healthy container identity/start time unchanged. The supervisor starts Docker Desktop minimized when needed, waits for `docker info`, applies the authority Compose stack, and distinguishes liveness, readiness, pending/transaction faults, dependency outage, and progress. A real sign-out/reboot test remains outstanding. The optional elevated Scheduled Task path encountered a cross-account UAC ACL trap; an administrator may later remove a possibly retained task, while the supervisor lock makes duplicate launch harmless.

The production Home image was rebuilt from the release worktree containing the authority conflict-recovery changes documented below. The public Worker remains a separately versioned deployment and is not redeployed by an Android release. Recovery must verify the Home image/source marker and Cloudflare deployment record independently rather than assuming every component runs the newest `master`.

Startup currently reconciles only when local or coordinator status is stale; two `current` markers skip a full manifest proof. Recovery now drains verified pending coordinator deltas through a signed, hash-guarded API lease before requesting the exact D1 snapshot, and publication/snapshot lease conflicts use bounded retry. It never clears unverified pending state. Host JSON still lacks fsynced checksummed generations. The runbook documents a zero-local-backup reconstruction from GitHub, active D1/DO state, and existing cloud projects, including mandatory secret rotation, exact manifest reconcile, conservative YouTube quota wait, notification-intent ambiguity, and activation gates. This is a manual disk-replacement procedure, not automatic failover. See [`self-host/RECOVERY.md`](self-host/RECOVERY.md).

### 2026-10-06 power-loss tunnel ordering recovery

A real power-loss recovery brought Docker, the authority, tunnel, monitoring, and scheduler processes back, but authenticated public feeds remained on D1 fallback. Docker had resumed the existing authority and tunnel containers concurrently; Compose `depends_on` ordering is not replayed by daemon restart, and the later idempotent `compose up` did not recreate the already-running connector. Restarting only `cloudflared` after local and signed coordinator readiness restored the public `home` route while preserving the authority container and durable notification intents.

The Windows supervisor now persists the OS boot identity and performs one bounded tunnel-sidecar restart per boot only after authority/D1/scheduler readiness succeeds. It waits for connector registration, revalidates authority state, and skips the restart on ordinary same-boot invocations. The notification visibility barrier remains the end-to-end route proof; connector registration alone is not treated as authenticated feed evidence. The next power recovery is the remaining full boot-path confirmation.

### 2026-10-05 authority lease-race recovery

A legitimate Home-primary app mutation queued one verified canonical delta while an aligned scheduler publication was changing from its local polling lease to the global coordinator lease. The scheduler's first global acquire received a transient busy response after it had released the local lease. The old error path conservatively marked local authority stale, then its automatic snapshot recovery was correctly rejected because the verified pending delta had not yet reached D1. Reads continued through canonical fallback while authenticated mutations failed closed.

Recovery stopped only the Home service, allowed the local lease TTL to expire, applied the exact pending delta through the signed coordinator drain, reconciled the D1 manifest into the preserved local store, and restarted the rebuilt Home image. The coordinator returned current and idle with no pending transaction. The fix retries transient acquire conflicts and drains a verified pending journal before snapshot recovery, preventing the same stale/pending deadlock without weakening ordering or deleting state.

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
| `self-host/RECOVERY.md` | Windows startup supervisor plus zero-local-backup unified-authority recovery runbook |
| `MIGRATION_PLAN.md` | Historical migration record |
| `PLAN_v3.1.md` | Historical v3.1 planning/release record |

---

## Remaining Documentation Concerns

- `worker/tubepulse-api/wrangler.toml` still contains a stale/incomplete route comment; live `workers.dev` route is verified reachable, but the repo config does not explain why.
- Several older docs still contain historical v3.1/v3.0 detail that may be useful but should not override this status document.
- Some markdown files contain encoding artifacts in old prose/diagrams. This pass did not rewrite all historical content.
