# Security: API Keys & Secret Scanning

## Worker-side YouTube/InnerTube API key

The old `tubepulse-cron/index.js` (pre-shard, commit `34cd060`) contained a
hardcoded `INNERTUBE_KEY` constant. This was the YouTube web client InnerTube
key — a public identifier used by the YouTube web frontend, not a server-side
secret. It was removed from current code when the cron worker was reverted
(commit `fe0e20b`) and subsequently replaced with the no-op stub (commit
`a13efd2`).

**Current state:** No tracked worker source contains any hardcoded Google API
key. All workers read `env.YOUTUBE_API_KEY` from Cloudflare Workers secret
manager (set via `wrangler secret put`). The stub
`worker/tubepulse-cron/index.js` is 14 lines with no key material.

**Git history:** The key remains in git history at commit `34cd060`. GitHub
secret scanning alert #2 references this historical blob. We are not rewriting
history; the alert should be closed as "used in tests" / "false positive" since
the key was a public web client identifier and is no longer in current code.

## Android `google-services.json`

The file `android/app/google-services.json` contains a Firebase Android app
API key (`current_key` field). This is a **Firebase client configuration key**,
not a server-side secret. Google's own documentation explicitly states this
key is safe to include in client-side code:

> "These keys are safe to include in your client code. Google restricts API key
> usage by application package name and SHA-1 certificate fingerprint, so even
> if someone obtains your key, they can't use it from an unauthorized app."

— [Firebase documentation](https://firebase.google.com/docs/projects/api-keys)

**Required for build:** `app.json` references `./google-services.json` in both
`android.googleServicesFile` and the `@react-native-firebase/app` plugin config.
Removing the file would break fresh clones and CI builds.

**GitHub secret scanning alert #1** flags this key. Since it is a Firebase
client config key (by design public, restricted by package name/certificate),
the alert is a false positive for a server-side secret.

## `.gitignore` coverage

The `.gitignore` covers:
- `/secrets/` and `**/secrets/` — all local credential files
- `secrets/*.env`, `secrets/*.json`, `secrets/*.key`, `secrets/*.pem`
- `.dev.vars` and `worker/*/.dev.vars` — wrangler local secrets
- `worker/*/.wrangler/` — local wrangler state
- `google-services.json` / `GoogleService-Info.plist` — listed but the Android
  file is still tracked (committed before the rule was added; kept for build
  compatibility)

## Recommended Google Cloud restrictions (not yet applied)

Since we are not rotating either key:

### Worker YouTube Data API key

- [ ] Restrict to **YouTube Data API v3** only (API restriction)
- [ ] Application restrictions: not practical for Cloudflare Workers (no stable
      IP/referrer). Rely on API restriction + quota/billing alerts instead
- [ ] Set quota/usage alerts in Google Cloud Console

### Firebase Android key

- [ ] Add **Android application restriction**: package name `com.tubepulse.app`
- [ ] Add **SHA-1 certificate fingerprint** for the signing cert(s)
- [ ] Add **SHA-256 certificate fingerprint** if applicable
- [ ] Restrict to **required Firebase APIs only** (API restriction)

> Do not apply console changes that could break production without confirming
> with the project owner first.

## Self-host preview

The optional [`self-host/`](self-host/) runtime introduces local operational secrets and state. Its `.env`, `data/`, and `secrets/` paths are ignored by Git. Operators should run it under a dedicated low-privilege account and restrict filesystem access to:

- the admin bearer token;
- the Firebase service-account JSON;
- the scoped Cloudflare KV API token;
- the local data directory, which can contain device identifiers, channel state, and FCM registration tokens.

Prefer the supported `_FILE` variables over multiline or shell-visible values. Cloudflare pull-only operation needs a namespace-scoped Workers KV Storage Read token. Remote push requires an Edit token plus the independent `TUBEPULSE_CLOUDFLARE_WRITE_ENABLED=true` safety switch; automatic push is off by default.

The public self-host status endpoint omits secret values, filesystem paths, conflict keys, device/channel identifiers, and raw upstream error bodies. Mutating admin endpoints fail closed when `TUBEPULSE_ADMIN_TOKEN` is absent and compare bearer tokens in constant time. Bind to `127.0.0.1` unless a firewall or authenticated TLS tunnel intentionally publishes the service.

Client fallback URLs are Expo public build-time configuration, not secrets. The `X-TubePulse-Failover` header is likewise only a signal. Optional automatic takeover additionally requires a successful app route for an unchanged device profile whose hash is represented in the durable Cloudflare sync baseline; new local registration alone cannot activate standby scheduling.

The Settings update indicator makes a public, unauthenticated request to GitHub's releases API at
most once per 12 hours per installation. It sends no TubePulse device ID, FCM token, channel list or
backend credential. Responses are size/time bounded and fail closed unless a stable tag and exact
repository release URL validate. ETags and dismissed tags are stored only in app-local storage.

The former single-device canary gateway is disabled. Production uses the fail-closed unified Home authority: all app traffic still enters the existing Cloudflare API, authenticated feeds reach the single local store only through the private VPC binding, and the same HMAC protocol protects exact mutation preflight/commit traffic. Signed requests bind timestamp, one-time request ID, operation, method, path/query, authorization digest, and body digest; replay, expiry, unknown routes, oversized bodies, and divergent baselines are rejected. The local listener exposes only loopback status plus signed authority paths, while the digest-pinned Tunnel sidecar publishes no host port. Secrets remain in ignored ACL-restricted files and encrypted Worker configuration; logs must never contain bearers, authorization headers, Tunnel tokens, FCM tokens, or snapshot values. A global stale transition stops Home publication/notification and makes the API fall back to Cloudflare reads until a fresh exact reconciliation succeeds. WebSub is acknowledged but suppressed while Home owns detection, preventing a second notification writer.

### LAN and local Android test controls

Docker Compose publishes the API on loopback unless `TUBEPULSE_PUBLISH_ADDRESS=0.0.0.0` is set explicitly. A LAN deployment should use a Windows **Private** network and an inbound rule limited to TCP 8788 from `LocalSubnet`; never add an Any-profile/Any-remote rule for convenience. Plain HTTP is suitable only on a trusted local network. Use TLS (for example, a narrowly routed tunnel) before crossing the public internet.

The side-by-side `selfhost` APK permits cleartext traffic only through its source-set manifest. The production/main manifest has no such opt-in. The APK is debuggable and signed with the Android debug key, so it is a test artifact, not a release candidate, and must not be distributed as a production build.

`scripts/Build-SelfHostApk.ps1` creates and removes an ignored variant Firebase config during the build. Rewriting the non-secret client package metadata does not register a new Firebase app; the Preview pilot deliberately sends a null token. Register `com.tubepulse.app.selfhost` separately in Firebase and explicitly enable Preview push before relying on delivery; do not loosen the production app's package/certificate restrictions. The ignored APK output, generated Firebase file, self-host data, `.env`, and copied secret files must remain outside Git.
