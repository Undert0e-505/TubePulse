# Unified Home startup and total-loss recovery

This runbook covers two different recovery problems:

1. unattended recovery of the existing Windows Home host after reboot, sleep, Docker failure, or a transient network outage; and
2. reconstruction after the Home disk and every local TubePulse file are gone, assuming the operator still controls GitHub and the existing Cloudflare, Google Cloud, and Firebase projects.

The total-loss procedure does **not** assume an independent file backup. It is deliberately conservative: D1 can reconstruct canonical application state, but it cannot reconstruct local credentials or every scheduler-only decision. Keep Home in standby until every explicit activation gate passes.

## Safety rules and non-goals

- Never paste credentials into chat, tickets, shell history, screenshots, logs, Git, or this runbook.
- Cloudflare secret values are write-only. Account access shows that a secret exists, not its value; rotate lost values.
- Never clear a Durable Object transaction/pending queue, delete a lease, initialize empty production state, or route automatically to frozen Workers KV.
- Never run two Home schedulers or re-enable legacy Cron Triggers during recovery.
- Never send a test push to real users without explicit authorization.
- Treat Docker liveness, authority readiness, dependency availability, scheduler progress, and data integrity as separate states.

## Current unattended startup mechanism

The tracked Windows mechanism consists of:

- `windows/Start-HomeAuthority.ps1`: an idempotent, bounded startup supervisor;
- `windows/Install-HomeAuthorityStartupTask.ps1`: an elevated installer for a hidden at-logon Scheduled Task;
- Docker Compose `restart: unless-stopped`, the authority health check, persistent `data-authority`, and reconnecting `cloudflared`.

The supervisor resolves repository paths from its own location, takes an exclusive non-destructive lock, starts Docker Desktop with `--minimized` only when `docker info` is unavailable, waits with exponential backoff, and runs the existing authority Compose stack with absolute Compose/environment paths. It rotates one bounded local log generation and never logs secrets or raw status payloads.

It verifies more than HTTP success:

- Docker engine availability;
- authority container running/health state;
- local service identity and `ready` status;
- local authority current state and no local transaction;
- signed coordinator status through `home-authority-cli.mjs status`;
- selected/ready D1 backend, remote current state, no transaction, and no pending backup keys;
- active scheduler mode, fresh lease heartbeat, and recent minute progress (with a startup grace window).

The Compose health check itself proves only HTTP success plus service identity. Docker can report healthy while authority is stale or scheduler progress is stuck. The supervisor never clears pending state or activates stale authority. It performs at most one bounded container restart for a proven liveness-health failure; readiness, coordinator, progress, or WAN failures are retried/reported without destructive restart loops.

### Install, inspect, disable, or remove the task

First initialize and manually verify the authority. Then preview the task without changing Windows:

```powershell
.\self-host\windows\Install-HomeAuthorityStartupTask.ps1 -DryRun
.\self-host\windows\Start-HomeAuthority.ps1 -DryRun -InitialDelaySeconds 0
```

From an elevated PowerShell session, install or idempotently replace the task:

```powershell
.\self-host\windows\Install-HomeAuthorityStartupTask.ps1
Get-ScheduledTask -TaskName 'TubePulse Home Authority'
```

The task runs at interactive sign-in after a short delay, uses a hidden PowerShell window, ignores overlapping instances, and asks Task Scheduler to retry bounded failures. It starts Docker Desktop minimized and waits for the engine instead of relying on Docker Desktop's separate autostart setting. This avoids duplicate startup owners.

Disable or remove only the task; neither command removes containers or data:

```powershell
.\self-host\windows\Install-HomeAuthorityStartupTask.ps1 -Disable
.\self-host\windows\Install-HomeAuthorityStartupTask.ps1 -Uninstall
```

Docker Desktop is a user-session application. The task therefore runs at logon, not before any user session exists. `--minimized`, hidden Task Scheduler execution, and `-WindowStyle Hidden` prevent a persistent foreground window under normal versions, but Docker Desktop may still show a tray icon, first-run agreement, update prompt, or brief vendor-controlled splash. A service-oriented runtime would be required for a strict pre-login/no-UI guarantee.

### Expected common-failure behavior

| Event | Expected behavior | Target recovery band |
|---|---|---:|
| Home process/container exits | Docker restarts it with the persistent bind mount; lease/transaction safeguards still apply. | At most 5 minutes |
| Docker is stopped at sign-in | Hidden task starts Docker Desktop minimized, waits for `docker info`, then applies Compose idempotently. | At most 10 minutes after sign-in |
| Reboot or power restoration | Same at-logon flow; an unclean lease must expire naturally. | At most 10 minutes after sign-in/network |
| Sleep/hibernation | Docker/containers normally resume; cloudflared reconnects. A later task retry or manual dry status can reassert Compose without overlap. | At most 10 minutes after usable network |
| Internet/Cloudflare outage | Containers remain intact; cloudflared and Home retry/back off. Supervisor classifies dependency failure and does not restart repeatedly. | At most 10 minutes after dependency return |
| Container HTTP health is genuinely unhealthy | Supervisor may perform one bounded restart, then alerts/fails if liveness does not return. | At most 5 minutes when dependencies are healthy |
| Authority stale, pending, or transaction fault | No destructive restart/clear/activation. Task exits unsuccessfully after bounded observation so the fault remains actionable. | Manual integrity recovery |
| Scheduler heartbeat/progress stuck while HTTP remains healthy | Classified separately and surfaced; not treated as an upstream outage or automatic data reset. | Manual diagnosis after bounded alert |

The current host must have the installer executed and reboot-tested before these become host guarantees. Repository presence alone does not register a task.

## Total-loss recovery: what survives remotely

| Remote control plane | What survives | Recovery check |
|---|---|---|
| GitHub | Source, migrations, Compose configuration, environment templates, tests, and this runbook | Select the exact production commit/tag; never assume the newest branch tip is deployed. |
| Cloudflare Worker | Existing public URL, deployed API code/settings, encrypted secret names, VPC/D1/DO bindings | Preserve the deployment and bindings until replacement Home is verified. |
| Cloudflare D1 | Active canonical generation and canonical application/scheduler key space | Generation matches tracked configuration; primary database is available. |
| Durable Object coordinator | Replication state, backend identity, baseline hashes, transaction/pending journals, and D1 row-budget counters | No unexplained transaction, lease, generation mismatch, or pending work before snapshot. |
| Cloudflare Tunnel/VPC | Existing tunnel and VPC Service configuration | Connect a newly issued token to the existing tunnel; do not create a competing origin casually. |
| Existing Firebase project | Installed-app FCM relationship, application identity, service accounts | Generate a new Admin key in this same project and revoke the lost key. |
| Existing Google Cloud project | YouTube API enablement, quota, credential inventory, restrictions | Create/rotate a key in this same project and restrict it to YouTube Data API v3. |

Frozen Workers KV also survives, but is only a historical point-in-time snapshot. It is never a current recovery source after D1 advances.

## What is lost with the disk

- all local secret values/files and `.env.authority`;
- Miniflare/local KV and the complete `data-authority` directory;
- detector baselines, reconciliation clocks, adaptive metric/comment observations, and other host-only scheduler JSON;
- local YouTube general/statistics quota reservations;
- local notification-intent history, including claimed/sending ambiguity;
- Docker/WSL/Windows ACL, firewall, startup configuration, and local logs;
- any unpushed source or generated artifacts.

D1 restores canonical app state, including durable known-content data represented in the manifest. Local polling observations rehydrate after activation; they are not canonical data loss.

## Credential recovery matrix

Use separate least-privilege credentials for separate jobs. Revoke old credentials after replacements are installed, unless suspected compromise requires immediate revocation.

| Credential | Recover old value? | Required rotation | Current/legacy role |
|---|---|---|---|
| Home authority HMAC | No; Worker secret is write-only. | Generate locally with the repository initializer, then replace `TUBEPULSE_HOME_AUTHORITY_SECRET` on the existing API Worker with exactly that value. Pipe it to Wrangler; never print it. | Signs Home/coordinator control and VPC authority requests. Both ends rotate together. |
| Tunnel connector token | Do not rely on recovery. | Rotate/regenerate for the existing tunnel, save only as `self-host/secrets/cloudflared-tunnel-token.txt`, retire lost connectors. | Reconnects `cloudflared` to the VPC tunnel. |
| Cloudflare deploy token | No. | Revoke/recreate with Workers Scripts Edit only for Worker secret/source operations; add D1 permission only for a reviewed step that needs it. Store with `Initialize-CloudflareDeployToken.ps1`; never mount into Home. | Manual Wrangler/secret administration, not canonical publication. |
| Home legacy KV token | No. | Create a separate token scoped to frozen KV. Read is enough for recovery diagnostics; Edit is only for authorized reconciled rollback. Save under historical filename `cloudflare-scheduler-write-token.txt`. | Compatibility/shadow KV tooling. Active D1 publication uses signed Worker/DO paths. |
| Firebase Admin JSON | No private-key recovery. | Generate in the **existing Firebase project**, save as `self-host/secrets/firebase.json`, validate OAuth without sending FCM, then revoke the lost key. | Active Home notification delivery. Rollback Workers need a copy only before authorized rollback. |
| YouTube Data API key | Treat as compromised. | In the **existing Google Cloud project**, enable/confirm YouTube Data API v3, create/restrict a replacement key, save as `self-host/secrets/youtube-api-key.txt`, update the API Worker resolver/bootstrap copy, then revoke the lost key. | Active Home discovery/metrics and occasional API resolution/bootstrap. |

Do not create a replacement Firebase project casually: installed Android applications depend on the existing sender/application relationship. Preserve the existing Google project to retain quota and API configuration. Secure GitHub/Cloudflare/Google/Firebase account recovery methods outside the Home disk and repository.

## Total-loss recovery phases

### 1. Contain and inventory

1. Do not delete/recreate D1, the Durable Object namespace, Worker, VPC Service, tunnel, or frozen KV.
2. Keep every retained scheduled Worker triggerless; never enable RSS/WebSub scheduling.
3. Record without secrets: deployed Worker version, D1 generation/binding, DO binding/migration, VPC/tunnel identity, trigger lists, cloud project identities, and approximate failure time.
4. Confirm the public Worker health endpoint still responds. Home routes may use D1 fallback; authenticated mutations may fail closed.
5. Select the exact production Git commit/tag from verified deployment records, `STATUS.md`, or a GitHub release. Stop if provenance is uncertain.

Expected: cloud resources are preserved and one source revision is selected.

### 2. Prepare a clean host and checkout

Install Git, supported Node.js, Docker Desktop/WSL 2, and PowerShell. Clone and detach at the verified revision:

```powershell
git clone <repository-url> TubePulse
Set-Location TubePulse
git fetch --tags --prune
git checkout --detach <verified-production-tag-or-commit>
git status --short
npm ci
npm --prefix self-host ci
npm run check:workers
npm run check:self-host
```

The tree must be clean. Compare `worker/tubepulse-api/wrangler.toml`, its migrations, and the authority Compose/env templates with the surviving remote resources. Do not create a new D1 database/generation for ordinary host recovery.

### 3. Rotate and install credentials

1. Create the least-privilege Cloudflare tokens described above. Save the deploy token without echoing it:

   ```powershell
   .\self-host\windows\Initialize-CloudflareDeployToken.ps1
   ```

2. Save the replacement tunnel, Firebase, YouTube, and legacy-KV credentials under the ignored `self-host/secrets` filenames in the matrix, with restrictive ACLs.
3. Run:

   ```powershell
   .\self-host\windows\Initialize-HomeAuthority.ps1
   ```

   It creates `.env.authority`, generates the authority HMAC if absent, applies restrictive ACLs, and verifies generated paths are ignored.
4. Load the replacement deploy token into only the current process. From `worker/tubepulse-api`, replace `TUBEPULSE_HOME_AUTHORITY_SECRET` using `wrangler secret put`, piping the generated local file rather than placing the value on the command line. Replace the API Worker's YouTube/Firebase copies only where their documented active paths require them. Do not redeploy Worker source or change bindings during secret-only recovery.
5. Revoke lost tokens/keys/connectors after replacements are installed and verified. Cloudflare login cannot reveal the previous HMAC or other Worker secret values.

Expected: required ignored files exist, no secret appears in output/Git, and Worker/Home share the new HMAC.

### 4. Create an empty standby Home

Keep `.env.authority` at template-safe values: standby mode, remote write/notifications false, trigger confirmation false, activation latch absent, Data API source selected. Create an empty ignored `self-host/data-authority`; never seed it from frozen KV, Preview, pilot, or another Miniflare store.

Start only Home in standby:

```powershell
Set-Location self-host
docker compose --env-file .env.authority -f compose.authority.yaml up --build -d home-authority
docker compose --env-file .env.authority -f compose.authority.yaml ps
Invoke-RestMethod http://127.0.0.1:8789/_tubepulse/status
```

The status must show standby and a stale/unreconciled local authority. Fresh empty state must never be current. Stop cleanly before one-shot reconciliation because both use the local lease:

```powershell
docker compose --env-file .env.authority -f compose.authority.yaml stop home-authority
```

Expected: configuration/image work, but no polling/publication/notification occurs.

### 5. Inspect and resolve coordinator state

Use the checked-in signed status command from the authority Compose environment:

```powershell
docker compose --env-file .env.authority -f compose.authority.yaml run --rm --no-deps home-authority node src/home-authority-cli.mjs status
```

It outputs only redacted replication, lease, transaction, pending-key, backend, and quota state. Require D1 selected/ready on the tracked generation, seeded replication, no live lease after TTL, no transaction, and zero pending keys.

The reconciliation snapshot route automatically attempts stored transaction recovery first. Pending entries are different: they are not yet in D1, so snapshot deliberately returns `409` until they drain. Normal active Home publication drains them, but an empty unreconciled Home cannot be activated merely to do so.

The coordinator implements signed all-pending flush semantics, but the repository currently has no reviewed administrative CLI wrapper for total-loss recovery. If pending keys survive, **stop**. Add a narrow authenticated recovery command around the existing coordinator flush path, review/test its quota, hash-baseline, transaction, and generation behavior, deploy through the normal Worker process, drain, and re-read status. Never delete DO storage, pending records, baselines, or snapshot D1 around the queue. This explicit tooling gap is safer than an invented command.

Expected: transaction recovery complete, lease free, pending exactly zero.

### 6. Reconcile D1 into local state

With standby stopped and coordinator clean:

```powershell
docker compose --env-file .env.authority -f compose.authority.yaml run --rm --no-deps home-authority node src/home-authority-cli.mjs reconcile
```

The command leases a D1 snapshot, installs canonical values locally, computes/verifies exact manifest hash and record count, writes a fresh baseline, activates the matching coordinator manifest, marks local current, and releases leases on success/failure.

Require `ok: true` and `canonicalReset: true`; count alone is not an integrity proof. Re-run signed status, restart Home in standby, and verify local/remote current state, identical manifest/generation, no transaction/lease, and zero pending.

Failure branches:

- busy: wait for real lease TTL; never delete it;
- pending rejection: return to phase 5;
- backend/generation mismatch: reconcile tracked/deployed configuration;
- manifest mismatch: preserve failed local evidence; retry into a fresh empty directory only after diagnosis;
- network/auth error: repair replacement credentials/connectivity without clearing state;
- D1/schema failure: remain standby and preserve the existing Worker/fallback.

### 7. Protect quota and validate credentials

DO D1 row-budget counters survive, but local YouTube counters do not. Remain standby until the first midnight in `America/Los_Angeles` after the loss. If loss time is uncertain, wait through one complete later Pacific boundary and confirm Google quota reset. Never assume zero mid-day usage.

After the boundary:

- make one read-only, one-unit `channels.list` request for a public test channel; log only outcome, never key/user identities;
- in a one-off Home container, parse mounted Firebase JSON and call exported `getGoogleAccessToken`; token acquisition validates credentials without sending FCM, and the token must not be printed;
- re-read signed coordinator/D1 status.

Do not send a real push without explicit authorization.

### 8. Verify exclusive ownership and activate

Use the Cloudflare dashboard or schedules API to inspect every retained scheduled deployment. Every Cron Trigger list must be empty; tracked Wrangler files are not proof of live state.

Then set only:

```dotenv
TUBEPULSE_HOME_SCHEDULER_MODE=active
TUBEPULSE_HOME_SCHEDULER_REMOTE_WRITE_ENABLED=true
TUBEPULSE_HOME_SCHEDULER_NOTIFICATIONS_ENABLED=true
TUBEPULSE_CLOUDFLARE_SCHEDULES_CONFIRMED_DISABLED=true
TUBEPULSE_HOME_SCHEDULER_ACTIVATION_LATCH=CLOUDFLARE_SCHEDULES_CONFIRMED_DISABLED
```

Leave D1 generation, API URL, Data API source, budgets, cadence, and unified-authority latch at verified production values. Start one stack:

```powershell
docker compose --env-file .env.authority -f compose.authority.yaml up -d --force-recreate home-authority cloudflared
docker compose --env-file .env.authority -f compose.authority.yaml ps
Invoke-RestMethod http://127.0.0.1:8789/_tubepulse/status
docker compose --env-file .env.authority -f compose.authority.yaml run --rm --no-deps home-authority node src/home-authority-cli.mjs status
```

Verify local/remote current on the same D1 generation/manifest, one scheduler lease, Data API source, a successful aligned cycle, no unexplained pending/transaction/error, unchanged public Worker health, Home-first authenticated feed matching D1 fallback, safe no-op mutation behavior if an existing inert canary exists, and no unexpected notification.

Notification intent history cannot be reconstructed. Canonical recent/unwatched state prevents wholesale replay, but a lost local `sending` boundary cannot be proven sent/unsent. Accept the bounded possibility of one suppressed or duplicate push around failure; never mass-clear or resend backlog to compensate.

### 9. Install unattended startup

Only after application recovery succeeds, dry-run and install the Scheduled Task described at the top of this document. Reboot-test it during controlled maintenance with public D1 fallback verified first. Confirm Docker starts minimized, the dashboard does not remain foregrounded, Compose is idempotent, and the supervisor records active/current/progress success without exposing data.

## Total-loss failure/rollback table

| Failure | Safe response |
|---|---|
| Public Worker unavailable | Restore existing version/bindings from Cloudflare/GitHub records; do not create a new endpoint. |
| D1 generation/schema missing | Stop; never initialize empty production over it. Verify existing database/migration/binding. |
| DO transaction present | Let checked recovery finish it; preserve journal/deltas if it fails. |
| Pending backup keys present | Do not reconcile/clear. Implement the reviewed signed drain wrapper described above. |
| Manifest mismatch | Stay standby, preserve evidence, diagnose, then repeat exact import. |
| Trigger list nonempty | Stay standby; disable/drain legacy schedules first. Prefer a gap to overlap. |
| YouTube quota day uncertain | Stay standby through a confirmed Pacific reset. |
| Firebase credential invalid | Keep notifications disabled; replace in existing project and validate OAuth only. |
| Tunnel/VPC unavailable | D1 fallback remains; repair existing connector without changing canonical state. |
| Activation errors | Return Home to standby/stop cleanly; keep triggers disabled and D1 selected. Never select frozen KV automatically. |
| Canonical cloud state lost | Account control cannot recreate application data. Stop; do not manufacture an empty baseline. |

## Short total-loss checklist

- [ ] Preserve Worker, D1, DO, VPC, tunnel, and frozen KV resources.
- [ ] Select/validate exact production Git revision.
- [ ] Rotate unrecoverable credentials in existing projects; expose none.
- [ ] Create empty ignored local state; start standby only.
- [ ] Verify D1 generation/coordinator; recover transaction; require pending zero.
- [ ] Run one-shot reconcile; verify exact manifest agreement.
- [ ] Wait through confirmed Pacific quota reset.
- [ ] Validate YouTube/Firebase without a push.
- [ ] Verify all legacy triggers empty.
- [ ] Activate one authority/tunnel stack and verify progress/canonical/public-feed behavior.
- [ ] Dry-run, install, and maintenance-test hidden startup supervision.

## Remaining hardening

The repository now contains bounded host startup supervision, signed status, and exact D1-to-local reconstruction. It still cannot recover lost notification-intent history or YouTube request counters, and it lacks the reviewed all-pending recovery CLI described above. Future work should add that command, always-verify startup manifests, and checksummed/fsynced local state generations. These limitations must fail closed rather than being hidden by retries.
