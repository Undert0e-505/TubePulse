# Managed Home deployment

Production boot is separate from development. Ordinary Windows startup reads the ignored managed manifest at `logs/deployments/production/current.json`; it never builds an image and never reads a Compose file, Prometheus rule, or Grafana provisioning file from the mutable working tree.

The promoted manifest pins the exact Home, collector, Prometheus, and Grafana image IDs; immutable Home and monitoring Compose files; an immutable copy of Prometheus rules and Grafana provisioning; bundle and Compose hashes; the source commit/content-tree/dirty flag; the test-evidence hash; and the Grafana bind address.

Both launchers validate the bundle and local image IDs, run `up -d --no-build --pull never`, and verify the running image IDs. Monitoring also verifies that its `/etc` mounts come from the promoted bundle. Missing or modified bundles, unavailable images, moved tags, or running mismatches fail closed. Prometheus history and Grafana data remain in `logs/prometheus` and `logs/grafana` across promotion and rollback.

## Candidate and promotion

Run the full worker, Home, community-parser, and monitoring checks first. Store aggregate-only JSON evidence with `passed: true` and the exact commands. Build candidate images explicitly, then assemble and atomically promote them:

```powershell
node scripts/manage-production-deployment.mjs assemble `
  --id <utc-version> `
  --home-image <tested-home-image> `
  --collector-image <tested-collector-image> `
  --evidence <test-evidence.json> `
  --promote
```

Assembly does not require a clean Git tree, because recovery previews may need production validation before commit. It records the dirty flag and hashes the actual source files. Promotion writes a new immutable bundle, atomically replaces `current.json`, archives the manifest under `history/`, and retains the former manifest as `previous.json`.

After promotion, use the normal launchers. Validate public/local status, Home feed routing, queues, metrics, alerts, and four settled five-minute cycles before accepting the candidate.

## Rollback

The previous bundle and image tags are retained. Swap the manifests atomically, then run the normal launchers:

```powershell
node scripts/manage-production-deployment.mjs rollback
powershell.exe -NoProfile -ExecutionPolicy Bypass -File self-host/windows/Start-HomeAuthority.ps1 -InitialDelaySeconds 0
powershell.exe -NoProfile -ExecutionPolicy Bypass -File monitoring/windows/Start-TubePulseMonitoring.ps1 -NoOpen -WaitSeconds 0
```

Rollback never deletes authority data, Prometheus history, Grafana data, snapshots, or the rejected bundle. If canonical state may have changed, retain the current Home data and follow the exact D1 reconciliation procedure in [`self-host/RECOVERY.md`](self-host/RECOVERY.md). Never treat a corrupt local KV blob as a valid durability generation.
