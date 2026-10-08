# Local operations history

This directory is the local entry point and storage root for TubePulse's aggregate monitoring dashboards.

- Double-click `Open-TubePulse-Operations.cmd`, or run `Open-TubePulse-Operations.ps1`, to start missing monitoring services and open the single-screen wallboard. Its **Diagnostics** link opens the preserved detailed view. The launcher automatically honors ignored `monitoring/.env.local` host overrides; see the monitoring guide for restricted same-LAN Grafana access and kiosk mode.
- Prometheus time series are stored under `prometheus/`.
- Grafana's local state is stored under `grafana/`.
- One aggregate, privacy-safe JSONL snapshot per completed five-minute UTC interval is stored under `snapshots/YYYY-MM-DD.jsonl`.
- Collector restart/cache state is stored under `collector/`.

Everything below this directory is ignored by Git except this README and the two launchers. The generated data must never contain credentials, installation IDs, channel IDs, notification tokens, titles, or content. It is local operational history, not a backup of canonical application state. The default retention is five years or 5 GB for Prometheus, whichever bound is reached first, and three years for readable JSONL snapshots. Grafana state remains bounded by the small provisioned setup but can be removed and recreated from tracked configuration.

See [`../monitoring/README.md`](../monitoring/README.md) for metric definitions, privacy boundaries, commands, and troubleshooting.
