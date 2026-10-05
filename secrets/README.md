# TubePulse credential handling

Secret files are ignored and must never be committed. They are installation material, not a recoverable source of truth. If the Home disk is lost, recreate/rotate credentials through the existing Cloudflare, Google Cloud, and Firebase accounts by following [`self-host/RECOVERY.md`](../self-host/RECOVERY.md).

Cloudflare dashboards and APIs do not reveal existing Worker secret values. Account access can confirm a secret name exists, but a lost value must be replaced.

## Root developer/deployment files

| File | Purpose |
|---|---|
| `cloudflare.env` | Manual Wrangler account/deploy authentication. Use a least-privilege token. |
| `youtube.env` | YouTube Data API key used when updating the API Worker's resolver/bootstrap secret. |
| `fcm-service-account.json` | Firebase Admin JSON used when updating a Worker that genuinely needs FCM. |

The active unified Home uses separately mounted ignored files under `self-host/secrets`:

| File | Purpose |
|---|---|
| `authority-secret.txt` | HMAC shared with the API Worker's write-only `TUBEPULSE_HOME_AUTHORITY_SECRET`. |
| `cloudflared-tunnel-token.txt` | Connector token for the existing Cloudflare Tunnel. |
| `firebase.json` | Firebase Admin credential for active Home notifications. |
| `youtube-api-key.txt` | YouTube Data API key for active Home discovery/metrics. |
| `cloudflare-scheduler-write-token.txt` | Historical compatibility/KV tooling token; active D1 publication does not use it. Scope narrowly. |
| `cloudflare-authority-deploy-token.txt` | Optional manual Wrangler deployment/secret-management token; never mounted into Home. |

`Initialize-HomeAuthority.ps1` creates a new authority secret when missing, validates the other Home files, writes ignored `.env.authority`, applies restrictive ACLs, and verifies Git ignores each path. `Initialize-CloudflareDeployToken.ps1` accepts a token from the clipboard, writes it with restrictive ACLs, and clears the clipboard without echoing the value.

## Loading root secrets for Wrangler

On a compatible shell:

```bash
source secrets/load-secrets.sh
```

This loads root deployment variables and generates ignored per-worker `.dev.vars`. Do not use a broad deployment token for Home runtime access.

To update only a Worker that needs the API/Firebase copies:

```bash
./secrets/set-worker-secrets.sh tubepulse-api
```

The active Home owns discovery and notification delivery. Retained scheduled Workers are triggerless rollback artifacts and should receive credentials only before an explicitly authorized, reconciled rollback.

## Rotation and loss

- **Authority HMAC:** generate a new local value and replace the API Worker secret with the exact same value. The old Worker value cannot be read back.
- **Tunnel:** rotate the connector token on the existing tunnel; do not create a competing tunnel casually.
- **Cloudflare API tokens:** revoke/recreate with the narrow permissions needed for the specific manual operation.
- **YouTube:** create/restrict a replacement key in the existing Google Cloud project with YouTube Data API v3 enabled, then revoke the lost key.
- **Firebase:** generate a new Admin key in the existing Firebase project, validate OAuth without sending a push, then revoke the lost key. Preserve the project so installed Android apps remain compatible.

Never print secrets for comparison. Never store account recovery codes in this directory or solely on the Home disk. Secure GitHub/Cloudflare/Google/Firebase account recovery separately.

## Security checks

- Confirm secret paths are ignored with `git check-ignore --no-index`.
- Restrict Windows ACLs or POSIX modes to the service/operator identity and administrators.
- Before commit, inspect staged paths and scan added text for tokens, private keys, bearer headers, service-account fields, and generated `.env`/APK/runtime data.
- If a secret is ever committed or logged, revoke it immediately; deleting the file from the latest commit is not sufficient.
