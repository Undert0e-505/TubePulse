# TubePulse self-hosting and Home authority

> **Preview status:** the standalone/Preview package is functional and tested, but not yet a production support promise. The maintainer's production installation separately runs the guarded unified Home authority documented below. The normal Android app still uses the existing `workers.dev` API; the separate Preview app requires an explicitly tested self-host URL and never falls back to production Cloudflare.

This directory runs the existing TubePulse API and five scheduled Worker entrypoints on an always-connected machine. It uses Miniflare's workerd-backed runtime and one persistent local `TUBEPULSE_KV` namespace; it does not copy or fork the large API Worker.

Miniflare is Cloudflare's local development and testing harness. It is useful for this preview because it executes the same Worker modules and bindings, but it is not marketed as a general-purpose production host. The launcher isolates runtime access behind `src/runtime.mjs` so a future direct-workerd adapter can replace it.

## Supported modes

### Standalone

Local KV is authoritative. The API listener and all schedulers start at boot.

```text
Android app ──HTTP──> self-host listener ──> existing API Worker
                              │
                              ├── hourly posts + minute aux work
                              ├── every five minutes: two batched Data API channel detectors
                              └── persistent local TUBEPULSE_KV
```

A new channel is populated synchronously through `channels.list` and its uploads `playlistItems.list`. Counts that YouTube hides or omits remain unknown and are not displayed as zero. The unified production Home scheduler batches up to 50 channel or video IDs per request and retains the durable known-video watermark, so established channels do not silently reset during migration.

### Cloudflare mirror and failover

The local service starts on standby. Pull synchronization creates a key-level baseline and updates only locally clean keys. Schedulers remain stopped until an authenticated admin takeover or an explicitly enabled, baseline-gated client failover signal.

```text
Cloudflare KV ──explicit/periodic pull──> local KV + sync baseline
      ▲                                      │
      └── push dry-run / explicit apply ─────┘

Android app ──primary──> Cloudflare API
      └── one retry on 429/502/503/504/network failure
                         └──> self-host API ──sticky takeover (opt-in)
```

Takeover is sticky across service restarts. There is deliberately no automatic failback. Return to standby only after checking synchronization and issuing the authenticated standby operation.

### Existing-app canary gateway

The former single-device gateway experiment is retained for history/tests but is disabled. Production now uses `compose.authority.yaml`: the unchanged app still calls its existing `workers.dev` URL, while every authenticated `GET /feed` and all seven authenticated app mutations use one unified Home store through Workers VPC when replication is current. Cloudflare D1 is the coordinated changed-key backup/fallback, not a periodically mirrored second writer. The old Workers KV namespace is a frozen snapshot and is never selected automatically.

In that historical canary phase, Cloudflare remained authoritative: a successful mutation ran on Cloudflare first and then replicated to Home. That behavior is not the current production mutation path.

Home requests use HMAC-SHA256 over timestamp, request ID, operation, method, path/query, an authorization-header digest, and body digest. Home enforces a short clock window, rechecks the bearer against the configured canary fingerprint, and rejects a request ID replay within the running process. Only the gateway readiness endpoint, `GET /feed`, and the seven existing app mutations are allowed. Health, WebSub, resolver, admin/internal, and arbitrary paths cannot be tunneled through this origin surface. Enabling the gateway-origin role also closes the listener's ordinary app API paths; only signed gateway, status, and authenticated admin surfaces remain. The original bearer is forwarded only inside the authenticated origin request; gateway logs contain route outcomes and latency, not bearer values, authorization headers, FCM tokens, or fingerprints.

This is not a QR enrollment flow and needs no APK or endpoint change. Public origins require HTTPS outside explicit private/local tests. The selected private deployment instead uses a Workers VPC fetcher binding through Cloudflare Tunnel, with no public hostname or inbound port; HMAC remains mandatory at the origin. Replay memory resets with the Home process (timestamps bound that window), and mirror freshness remains limited by successful pull cadence. Temporary Home unavailability, readiness/authentication failure, timeout, `429`, retryable `5xx`, or an incompatible reply transparently falls back to Cloudflare. A valid, current Home `4xx` app error is returned as the app error instead of being hidden by a second execution on Cloudflare.

There is no distributed transaction across Cloudflare and Home. In particular, if Cloudflare refuses a write, instantaneous two-sided consistency is impossible. The canary deliberately does **not** accept a Home-only mutation: the canonical Cloudflare error is returned and Home is not called.

### Historical single-device Workers VPC canary

[`WORKERS-VPC.md`](WORKERS-VPC.md) records the retired single-device mirror/canary procedure. Do not use its mirror pull or Cloudflare-first mutation flow as production instructions. Current production uses `compose.authority.yaml`, the same private VPC target, one authoritative `data-authority` store, and D1 changed-key backup; it does not run the old periodic full mirror. The isolated Preview pilot and `data-pilot` remain separate.

## Five-minute Node quick start

Prerequisites: Node.js 20 or newer, npm, and a supported workerd platform.

```powershell
cd self-host
Copy-Item .env.example .env
npm install
npm test
npm start
```

Generate a long random `TUBEPULSE_ADMIN_TOKEN` and place it in `.env` (or use the `_FILE` setting). The listener defaults to `127.0.0.1:8788`. Verify both health surfaces:

```powershell
Invoke-RestMethod http://127.0.0.1:8788/
Invoke-RestMethod http://127.0.0.1:8788/_tubepulse/status
```

The first endpoint is the unchanged API Worker health contract. The second reports the self-host mode, readiness, scheduler state and per-job outcomes, sync timestamps, pending/conflict counts, and non-secret configuration warnings.

For actual notifications, configure `FIREBASE_SERVICE_ACCOUNT_FILE`. Active video discovery, structural bootstrap, metrics, and handle resolution require `YOUTUBE_API_KEY` or `YOUTUBE_API_KEY_FILE`. Missing credentials are visible as health warnings; empty state remains safe and does not call YouTube or FCM.

## Docker

From this directory:

```bash
cp .env.example .env
mkdir -p data secrets
docker compose up --build -d
docker compose ps
```

Compose publishes only `127.0.0.1:8788` by default, even though the process must listen on `0.0.0.0` inside its container. Persistent data is bind-mounted from `./data`. Secret files can be placed in the ignored `./secrets` directory and referenced inside `.env`, for example:

```dotenv
FIREBASE_SERVICE_ACCOUNT_FILE=/run/secrets/tubepulse/firebase.json
YOUTUBE_API_KEY_FILE=/run/secrets/tubepulse/youtube-api-key.txt
CLOUDFLARE_API_TOKEN_FILE=/run/secrets/tubepulse/cloudflare-token.txt
```

Back up `data` before rebuilding or upgrading. The image contains the existing `worker/` source at build time, so rebuild it after changing Worker code.

The image installs the standard Debian CA bundle and points workerd at it with `SSL_CERT_FILE`. If local logs report `TLS peer's certificate is not trusted`, rebuild the image before investigating upstream YouTube or Firebase availability.

On Windows, install Docker Desktop from an elevated terminal, launch it, accept its terms, and wait for the WSL 2 engine to become ready:

```powershell
winget install --id Docker.DockerDesktop --exact --accept-package-agreements --accept-source-agreements
docker version
docker compose version
docker run --rm hello-world
```

Do not reboot an unattended host merely because the installer asks; arrange a maintenance window if Windows says one is required.

For an intentional LAN-host test, the repository also provides an administrator helper. It verifies and directly runs a Docker Inc-signed installer from the local winget cache when available (including a cache populated by the non-administrator account that launched it), otherwise falls back to `winget`, then adds only the Private-profile, `LocalSubnet`, TCP 8788 firewall rule. It rejects an untrusted cached executable and appends non-secret diagnostics to ignored `self-host/data/docker-host-install.log`. Review it before running it from the repository root; it never requests a reboot:

```powershell
Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList `
  '-NoProfile','-ExecutionPolicy','Bypass','-File', `
  "$PWD\self-host\windows\Install-DockerHost.ps1"
```

For a maintainer checkout that already has the ignored root `secrets/fcm-service-account.json` and `secrets/youtube.env`, this helper creates a strong admin token, copies only those two credentials into ignored `self-host/secrets/`, and writes an ignored standalone `.env` without Cloudflare credentials:

```powershell
# Loopback-only (default)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Initialize-LocalTest.ps1

# Intentional LAN test publishing
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Initialize-LocalTest.ps1 -PublishAddress 0.0.0.0
```

Other installations should create the same files manually from `.env.example`; the helper deliberately fails rather than overwriting an existing local configuration unless `-Force` is supplied.

LAN publishing is an explicit security decision. Confirm Windows labels the connection **Private**, then add a narrow administrator rule instead of opening the port on Public networks:

```powershell
New-NetFirewallRule -DisplayName 'TubePulse Self-Host 8788 (Private)' `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8788 `
  -Profile Private -RemoteAddress LocalSubnet
```

Start and verify the service from `self-host`:

```powershell
docker compose up --build -d
Invoke-RestMethod http://127.0.0.1:8788/
Invoke-RestMethod http://127.0.0.1:8788/_tubepulse/status
Invoke-RestMethod http://<desktop-lan-ip>:8788/_tubepulse/status
docker compose logs --tail 100 tubepulse
```

Stop it without deleting persistent state with `docker compose down`. To return to loopback-only publishing, set `TUBEPULSE_PUBLISH_ADDRESS=127.0.0.1`, recreate the container, and remove the firewall rule with `Remove-NetFirewallRule -DisplayName 'TubePulse Self-Host 8788 (Private)'`.

## Windows always-on operation

`windows/Start-TubePulse.ps1` remains the simple foreground restart loop for the standalone Preview runtime. Production unified Home uses the narrower Docker supervisor and non-administrator per-user Startup installer:

```powershell
.\windows\Start-HomeAuthority.ps1 -DryRun -InitialDelaySeconds 0
.\windows\Install-HomeAuthorityStartupShortcut.ps1 -DryRun
```

After manual authority recovery/readiness is proven, run the installer from the auto-login profile without elevation. It creates one hidden per-user Startup shortcut; the supervisor supplies the startup delay, bounded retry, and exclusive overlap lock:

```powershell
.\windows\Install-HomeAuthorityStartupShortcut.ps1
.\windows\Install-HomeAuthorityStartupShortcut.ps1 -Inspect
```

The startup script resolves absolute repo paths safely, starts Docker Desktop minimized only when necessary, waits for `docker info`, applies `compose.authority.yaml` idempotently, and checks local readiness, signed coordinator/D1 state, pending/transaction state, and scheduler lease/aligned-cycle progress. It does not clear or activate stale state and does not restart containers merely because an upstream dependency is unavailable. Logs rotate under ignored `data-authority` and never contain raw status or credentials. Disable/remove instructions, dry-run validation, expected recovery bands, and Docker Desktop UI limitations are in [`RECOVERY.md`](RECOVERY.md).

The production auto-login profile now has this shortcut installed and a safe idempotent invocation completed with the existing healthy container unchanged. A real sign-out/reboot test remains outstanding. Docker Desktop still needs an interactive sign-in, so this mechanism cannot provide pre-login service semantics. The elevated Scheduled Task installer remains optional; cross-account UAC can create task ACLs inaccessible to the auto-login profile, and an administrator may need to remove a possibly retained task later. Duplicate invocation is harmless because the supervisor lock and idempotent Compose operation reject overlap.

After authority readiness succeeds, the supervisor also requests the separate aggregate monitoring stack asynchronously. Monitoring failure never changes the authority result or triggers an authority restart. The localhost dashboard, privacy boundary, Account Analytics Read token, retention, and independent stop/status commands are documented in [`../monitoring/README.md`](../monitoring/README.md). Generated Prometheus, Grafana, collector, and JSONL history is kept under ignored [`../logs/`](../logs/README.md).

## Home scheduler consolidation and production authority

`compose.scheduler.yaml` is the legacy, separate no-port shadow service that was used to measure moving scheduled work off Cloudflare. It never shares writable state with `data`, `data-pilot`, `data-gateway`, or production `data-authority`; its ignored store is `data-scheduler`. Its `shadow` mode preserves the old RSS-era measurement behavior for diagnostics and rollback testing only. It cannot write Cloudflare or contact FCM. Current production uses `compose.authority.yaml` and the Data API path described below.

Copy `compose.scheduler.env.example` to ignored `.env.scheduler`, retaining the existing read-token and secret-file mounts. Validate and run one isolated measurement:

```powershell
docker compose --env-file .env.scheduler -f compose.scheduler.yaml config --quiet
docker compose --env-file .env.scheduler -f compose.scheduler.yaml run --rm home-scheduler node src/home-scheduler-cli.mjs once
```

For historical write-rate evidence, `once --sweeps=2` performs two shadow-only whole-fleet measurements in one process. It is a diagnostic compatibility path, not the continuous production cadence, and should not be used while YouTube is suppressing the Home egress because it intentionally concentrates requests. Active mode rejects `once`. Normal `run` mode checks posts only on the configured hourly boundary.

For a continuous shadow, use `up -d`; `restart: unless-stopped` resumes after Docker Desktop starts and the file lease excludes a second runner. Its container health is liveness-only, so verify lease/progress separately after every host reboot. `docker compose --env-file .env.scheduler -f compose.scheduler.yaml down` stops only this service and preserves `data-scheduler`. After an unclean container stop, a replacement intentionally refuses the old lease until its configured TTL expires (180 seconds by default), then archives that stale lease and resumes; do not delete the lock to bypass this safety window.

Continuous Home scheduling sorts and de-duplicates `channels:active`. On every aligned five-minute boundary it calls `channels.list(part=statistics,contentDetails)` in batches of at most 50 IDs. The current fleet fits in exactly two detector requests per cycle, or 576 general quota units/day. A missing baseline or changed public `videoCount` queues that channel's cached uploads playlist for reconciliation. A one-time migration pass reconciles every established channel even when its newly captured count is unchanged; a count baseline alone cannot hide uploads missed during the prior source outage. After that pass, unchanged channels make no per-cycle playlist request. First-page safety reconciliation defaults to every six hours and is bounded per cycle; if no known ID overlaps, pagination continues only to the configured page bound. Posts still sweep every eligible channel once per hour; aux remains bounded and runs each minute.

Playlist results flow through the existing durable known/high-watermark, recent-cache, scheduled/live, notification, canonical backup, and visibility-barrier code. A genuinely new channel seeds silently. An established channel keeps its watermark, including across this migration, so an upload missed during the RSS outage can be classified normally. Private/deleted/unavailable items never notify. New item metadata is fetched through `videos.list` in batches of 50 only where playlist data is insufficient; `search.list` is never used.

Video metrics use the official `videos:batchGetStats` endpoint in batches of 50. Only each channel's current app-visible top three are eligible: the newest is always due every five minutes, while the other two back off from 5 to 15 to 60 minutes, then six hours, and finally daily after repeated static observations. Poll state below the top three is pruned; a deletion/private transition therefore makes the promoted item immediately due without weakening durable known-video dedupe. A runtime method-not-found response permanently selects batched `videos.list(part=statistics)` for that persisted runtime state and restricts polling to newest-only. Known view/like movement may persist at most once per UTC hour; missing values hydrate immediately and unchanged values force a clock refresh after 24 hours. `commentCount` is also retained locally with its observation timestamp, including null and explicit zero, but is excluded from adaptive activity cadence and can never trigger canonical publication. Its latest value may piggyback when structure or an allowed view/like update already requires the same recent-video write.

General and statistics quota counters are persisted before every request, including requests that fail, reset at midnight `America/Los_Angeles` with DST awareness, and enforce separate configurable reserves. Detector work has priority; reconciliation metadata and older metric work are bounded/deferrable. Transient or quota failure retains the last-good cache and never falls back to RSS.

There is **no automatic RSS fallback** in current production. A Data API failure retains last-good channel/video data, sends no false notification, records redacted error/quota health, and retries with bounded backoff. Home remains the current authority for cached app feeds, `/seen`, posts, and aux while source data is temporarily unavailable. The old RSS circuit, signed Cloudflare RSS probe, and uploads-playlist-as-fallback code remain only as historical/rollback implementation; the active scheduler neither fetches RSS nor calls the probe.

The current Data API quota state lives in `data-authority/home-scheduler-state.json`. General and granular-statistics counters are reserved before requests, survive restart, reset at Pacific midnight with DST awareness, and expose only redacted status. The detector baseline is 576 general units/day and the six-hour safety sweep adds at most `active channels × 4`; change reconciliation and metadata are event-driven.

Post cadence is configurable, but it is quota-gated even though the current community-post parser uses InnerTube and does not consume YouTube Data API quota. The production candidate remains the existing effective **60-minute** cadence. The guard conservatively budgets one unit per channel/cycle for any future `activities.list`-style path. Google's current quota calculator assigns `activities.list` one unit and documents 10,000 default daily units for non-search endpoints. Calculate the projection from the live eligible count `N`: hourly is `N × 24`, while five-minute is `N × 288`, before reserve or other API work. Five-minute posts therefore require a separate explicit flag, exact quota latch, and a configured daily budget at least equal to the live calculation plus reserve. Shadow reports both projections but consumes no Data API quota through the current posts path. See [Google's quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost) and [`activities.list` reference](https://developers.google.com/youtube/v3/docs/activities/list).

The 2026-10-04 live shadow measurement covered the complete video and eligible-post fleet with no fetch failures or retries. The fresh canonical seed predicted a one-time changed-key catch-up and several would-send video decisions, but sent no FCM and wrote nothing remotely. A same-process second pass again covered the complete fleet, produced no would-send decision, and observed only metric/cache changes at the hour boundary. This is evidence, not a daily guarantee: the one-time catch-up and content arrival rate vary, so production activation still requires a full-day write measurement. Rotating YouTube thumbnail delivery parameters and relative labels backed by a stable `publishedAt` are ignored for cache-write decisions; real thumbnail paths, content, metrics, and labels without a valid timestamp remain observable changes.

The legacy shadow modes remain deliberately asymmetric:

- `shadow` is the default and requires only KV read access. Remote writes and FCM are rejected.
- `standby` holds no scheduled work and permits neither writes nor notifications.
- `active` remains blocked for the old separate `compose.scheduler.yaml` service. Production active mode exists only in `compose.authority.yaml`, where scheduler and signed mutation ingress share one runtime/store and one lock order.

The one-shot CLI is a local/container administrative operation; there is no unauthenticated HTTP control surface. `windows/Test-HomeSchedulerCutover.ps1` performs read-only Docker, path-isolation, Compose, and Git-secret checks. It never disables a trigger or activates Home.

### Scheduler cutover and rollback

Production cut over to the unified local-first authority on 2026-10-04. This initial KV-backed sequence is retained as history:

1. Keep Home in `standby`, acquire a signed coordinator lease, and import an exact canonical snapshot directly through the Worker binding (no REST/full-mirror race).
2. Disable exactly the triggers for `tubepulse-rss-0`, `tubepulse-rss-1`, `tubepulse-rss-2`, `tubepulse-posts`, and `tubepulse-aux`. The API Worker remains live and the retired combined cron remains triggerless.
3. Verify the live trigger lists are empty and all final CronEvents have drained. Prefer a short detection gap over overlap.
4. Run one local authority/store that executes every signed app mutation with the unchanged API semantics against a buffered local KV view and uses the same locks as scheduled polling. Successful exact deltas enter the Durable Object's deferred cloud-backup queue; semantic failures apply no local writes, and an unavailable Home fails closed.
5. Poll only local KV and publish only journaled changed keys. Do not use a whole-namespace five-minute pull.
6. Queue notification intents, confirm the changed records through the canonical production `/feed`, and only then send FCM exactly once.
7. Verify complete natural sweeps, mutation coordination, restart recovery, Home-backed public feeds, FCM/dedupe ordering, error rate, and measured cloud-storage usage.

Rollback reverses ownership without overlap: stop and drain Home first and verify it is no longer holding the lease. Since the retained Workers bind a frozen KV snapshot, they must not be re-enabled after D1 has advanced until an exact quiesced reconciliation makes that snapshot current. Their handlers also require `TUBEPULSE_ENABLE_FROZEN_KV_ROLLBACK=true`; this latch is an acknowledgement, not a substitute for reconciliation. Never run both notification owners concurrently.

### D1 canonical migration and rollback

The active cloud canonical backend is selected by `TUBEPULSE_CANONICAL_BACKEND=d1` and an explicit generation. D1 read replication remains disabled; fallback reads use the primary database. The schema is an opaque key/value compatibility table plus active-manifest and short-lived guard tables, all without secondary indexes. Values over 1.9 MB are rejected before staging.

For an exact migration, build the new authority image first, then stop/drain Home so its file lease is released. Deploy the API Worker with the D1 binding and a never-before-used generation, then run this one-off command using the normal authority Compose environment:

```bash
node src/home-authority-cli.mjs migrate-d1
```

The command requires Home's local gate to be current, exports the authoritative canonical snapshot, stages bounded chunks, verifies the D1 manifest, activates the generation, rebuilds Durable Object baselines, and only then archives/clears obsolete KV-pending state. Start Home again only after it succeeds. A failed or incomplete migration leaves D1 inactive and legacy pending data intact. After activation the legacy KV namespace is frozen and not dual-written; rollback requires another exact quiesced reconcile rather than a binding flip.

The coordinator budgets three estimated rows per logical key mutation and enforces 45,000 scheduler / 50,000 total estimated rows per UTC day, leaving 5,000 for app mutations against the 100,000-row D1 free allowance. D1 batching is atomic and reduces round trips, but does not reduce billed rows.

The live authority uses ignored `data-authority`, secret-file mounts, and its authority environment; it does not share writable storage with Preview, the old gateway mirror, or the shadow scheduler. `docker compose --env-file .env.authority -f compose.authority.yaml ps` and loopback `GET /_tubepulse/status` are the primary host checks. Do not run the one-shot reconciliation CLI while the service owns its file lease. On rollback, stop/drain Home before restoring any trigger.

`node src/home-authority-cli.mjs status` is a read-only signed coordinator check that emits only replication, lease, transaction, pending-key, backend, and quota status. The Windows startup supervisor runs it in an ephemeral Compose container so Docker liveness is never mistaken for D1/authority readiness.

Active startup reads both the local authority and signed Cloudflare coordinator status before arming the scheduler. If either side is stale, Home drains any verified pending coordinator journal through the signed hash-guarded API lease, imports an exact canonical snapshot, verifies the manifest, and reactivates both sides before accepting traffic. Snapshot and publication lease conflicts use bounded retry/backoff; pending records are never cleared without application. If both persisted status markers say `current`, startup currently skips a full local-versus-D1 manifest verification. D1 recovery exports visible canonical rows with a bounded set-based read rather than one query per key, preserving null expiration as non-expiring and staying below per-invocation query limits. A publication/timer failure is contained rather than becoming an unhandled process rejection: the interrupted cohort is recorded in `scheduler.lastError`, Home attempts the same exact reconciliation, and the minute timer continues. If reconciliation replaced local state after a cohort began, that cohort is marked failed rather than resuming progress against replaced state; the deterministic cycle resumes safely from current canonical data. An unclean process stop still leaves the file lease protected until its TTL expires; a clean shutdown waits for the active tick, releases the lease before disposing workerd, and permits an immediate restart. The complete current recovery procedure and remaining hardening gaps are in [`RECOVERY.md`](RECOVERY.md).

### Historical incident: YouTube RSS 404 diagnosis (2026-10-05)

If many valid channels begin returning RSS 404s together, test the same known-valid official feed from both the host and the container before changing channel state or scheduler configuration. On 2026-10-05, both Home surfaces received a generic 404 from the `YouTube RSS Feeds server`, while the identical feed returned XML from an independent external network. Sweep logs degraded progressively from complete success to complete failure, recovered spontaneously without a restart, then degraded again during the observed window.

That evidence is consistent with transient YouTube edge throttling or anti-abuse handling of the Home public IP, but it does not prove a formal rate limit because the response was 404 rather than 429. The retired RSS implementation could multiply a full-fleet failure with retries and concentrate the requests into a short burst. Check the response server, compare an independent network, and review per-sweep success/retry counts. Do not treat the generic 404 as proof that all channel IDs should be removed, and do not attribute it to the unrelated `/seen` API deployment: the all-channel failure predated that deployment and no scheduler fetch code changed.

The RSS anti-burst/circuit implementation entered production temporarily on 2026-10-05 in the safe order: signed Worker probe first, then Home. Its first complete cycle covered the full fleet sequentially with zero retries. All Home feeds returned `http-404`; the independent Cloudflare probes were inconclusive network failures, so Home correctly served stale cache in `rss-probe-inconclusive` mode and made no Data API fallback request. This paragraph is incident history, not the current architecture; production subsequently cut over to the Data API with no RSS fallback. See [`STATUS.md`](../STATUS.md) for timestamped rollout evidence.

## Configuration reference

The CLI loads `self-host/.env` without replacing variables already provided by the process environment.

| Variable | Default | Purpose |
|---|---:|---|
| `TUBEPULSE_PILOT` | `false` | Hard local-only safety boundary used by the isolated Preview pilot; requires standalone mode and disables Cloudflare synchronization |
| `TUBEPULSE_MODE` | `standalone` | `standalone` or `mirror` |
| `TUBEPULSE_HOST` | `127.0.0.1` | Public listener address; use `0.0.0.0` only intentionally |
| `TUBEPULSE_PORT` | `8788` | Public listener port; `0` is supported for tests |
| `TUBEPULSE_PUBLISH_ADDRESS` | `127.0.0.1` | Docker Compose host-side bind address; set `0.0.0.0` only intentionally |
| `TUBEPULSE_HOST_DATA_DIR` | `./data` | Docker Compose host-side persistent-data directory; the pilot profile sets this to `./data-pilot` |
| `TUBEPULSE_DATA_DIR` | `self-host/data` | Persistent local KV and sync/runtime state |
| `TUBEPULSE_ADMIN_TOKEN` / `_FILE` | unset | Protects all mutating admin endpoints; missing means they fail closed |
| `FIREBASE_SERVICE_ACCOUNT` / `_FILE` | unset | Existing Worker FCM credential; prefer a file |
| `YOUTUBE_API_KEY` / `_FILE` | unset | Required for active Home Data API discovery; prefer a file |
| `TUBEPULSE_HOME_SCHEDULER_VIDEO_SOURCE` | `youtube-api` | Active mode requires `youtube-api`; `rss-legacy` is non-active rollback only |
| `TUBEPULSE_HOME_SCHEDULER_YOUTUBE_SAFETY_RECONCILE_HOURS` | `6` | First-page reconciliation interval even when `videoCount` is unchanged |
| `TUBEPULSE_HOME_SCHEDULER_YOUTUBE_MAX_RECONCILIATIONS_PER_CYCLE` | `5` | Bounds normal safety/change playlist work per five-minute cycle |
| `TUBEPULSE_HOME_SCHEDULER_YOUTUBE_MAX_MIGRATION_RECONCILIATIONS_PER_CYCLE` | `100` | One-time bounded cutover pass; a detector baseline alone never marks migration complete |
| `TUBEPULSE_HOME_SCHEDULER_YOUTUBE_MAX_PLAYLIST_PAGES` | `3` | Pagination safety bound when no known ID overlaps |
| `TUBEPULSE_HOME_SCHEDULER_YOUTUBE_STATISTICS_DAILY_QUOTA_UNITS` | `10000` | Separate official granular statistics bucket |
| `TUBEPULSE_HOME_SCHEDULER_YOUTUBE_STATISTICS_RESERVE_UNITS` | `1000` | Hard statistics-bucket reserve |
| `TUBEPULSE_HOME_SCHEDULER_RSS_CHANNEL_TIMEOUT_SECONDS` | `3` | Legacy `rss-legacy` rollback/shadow setting; inactive in production |
| `TUBEPULSE_HOME_SCHEDULER_RSS_CIRCUIT_INITIAL_COOLDOWN_MINUTES` | `15` | Legacy RSS circuit setting; inactive in production |
| `TUBEPULSE_HOME_SCHEDULER_RSS_CIRCUIT_MAXIMUM_COOLDOWN_MINUTES` | `60` | Legacy RSS circuit setting; inactive in production |
| `TUBEPULSE_HOME_SCHEDULER_RSS_RECOVERY_SUCCESSES` | `2` | Legacy RSS circuit setting; inactive in production |
| `TUBEPULSE_HOME_SCHEDULER_YOUTUBE_API_FALLBACK_ENABLED` | `true` | Legacy RSS-to-API fallback latch; ignored by active `youtube-api` production mode |
| `TUBEPULSE_HOME_SCHEDULER_YOUTUBE_FALLBACK_DAILY_CAP` | budget remainder | Legacy fallback cap; inactive in production |
| `TUBEPULSE_ENABLE_COMMUNITY_POSTS` | `true` | Existing posts feature binding |
| `CLOUDFLARE_ACCOUNT_ID` | unset | Cloudflare account for mirror sync |
| `CLOUDFLARE_KV_NAMESPACE_ID` | unset | Cloudflare KV namespace for mirror sync |
| `CLOUDFLARE_API_TOKEN` / `_FILE` | unset | Scoped Cloudflare token; prefer a file |
| `TUBEPULSE_SYNC_PULL_INTERVAL_SECONDS` | `1800` | Conservative automatic pull interval in mirror mode |
| `TUBEPULSE_SYNC_CONCURRENCY` | `4` | Bound for sync value requests/writes |
| `TUBEPULSE_CLOUDFLARE_WRITE_ENABLED` | `false` | Required before a push can apply |
| `TUBEPULSE_SYNC_AUTO_PUSH` | `false` | Apply pushes after automatic pulls; also requires write-enabled mode |
| `TUBEPULSE_AUTO_TAKEOVER` | `false` | Permit baseline-gated takeover after a client fallback request |
| `TUBEPULSE_SELF_HOST_URL` | local listener | Target used by CLI status/admin commands |
| `TUBEPULSE_GATEWAY_ORIGIN_ENABLED` | `false` | Accept authenticated canary gateway traffic; requires mirror mode, read-only sync, admin auth, no takeover/push, and is forbidden in pilot mode |
| `TUBEPULSE_HOME_GATEWAY_SECRET` / `_FILE` | unset | Shared HMAC secret, minimum 32 characters; never expose as an ordinary public variable |
| `TUBEPULSE_HOME_CANARY_SHA256` / `_FILE` | unset | Full lowercase SHA-256 canary fingerprint; the file may be raw hex or ignored `canary-device.json` and only its `deviceFingerprintSha256` field is consumed |
| `TUBEPULSE_GATEWAY_CLOCK_SKEW_SECONDS` | `60` | Accepted signed-request clock skew and replay-cache window |
| `TUBEPULSE_GATEWAY_READINESS_MAX_AGE_SECONDS` | twice pull interval | Maximum age of a successful conflict-free pull before Home reads fail closed |
| `TUBEPULSE_GATEWAY_RECONCILE_URL` | unset | Exact HTTPS API Worker `/_tubepulse/gateway/reconcile` endpoint; enables signed automatic stale recovery after a proven exact pull |
| `TUBEPULSE_GATEWAY_RECONCILE_TIMEOUT_SECONDS` | `10` | Bounded timeout for the signed post-pull receipt |

Scheduler-only variables are documented in `compose.scheduler.env.example`. They intentionally use the `TUBEPULSE_HOME_SCHEDULER_*` prefix and do not alter the ordinary self-host service or gateway origin.

The API Worker additionally accepts `TUBEPULSE_HOME_GATEWAY_TRANSPORT=vpc` only when a `TUBEPULSE_HOME_VPC` fetcher binding exists. This permits the internal `http://gateway-origin:8788` URL because Workers VPC fixes the destination and carries traffic through the authenticated Tunnel. It does not relax the public-origin HTTPS validation path.

Cloudflare settings are all-or-none. Incomplete credentials stop startup instead of silently running a partial mirror. Automatic push is intentionally off and cannot be enabled unless writes are independently enabled.

## Cloudflare token permissions and quota (legacy Preview mirror only)

This section applies to the optional `TUBEPULSE_MODE=mirror` preview tooling, not the production D1 authority path. Create a narrowly scoped API token for the one account and legacy namespace:

- Pull-only standby: Workers KV Storage **Read**.
- Push apply: Workers KV Storage **Edit**, only when you genuinely intend this host to write back.

Do not use a global API key. Cloudflare KV REST reads, lists, writes, and deletes count toward the same plan quotas as Worker binding operations. Mirroring moves or duplicates operations; it does not bypass Cloudflare accounting. Keep the pull interval conservative, inspect a push dry-run, and leave automatic push disabled until the operating model is proven. See Cloudflare's [KV REST API](https://developers.cloudflare.com/api/resources/kv/) and [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).

## Synchronization workflow

Configure mirror mode and read-only Cloudflare credentials, start the service, then use the local CLI. CLI commands call the authenticated running service; they do not open a second Miniflare instance over the same files.

```bash
# Initial snapshot or later reconciliation
npm run sync:pull

# Safe default: show planned puts/deletes, write nothing remotely
npm run sync:push

# Explicit remote mutation; requires WRITE_ENABLED=true
npm run sync:push -- --apply

# Operational role changes
node src/cli.mjs admin takeover
node src/cli.mjs admin standby
node src/cli.mjs status
```

Equivalent HTTP operations are `POST /_tubepulse/admin/{takeover,standby,sync/pull,sync/push}` with `Authorization: Bearer <admin token>`. Push accepts `{"apply":true}`; omission is a dry-run. Never expose admin endpoints without TLS and a strong token.

When the canary gateway origin is explicitly enabled, `POST /_tubepulse/admin/gateway/reconcile` performs a full pull. It returns a short-lived, device-scoped signed receipt only if the pull has no conflict or pending local state. An operator can submit that receipt to the API Worker's signed internal `POST /_tubepulse/gateway/reconcile` endpoint to transition the canary from missing/stale to current. When `TUBEPULSE_GATEWAY_RECONCILE_URL` is configured, automatic pulls perform the same signed transition after—not before—a clean parity proof. A signed mutation observed during an in-flight pull invalidates that snapshot for recovery and queues a fresh pull. Genuine conflicts or pending local keys leave the marker stale. Neither endpoint is an app route, neither is reachable through the gateway proxy allowlist, and the Home endpoint requires the existing admin token. Gateway marker keys are excluded from mirror copying because they are Cloudflare routing state, not app state.

The first production canary completed these prerequisites on 2026-10-04 using the private Workers VPC path and was later disabled. Do not restart its former five-minute full-mirror cadence on a free account. For another installation or bounded canary: put the shared secret in both secret stores; provision the private VPC origin (or a valid HTTPS origin); set the Home fingerprint from the ignored `secrets/canary-device.json`; calculate mirror read usage first; complete the initial reconcile; then enable the Worker flag for only that fingerprint. Roll back routing immediately by setting `TUBEPULSE_HOME_GATEWAY_ENABLED=false`; the unchanged app continues on Cloudflare. Do not enable automatic Home takeover or push for this canary phase.

The reconciliation model is key-level three-way comparison:

1. `sync-state.json` records the last shared content hash and expiration for each included key.
2. Pull imports a missing local key or applies a remote change only while the local key still matches the baseline.
3. A locally changed key remains pending; pull never silently overwrites it.
4. If local and remote both changed differently, the key is quarantined as a conflict (hashes only; values are not copied into the conflict ledger). The gateway mirror has two schema-specific exceptions for signed replay bookkeeping: device profiles differing only in a valid `lastSeenAt`, and newly created `channel:{id}:meta` objects differing only in a valid numeric `addedAt`. In either exact case Cloudflare's canonical record is selected and the baseline advances. Missing/malformed timestamps, extra keys, or any token, platform, version, creation-time, channel name/avatar/video metadata, type, or other difference remains a genuine conflict. No other key family uses these resolvers.
5. Push is a dry-run by default. Apply re-reads current remote content and expiration and writes only if they still match the baseline.
6. A 429 or other failed operation leaves the local change pending and does not advance the baseline.

Installation-specific keys are excluded centrally in `src/exclusions.mjs`: cached FCM access tokens, FCM token lookup-index keys, WebSub leases, and Cloudflare-owned `gateway:canary:*` routing markers. Device profiles—including FCM registration tokens needed for notification takeover—are synchronized, so the data directory and Cloudflare token must be treated as sensitive.

To resolve a genuine conflict, first put the service in standby and back it up. Deliberately make the local and remote values agree using the owning API/workflow, then pull again; matching sides advance the baseline and clear the conflict. There is no generic raw-value conflict editor because exposing one would bypass the application contracts.

## Takeover and recovery

Manual takeover is the safest first deployment:

1. Run a pull and confirm `conflictCount: 0` and acceptable `pendingCount` at `/_tubepulse/status`.
2. At a chosen maintenance boundary, intentionally pause the Cloudflare scheduled Workers and confirm they have stopped. This preview does not change them for you.
3. Issue `node src/cli.mjs admin takeover`.
4. Confirm scheduler outcomes become `ok` after the next aligned minute/five-minute boundary.

That ordering prefers a short polling gap over an overlap that could duplicate notifications. During an unplanned 429/outage, Cloudflare may be unreachable and the clean pause cannot be confirmed; that is the inherently ambiguous boundary called out below.

Optional automatic takeover requires all of the following:

- mirror mode;
- `TUBEPULSE_AUTO_TAKEOVER=true`;
- a fallback request carrying `X-TubePulse-Failover: 1`;
- an app API path with an unchanged bearer device profile whose hash is represented in the durable Cloudflare sync baseline; and
- a successful local API response.

The header is only a signal and is not a secret. Baseline-backed identity is the activation gate: a marked health request, a rejected request, or an attacker registering a new local device cannot activate schedulers. The feature remains an explicit tradeoff because copied device identifiers are bearer credentials, not strong user authentication.

After Cloudflare service/quota recovery:

1. Stay in active mode; do not auto-failback.
2. Keep Cloudflare scheduled Workers paused (or pause them as soon as control returns), then back up the local data directory.
3. Pull. Locally dirty keys remain pending and two-sided changes become conflicts.
4. Run push dry-run, review counts, resolve conflicts, and apply only if Cloudflare write-back is intended.
5. Explicitly return this host to standby and confirm its scheduler is stopped. **This does not stop the local API.** App processes that already succeeded on fallback remain sticky to that API and can continue creating local writes.
6. Have affected users fully stop and relaunch the app (or otherwise verify a fresh app process is using the recovered primary). There is currently no server-side command that can force an already-running client back to primary or prove that every client has drained.
7. While Cloudflare schedulers are still paused, check for local changes made during that transition and perform another pull, dry-run, conflict review, and explicit push if necessary. Repeat until the operator is satisfied that local writers have drained and Cloudflare contains the intended state.
8. Only then resume Cloudflare scheduled Workers and verify their next invocations.

If Cloudflare schedulers resumed by themselves before you could pause them, an overlap may already have occurred. Put the local scheduler in standby promptly, inspect notification/state evidence, coordinate client relaunches, and reconcile while it remains stopped. If you cannot confirm that sticky clients have left the local API, do not claim Cloudflare is authoritative; keep the system in a documented transitional state or take an explicit maintenance window.

This is a conservative cutback procedure, not zero-downtime automatic failback. With the current process-lifetime client stickiness and writable standby API, exact coordination is not available.

## Android endpoint behavior

Current production behavior is unchanged. With no variables, the app uses exactly:

```text
https://tubepulse-api.jimothyoakley55.workers.dev
```

Ordinary builds may still set a primary URL at build time:

```dotenv
EXPO_PUBLIC_TUBEPULSE_API_URL=https://tubepulse.example.net
```

For Cloudflare primary plus self-host fallback:

```dotenv
EXPO_PUBLIC_TUBEPULSE_API_URL=https://tubepulse-api.example.workers.dev
EXPO_PUBLIC_TUBEPULSE_FALLBACK_API_URL=https://standby.example.net
```

These production/failover values are Expo public build-time values. The production client retries once on network failure or HTTP `429`, `502`, `503`, or `504`. It does not fail over on `400`, `401`, or other client/auth errors. Fallback requests include `X-TubePulse-Failover`, and the first successful fallback becomes sticky for the app process lifetime. There is no silent automatic failback. The gateway adds this marker to CORS preflight allow-headers, though the native Android client is not subject to browser CORS.

The `selfhost` Preview variant is intentionally different: its endpoint is selected at runtime, persisted in that app's isolated storage, and can be changed from **Settings → Preview Server** without rebuilding or restarting. It has no production fallback.

## No-new-Worker Preview pilot

This pilot needs no additional Cloudflare Worker. The native Android project has a dedicated `selfhost` build type that is debug-signed and debuggable but still runs the React Native bundle task, so the APK is self-contained and does not need Metro. Its identity and storage are separate from the normal app:

| Property | Preview build |
|---|---|
| Package | `com.tubepulse.app.selfhost` |
| Launcher label | `TubePulse Preview` |
| Version name | normal version plus `-preview` |
| Network policy | cleartext HTTP allowed only by `src/selfhost/AndroidManifest.xml` |
| Endpoint | selected and health-tested on first launch; changeable later |
| Production fallback | none |

Use the committed `compose.pilot.env` profile for this test. It gives the container a distinct Compose project name (`tubepulse-pilot`) and a fresh `self-host/data-pilot` bind mount; it never mounts the ordinary `self-host/data` directory. Do not copy old or production state into `data-pilot`, pull production Cloudflare KV into it, or run a local scheduler over copied production state: that could duplicate notifications. The pilot APK uses separate app data and sends a null FCM token, so it can test API registration, subscriptions and feeds without changing the main app.

The profile also sets `TUBEPULSE_PILOT=true`, standalone mode, and disables automatic takeover, Cloudflare writes, and automatic sync push. Pilot mode ignores Cloudflare sync credentials inherited from the existing ignored `.env`; runtime startup fails if any of those unsafe role/write settings are forced back on. The container still consumes `.env` and `secrets/` for local settings such as the admin token, YouTube key, and Firebase credentials, but the pilot profile never edits either one.

### 1. Start an isolated Home on the LAN

For Docker, initialize the ignored local configuration if needed, then always start this pilot from `self-host` with the pilot environment file:

```powershell
cd self-host
.\windows\Initialize-LocalTest.ps1 -PublishAddress 0.0.0.0
docker compose --env-file compose.pilot.env up --build -d
docker compose --env-file compose.pilot.env ps
Invoke-RestMethod http://127.0.0.1:8788/
Invoke-RestMethod http://<desktop-lan-ip>:8788/
$Status = Invoke-RestMethod http://127.0.0.1:8788/_tubepulse/status
$Status.configuration | Select-Object pilot, mode, autoTakeover, cloudflareSyncConfigured, cloudflareWriteEnabled, automaticPushEnabled
```

The status fields must show `pilot: true`, `mode: standalone`, and all takeover/sync/write fields as `false`. If startup fails, inspect only the pilot service logs with `docker compose --env-file compose.pilot.env logs --tail 100 tubepulse`; do not remove the safeguards to make it start. Keep the Windows network profile Private and the inbound firewall rule limited to `LocalSubnet`, as described under [Docker](#docker). A successful health response includes `"status":"ok"` and `"worker":"tubepulse-api"`.

Use the same environment file for every later pilot operation:

```powershell
# Restart while preserving isolated pilot data
docker compose --env-file compose.pilot.env restart tubepulse

# Stop while preserving self-host/data-pilot
docker compose --env-file compose.pilot.env down

# Start it again with the same isolated state
docker compose --env-file compose.pilot.env up --build -d
```

Omitting `--env-file compose.pilot.env` selects the ordinary Compose defaults and `self-host/data`; that is not the isolated Preview pilot. Do not run the ordinary and pilot Compose projects simultaneously because both try to publish host port `8788`.

### 2. Build and install the side-by-side app

From the repository root on Windows, pass the desktop address reachable by the phone. This value only pre-fills the first-launch form; it is not trusted or contacted until the user tests and accepts it:

```powershell
$DesktopIp = '192.168.1.20' # replace with this host's Private-LAN address
npm run build:android:selfhost -- --ApiUrl "http://${DesktopIp}:8788"
```

The script rejects malformed URLs, enables Preview mode, clears production primary/fallback build variables, generates a temporary ignored `google-services.json` for the local package, runs `assembleSelfhost`, removes that temporary file even on failure, copies the APK to ignored `dist/`, and prints its SHA-256. It does not change `app.json`, the production package, or the production endpoint default.

If this Windows host reports `java.nio.channels.Pipe.open(): Unable to establish loopback connection`, use the script's narrow TCP fallback switch; it changes Java pipe transport for that process only:

```powershell
.\scripts\Build-SelfHostApk.ps1 `
  -ApiUrl "http://${DesktopIp}:8788" `
  -UseTcpJavaPipeFallback
```

Install without replacing the main app:

```powershell
$Adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $Adb install -r .\dist\TubePulse-Preview-4.0.0-debug.apk
```

On first launch, enter the LAN URL, tap **Test connection**, then **Use this server**. The health test is a read-only `GET /`; registration and reconciliation do not begin until the URL has passed that test and is accepted. Later, use **Settings → Preview Server** to test or switch to another LAN or HTTPS URL. A switch takes effect immediately and re-runs registration/reconciliation; reinstalling or restarting is not required.

The generated Firebase client metadata is only a build shim copied from the existing non-secret Android client configuration. It does **not** register `com.tubepulse.app.selfhost` with Firebase. This pilot deliberately registers with a null FCM token. Push delivery requires creating a distinct Firebase Android app for that package, supplying its actual configuration, and deliberately enabling push in a future build. Do not change or reuse production Firebase restrictions merely to make the Preview variant receive pushes.

### 3. Manual pilot checklist

- Confirm `/_tubepulse/status` reports `pilot: true`, `mode: standalone`, and false for auto-takeover, Cloudflare sync/write, and automatic push.
- Confirm the pilot container mounts `self-host/data-pilot`, and that no state was copied from `self-host/data` or Cloudflare.
- Confirm Home responds at `http://<desktop-lan-ip>:8788/` from the phone's LAN.
- Install **TubePulse Preview** alongside the main **TubePulse** app; confirm neither replaces the other.
- Test and accept the Home URL before registration starts.
- Register/add a disposable non-production test channel, then confirm it appears in the Home feed after local polling.
- Pull to refresh and verify feed/subscription/settings calls work. Push is out of scope for this null-token APK.
- Restart TubePulse Home, pull to refresh again, and confirm the Preview error banner clears after **Retry**.
- Force-stop/reopen the Preview app and confirm the selected URL persists.
- Change the URL from **Settings → Preview Server**, retest it, and confirm the change takes effect without a rebuild.
- Verify the main app still uses production Cloudflare and its data/settings are unchanged.
- Stop the pilot with `docker compose --env-file compose.pilot.env down`; confirm this preserves `data-pilot` and leaves production Cloudflare untouched.

## Publishing with Cloudflare Tunnel

After LAN validation and a security review, the same installed Preview APK can switch to a named Cloudflare Tunnel HTTPS hostname from **Settings → Preview Server**. A Tunnel is a connector plus public hostname; it does not consume a Cloudflare Worker script slot. Keep the Node listener on loopback, route only the intended hostname to `http://127.0.0.1:8788`, and follow Cloudflare's [locally managed tunnel guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/). Apply Access or another policy to the admin path if possible, but do not place an interactive login challenge in front of app API routes.

Do not use a public unauthenticated Quick Tunnel for sustained operation. Current app identities are bearer device IDs, not strong user authentication, so public exposure needs a named hostname, TLS, admin-path protection, rate limits, and an explicit security review first. This pilot does not create a Tunnel or any Cloudflare resource.

If you intentionally bind to `0.0.0.0`, use host firewall rules and never expose plain HTTP directly to the internet.

## Backup and restore

The following generic procedure applies to the standalone/legacy mirror tooling. It is not sufficient by itself for the unified production authority:

1. In mirror mode, issue standby. In standalone mode, stop the process.
2. Copy the entire configured data directory, including `kv`, `sync-state.json`, and `runtime-state.json`.
3. Restart and check both health endpoints.

Restore by stopping the service, moving the current data directory aside, copying the complete backup into place, verifying restrictive permissions, and starting again. Never copy only the KV database without its sync baseline when using mirror mode. Test restores periodically.

Production does not assume an independent local/off-host file backup. If the Home disk is lost, GitHub restores source/runbooks, active D1 restores canonical application state, and the Durable Object preserves backend/baseline/transaction/pending/quota coordination. Local secret values, scheduler/quota JSON, notification-intent history, Miniflare bytes, and Windows/Docker setup are lost and must be rotated or conservatively reconstructed. Frozen Workers KV is not a recovery source. The agent-executable account-control-plane rebuild, credential matrix, exact D1 reconciliation command, quota wait, activation gates, and failure branches are in [`RECOVERY.md`](RECOVERY.md).

## Consistency and safety limits

- Conflict detection is per key, not a distributed transaction across related TubePulse keys.
- Miniflare is primarily a development/testing harness; this is a self-host preview.
- Cloudflare KV itself is eventually consistent; a pull is a snapshot assembled from paginated listing and individual reads.
- There is no automatic failback.
- Standby stops local schedulers, not the local API. Clients already sticky to fallback can continue writing locally until their app process is restarted or otherwise moved back to primary.
- Consequently, this milestone does not offer zero-downtime cutback or a definitive server-side client-drain signal; operators must coordinate relaunches and reconcile transition writes.
- An ambiguous takeover boundary can produce duplicate notifications if Cloudflare and local schedulers overlap.
- Standby API requests can change local state even while schedulers are off; synchronization will treat those keys as locally dirty.
- Production build primary/fallback URLs are fixed at build time. The isolated Preview app instead persists one runtime-selected Home and never falls back to production.
- Automatic push is hazardous and disabled by default.
- This service provides process-level scheduling and overlap prevention, not multi-node leader election. Run one active instance per local data directory.

## Secret handling

- Prefer `_FILE` variables for the admin token, Cloudflare API token, and Firebase JSON.
- Restrict `.env`, secret files, and the data directory to the service account. They are gitignored, but filesystem permissions remain your responsibility.
- Never put tokens in Docker images, command-line arguments, screenshots, bug reports, or public tunnel URLs.
- Health output intentionally omits secret values, conflict keys, and filesystem paths.
- Rotate a token immediately if it appears in logs or shell history.

## Validation

Run the self-host and existing Worker suites from the repository root:

```bash
npm run check:self-host
npm run check:workers
npm run test:preview-endpoint
```

Self-host tests use temporary local directories, fake KV adapters, or mocked fetch. They do not call production Cloudflare, YouTube, or FCM.
