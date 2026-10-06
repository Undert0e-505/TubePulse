# TubePulse aggregate operations monitoring

This stack provides a ready-made, localhost-only TubePulse operations dashboard. It is observability, not part of the app request path: failure of the collector, Prometheus, or Grafana must never stop, restart, disable, or mark the production authority stale.

## Components and URLs

| Component | Local URL | Purpose |
|---|---|---|
| Grafana | <http://127.0.0.1:3000/d/tubepulse-operations/tubepulse-operations> | Provisioned `TubePulse Operations` dashboard and default landing page |
| Prometheus | <http://127.0.0.1:9090> | Scrapes aggregate gauges every 30 seconds and retains local trends |
| Collector | <http://127.0.0.1:9464/health> and `/metrics` | Samples the host and Cloudflare every five minutes |

By default, all published ports are explicitly bound to `127.0.0.1`. Grafana permits anonymous **Viewer** access so opening the dashboard requires no stored dashboard password. Do not change the port bindings to a LAN/public address without a restrictive host firewall.

The tracked default remains loopback-only. A host may opt Grafana alone into same-LAN access with ignored `monitoring/.env.local` configuration and the tracked, Private-profile Windows Firewall helper described below. Prometheus, the collector, and the authority stay loopback-only. Anonymous viewers can see aggregate operational data but cannot edit dashboards; no record identifiers or credentials are exposed by this stack.

The tracked Compose file pins explicit Prometheus, Grafana, and Node image versions and digests. Services use `restart: unless-stopped`, bounded Docker JSON logs, and a separate Compose project. The monitoring network joins the existing private authority network only so the collector can reach the aggregate endpoint. Monitoring has no authority credentials and cannot mutate application state.

## Start, stop, and status

The easiest operator path is the tracked launcher under `logs/`:

```powershell
.\logs\Open-TubePulse-Operations.ps1
```

It checks Docker, creates ignored data directories, applies `monitoring/compose.yaml`, waits for Grafana when requested, and opens the dashboard. A non-opening startup suitable for supervision is:

```powershell
.\monitoring\windows\Start-TubePulseMonitoring.ps1 -NoOpen
docker compose -f .\monitoring\compose.yaml ps
Invoke-RestMethod http://127.0.0.1:9464/health
Invoke-RestMethod http://127.0.0.1:9090/-/ready
Invoke-RestMethod http://127.0.0.1:3000/api/health
```

Stop monitoring without touching the authority:

```powershell
docker compose -f .\monitoring\compose.yaml down
```

Do not add `-v`: bind-mounted history lives under `logs/`, but volume deletion flags are unnecessary and make operator intent less clear. Starting the authority through the existing Windows supervisor requests monitoring startup asynchronously after authority readiness succeeds. Any monitoring error is caught/logged and cannot change the authority result.

## Optional same-LAN Grafana access

LAN access is a host-specific opt-in. The active connection must already be a Windows **Private** network; the helper refuses to change its category. Create ignored local configuration:

```powershell
Copy-Item .\monitoring\.env.local.example .\monitoring\.env.local
# In .env.local set TUBEPULSE_MONITORING_GRAFANA_BIND_ADDRESS=0.0.0.0
```

Then install the narrow firewall rule from an Administrator PowerShell window and restart monitoring through the ordinary launcher:

```powershell
.\monitoring\windows\Manage-TubePulseGrafanaLanAccess.ps1 -Mode Install
.\monitoring\windows\Start-TubePulseMonitoring.ps1 -NoOpen
.\monitoring\windows\Manage-TubePulseGrafanaLanAccess.ps1 -Mode Inspect
```

The firewall rule allows inbound TCP port 3000 only on the active physical LAN interface, only for the Private profile, and only from `LocalSubnet`. It creates no Public or Domain rule. The inspection output includes the current phone URL. Because DHCP can change the host address, reserve the host's address in the router for a durable bookmark, or rerun inspection after an address change. `0.0.0.0` is used only so Docker's published Grafana port survives DHCP; Windows Firewall supplies the network boundary.

To disable LAN access, remove the rule from an Administrator PowerShell window, delete the ignored override, and reapply monitoring:

```powershell
.\monitoring\windows\Manage-TubePulseGrafanaLanAccess.ps1 -Mode Remove
Remove-Item .\monitoring\.env.local
.\monitoring\windows\Start-TubePulseMonitoring.ps1 -NoOpen
```

Localhost access continues after removal. Never forward port 3000 from the router, expose it on a guest/public Wi-Fi profile, or publish ports 9090, 9464, or 8789.

## Credential and privacy boundary

The collector mounts only the ignored `self-host/secrets/cloudflare-read-token.txt` file, read-only. Its token needs **Account Analytics Read** and no edit/deploy/D1-write permission. It must never be replaced with a scheduler or deploy token. Account and database identifiers are configuration inputs, not metric labels or snapshot fields.

The host exposes `GET /_tubepulse/monitoring` only through its loopback/private Docker surfaces. It scans the local canonical namespace with bounded concurrency and returns counts/distributions only. It never returns installation IDs, channel IDs, FCM tokens, handles, titles, descriptions, video/post IDs, or record contents. App versions are restricted to a short safe character set before becoming Prometheus labels. Cloudflare errors are reduced to bounded categories; response bodies and token text are never logged.

Readable snapshots and Prometheus metrics contain only:

- registered, new, active, and push-capable installation counts;
- aggregate app-version counts;
- active-channel counts; configured device-side and inverse subscriber-index membership totals; anonymous directional/index-integrity counts; and mean/p50/p95/max/zero-channel distribution;
- host readiness/current state, scheduler progress/outcome, sweep state, and YouTube quota/failure/freshness;
- aggregate notification delivery outcomes plus durable pending/callback/failure intent counts;
- D1 coordinator readiness, pending/transaction/lease booleans, conservative row estimates and limits;
- per-TubePulse-script Cloudflare Worker request/error/subrequest and CPU aggregates;
- D1 read/write query, rows read/written, response-byte and storage aggregates;
- verified Durable Object invocation, SQL/storage-unit, row, duration, and storage aggregates.

No per-install or per-channel drill-down exists by design.

## Collection and retention semantics

The collector aligns to five-minute UTC intervals. Cloudflare windows are delayed by ten minutes so each stored window is finalized and non-overlapping. UTC-day values are cumulative samples used for current-day budgets and are not summed as independent windows. The collector appends at most one JSONL record for an interval, persists restart state atomically, and scans the current daily file before append to prevent duplicates after an interrupted restart.

If one source fails, its last good values remain available while `collection_success` and source-specific freshness/error metrics turn unhealthy. A failed query never replaces the cache with zeros. Cloudflare GraphQL analytics are delayed, sampled/approximate operational data—not authoritative billing records.

Prometheus retains up to five years, capped at 5 GB. JSONL daily snapshots retain 1,095 days by default. These bounds are configurable in `monitoring/compose.yaml`. Total disk growth is therefore bounded, but an operator should still monitor free disk. Grafana dashboards/datasources are provisioned from Git; its local database holds only UI state.

Historical monitoring data is intentionally ignored and local. It is lost with the disk unless copied separately; this does not affect D1 canonical recovery. A replacement host recreates the stack from Git and begins a new history after the authority is restored.

## Dashboard and guardrails

The provisioned dashboard defaults to 24 hours and supports 7-day, 30-day, and custom ranges. It includes freshness/health, install and version aggregates, subscription distributions and index integrity, per-script Worker activity (including unexpected legacy traffic), D1/DO activity and storage, internal row estimates, YouTube quotas, scheduler freshness, and notification outcomes. Configured subscriptions are membership relationships read from `device:*:channels`; indexed subscriptions are the reverse relationships in `channel:*:subscribers`. Either total can legitimately exceed the unique active-channel count. The integrity panel compares the two directions and the `channels:active`/profile invariants without exposing the underlying identifiers. Persistent nonzero drift alerts after 15 minutes; monitoring never repairs canonical state.

Default external-plan guide values are configurable and currently represent the documented free-plan guardrails: 100,000 D1 rows written/day, 5,000,000 D1 rows read/day, and 100,000 Worker requests/day. Paid-plan accounts must override these values to match their contract. The dashboard separately displays the stricter coordinator safety caps. D1 batching improves atomicity and latency but does not reduce per-row billing. End-of-day write projection clamps its divisor during the first UTC hour to avoid an unstable early extrapolation.

Official references:

- [Cloudflare GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/)
- [Workers Analytics Engine and Workers observability](https://developers.cloudflare.com/workers/observability/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Objects metrics and analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)

## Troubleshooting

1. Run the launcher with `-DryRun` to verify paths and token presence without host mutation.
2. Check `docker compose -f monitoring/compose.yaml ps` and each local health URL above.
3. Check bounded container logs with `docker compose -f monitoring/compose.yaml logs --tail 100 collector prometheus grafana`. Never paste raw credentials into commands.
4. A stale Cloudflare panel can be ordinary analytics delay; compare collector source-success and last-success age before acting.
5. If the authority aggregate endpoint is unavailable, repair authority readiness independently. Repeatedly restarting monitoring cannot repair canonical state.
6. If Grafana state is damaged, preserve `logs/grafana` for diagnosis before recreating it. Prometheus and JSONL history are independent directories.
