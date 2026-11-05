# TubePulse v4.5.0

## Back up or move your TubePulse setup

- **Export channels** creates a readable `.tubepulse` backup containing your ordered channel list, supported global settings, per-channel overrides and current mute state.
- **Import channels** uses Android's file picker and shows the result before anything changes. Choose **Merge** to keep the current setup and add only missing channels, or **Replace** to make the imported list and order authoritative after a clear removal-count confirmation.
- A simple text file of YouTube `@handles` can also be imported. TubePulse ignores blank lines, accepts comma-separated handles and treats lines beginning with `#` as comments.
- Imports validate and deduplicate channels first. New subscriptions are added before a Replace import removes anything, and imported additions are seeded silently so old videos and posts do not produce a historical notification flood.

Backups are suitable for a reinstall, device transfer, clean rebuild or manual safety copy. This is a local file transfer rather than a TubePulse account or automatic cloud sync.

## A clear privacy boundary

The backup contains only transferable configuration. It does not include the installation ID, Firebase push token, credentials, service endpoints, seen or notification history, or cached videos, posts and metrics.

## Reliability

Recent backend capacity and write-coalescing work preserves notification behaviour while reducing operational load.

## Install

Download `TubePulse-v4.5.0.apk` from this release and install it over the existing app. Android should retain the current channels, settings and local state.
