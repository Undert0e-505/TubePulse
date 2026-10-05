# Historical Workers VPC Home canary runbook

> **Historical only:** this records the retired single-device mirror/canary exercise. Current production uses the unified Home authority in `compose.authority.yaml`, Home-first mutations/feeds, and D1 fallback as documented in `README.md`. Do not re-enable this mirror or treat its KV-first flow as a rollback procedure.

The exercise used a remotely managed Cloudflare Tunnel and a Workers VPC Service without creating a public hostname, DNS record, router port-forward, or Cloudflare Access application. The network pattern remains useful context, but the ownership and storage model below is superseded.

Workers VPC is currently a Cloudflare beta. Review the current [Tunnel requirements](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/), [VPC Service configuration](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/), and [binding API](https://developers.cloudflare.com/workers-vpc/api/) before each rollout because names, roles, and limits may change.

```text
unchanged Android app
        |
        v
tubepulse-api.<workers-subdomain>.workers.dev
        |
        | only the configured SHA-256 canary; GET /feed
        v
TUBEPULSE_HOME_VPC binding (VPC Service: tubepulse-home-origin)
        |
        v
named Tunnel: tubepulse-home
        |
        v
cloudflared sidecar -- Docker DNS --> gateway-origin:8788
                                      |
                                      `-- data-gateway (mirror/standby)
```

During this retired phase Cloudflare KV remained canonical and continued polling and FCM delivery. Canary writes executed in Cloudflare first and were then copied to Home; Home did not own scheduling. If Tunnel, VPC, HMAC, freshness, or response validation failed, the Worker returned the existing Cloudflare response. This design could not provide instantaneous two-sided consistency when Cloudflare itself refused a write.

## Fixed local layout

- Compose file: `self-host/compose.gateway.yaml`
- Compose project: `tubepulse-home`
- Origin service: `gateway-origin`
- VPC Service target: hostname `gateway-origin`, HTTP port `8788`
- Loopback-only status: `http://127.0.0.1:8789/_tubepulse/status`
- Persistent mirror: ignored `self-host/data-gateway/`
- Connector token: ignored `self-host/secrets/cloudflared-tunnel-token.txt`
- Tunnel name: `tubepulse-home`
- Production-account tunnel ID: `12a924ab-a238-4f83-8610-26347abb9558`
- VPC Service: `tubepulse-home-origin` (`01a106c3-0990-7410-b88d-08d96a726127`)

The `cloudflared` image is digest-pinned to version 2026.9.3, above the Workers VPC minimum of 2025.7.0. It uses the remotely managed token through a read-only file mount and logs at `info`, never `debug`. Workers VPC requires QUIC/automatic transport, so outbound UDP 7844 must work. There is no inbound Tunnel firewall rule.

## One-time local provisioning

In the Cloudflare account that owns the production API Worker, create a remotely managed tunnel named `tubepulse-home`, choose Docker, and copy the generated connector command. Then run this from the repository root; the script validates the embedded account and tunnel IDs before writing anything:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  .\self-host\windows\Initialize-HomeGateway.ps1 `
  -AccountId <production-account-id> `
  -TunnelId <production-tunnel-id>
```

Beforehand, create `self-host/secrets/cloudflare-read-token.txt` containing a token restricted to Workers KV Storage Read for the one production account/namespace. As a deliberate temporary bootstrap, the initializer can copy the current process's `CLOUDFLARE_API_TOKEN` with `-UseCloudflareApiTokenEnvironment`; runtime write and push flags remain hard-disabled, but replacing it with a read-only token is still required for least privilege.

The initializer never prints secrets. It creates or validates:

- `cloudflared-tunnel-token.txt`
- `gateway-admin-token.txt`
- `gateway-secret.txt`
- existing `canary-device.json` (fingerprint only; no bearer ID)
- `cloudflare-read-token.txt`
- `.env.gateway`

It disables inherited ACLs on those local files and grants access only to the current Windows identity, `SYSTEM`, and local Administrators. Every generated file is Git-ignored.

Start the isolated origin and connector:

```powershell
cd self-host
docker compose --env-file .env.gateway -f compose.gateway.yaml --profile tunnel up --build -d
docker compose --env-file .env.gateway -f compose.gateway.yaml --profile tunnel ps
Invoke-RestMethod http://127.0.0.1:8789/_tubepulse/status
docker compose --env-file .env.gateway -f compose.gateway.yaml logs --tail 100 gateway-origin cloudflared
```

The required status is `mode=mirror`, scheduler `standby`, Cloudflare sync configured, writes/push/takeover false, last pull `ok`, zero conflicts/pending local changes, and the canary profile present. Connector logs must show registered QUIC connections. Never paste raw connector logs without checking for credential-bearing command lines, and never enable debug logging.

Stop without removing mirror data:

```powershell
docker compose --env-file .env.gateway -f compose.gateway.yaml --profile tunnel down
```

## VPC Service and Worker binding

Workers VPC resources are account-scoped. The Tunnel, VPC Service, and `tubepulse-api` Worker must be in the same Cloudflare account. Creating the service requires `Connectivity Directory Admin`; binding it requires `Connectivity Directory Bind` or Admin.

Create one HTTP VPC Service named `tubepulse-home-origin` with:

- Tunnel: the production-account `tubepulse-home`
- Hostname: `gateway-origin`
- HTTP port: `8788`
- Resolver: use the tunnel/default resolver (Docker DNS)

The equivalent Wrangler command is:

```powershell
wrangler vpc service create tubepulse-home-origin --type http `
  --tunnel-id <production-tunnel-id> --hostname gateway-origin --http-port 8788 `
  --cwd worker/tubepulse-api
```

Add the returned service ID to `worker/tubepulse-api/wrangler.toml` only after verifying it:

```toml
[[vpc_services]]
binding = "TUBEPULSE_HOME_VPC"
service_id = "01a106c3-0990-7410-b88d-08d96a726127"
```

The Worker gateway must use these values, with the HMAC secret and full canary fingerprint stored as Worker secrets rather than committed text:

```text
TUBEPULSE_HOME_GATEWAY_TRANSPORT=vpc
TUBEPULSE_HOME_ORIGIN=http://gateway-origin:8788
TUBEPULSE_HOME_GATEWAY_TIMEOUT_MS=1500
TUBEPULSE_HOME_GATEWAY_ENABLED=false
```

Home also needs the exact unchanged Worker URL for signed post-pull recovery:

```text
TUBEPULSE_GATEWAY_RECONCILE_URL=https://tubepulse-api.example.workers.dev/_tubepulse/gateway/reconcile
TUBEPULSE_GATEWAY_RECONCILE_TIMEOUT_SECONDS=10
```

VPC transport still uses the existing HMAC timestamp/request-ID/body/auth-digest protocol. The binding fixes the network target, and Home continues to reject unsigned, expired, replayed, wrong-device, admin, or arbitrary app paths.

The binding fetch uses an absolute `Request` for `http://gateway-origin:8788`;
the VPC Service still controls the actual connection host and port. Keep the
API Worker on a current Workers runtime (`2026-10-01` for the first canary).
Live request-shape validation found that string, `Request`, method, signed
headers, and `AbortSignal` all dispatch, but adding `redirect: "error"` causes
a pre-dispatch `TypeError` in the VPC beta. VPC therefore uses the default
redirect mode while the separately supported public HTTPS transport retains
`redirect: "error"`.

## Canary rollout and rollback

Retired-canary end state: `TUBEPULSE_HOME_GATEWAY_ENABLED=false` and its
separate mirror store was preserved. Its former frequent full pull exceeded the
available Workers KV read budget before normal API traffic. Do not restart that
cadence. Current production uses Home changed-key journaling to D1 instead.

1. Deploy the verified VPC binding and variables with the gateway flag still `false`; feature-off performs no extra KV read or VPC fetch.
2. Confirm the local full pull is current and conflict-free. The Home admin reconciliation operation performs another complete pull and creates a short-lived signed receipt. With the reconcile URL configured, a clean automatic pull submits this receipt itself.
3. For the retired canary path, enable the feature only after reconciliation. Production instead uses the unified all-device authority documented in `README.md`.
4. Confirm the configured automatic pull submitted the fresh receipt to `POST /_tubepulse/gateway/reconcile`; use the authenticated manual receipt workflow only when automatic submission is not configured. Then test the existing production app without changing its endpoint or APK.
5. Tail privacy-safe Worker logs. The canary should report `outcome=home`; non-canaries never enter the Home path. Force a brief connector interruption and verify `outcome=cloudflare-fallback` before restoring it.
6. On any regression, immediately set `TUBEPULSE_HOME_GATEWAY_ENABLED=false` and deploy the API Worker. The VPC binding and connector may remain present while routing is disabled.

The retired gateway wrote its canary state only on stale/current transitions. It did not add polling or per-request KV writes. Home refused signed app operations while a mirror pull was active; a canonical mutation that overlapped that pull could therefore turn the canary stale temporarily. The signed shadow request marked that snapshot as overlapped, a fresh pull proved parity, and only then could Home restore `current`. A real conflict remained blocked.

The first production canary completed this sequence on 2026-10-04 before the
route and connector were deliberately disabled. A real
register/add-channel operation that overlapped a pull first failed closed as
designed. The repaired mirror resolves only the replay-generated
`lastSeenAt`-only profile difference and the first-subscribe channel metadata
race where valid `addedAt` timestamps are the sole difference. It then proves
an exact snapshot with zero conflicts and zero pending records before restoring the
marker with a signed receipt. The Home response was byte-identical to the
canonical Cloudflare response, a non-canary generated no Home request, and
stopping only the connector produced a privacy-safe `destination_unavailable`
fallback before four QUIC connections and Home routing recovered. These
checks validate one canary, not general rollout readiness; leave the selector
at one fingerprint.

A later real subscription swap on 2026-10-04 exposed the corresponding
first-subscribe metadata race: both origins created the same channel metadata,
but their numeric `addedAt` values differed by milliseconds. The narrow
schema resolver selected the Cloudflare record only after proving every other
field and key identical. One clean pull resolved that sole conflict, signed
reconciliation restored `current`, and two subsequent automatic pulls remained
at zero conflicts and zero pending records. A controlled connector stop again
returned the byte-identical Cloudflare feed before four QUIC
connections and Home routing recovered.

## Recovery and rotation

- Lost/compromised Tunnel token: rotate it in Cloudflare, copy the new Docker command, stop the sidecar, rerun the initializer with `-RotateConnectorToken` and the same account/tunnel IDs, and recreate only `cloudflared`. The previous local token is retained as an ignored timestamped backup until the operator removes it securely.
- Stale Home: leave reads on Cloudflare. A configured gateway origin automatically submits a signed receipt after a fresh, non-overlapped, conflict-free pull; otherwise use the authenticated manual receipt workflow. Never clear stale merely because one later mutation succeeds.
- Local rebuild: preserve `data-gateway/` and ignored secrets; rebuild `gateway-origin` from the repository version being deployed.
- Tunnel unavailable: no public route opens and app traffic falls back to Cloudflare. No router or inbound firewall change is part of this design.
