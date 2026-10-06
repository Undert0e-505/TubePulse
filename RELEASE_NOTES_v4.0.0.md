# TubePulse v4.0.0

TubePulse v4.0.0 improves notification handling, channel presentation, backend scale, and recovery while keeping the existing Android package and public Cloudflare endpoint.

## App

- Added optional automatic newest-first channel ordering across the app and widget without overwriting the saved manual order.
- Updated the widget to show exactly one item per channel: the newest published video or community post, regardless of whether it has already been seen.
- Corrected notification taps so a single-video notification follows the configured video-or-channel action, while stacked channel notifications open the channel.
- Notification taps optimistically mark the exact affected content as seen. Failed remote persistence is queued durably and retried silently without blocking navigation or clearing content that arrived later.
- Improved per-channel notification controls, including reliable independent DND start/end rollers and persistence.

## Scalable backend

- Active video discovery now runs in the hosted YouTube Data API poller instead of routine RSS polling.
- Channel detection and video statistics use batches of up to 50 IDs. Upload playlists are reconciled only when channel state changes or a bounded safety pass is due, and routine discovery does not use `search.list`.
- Fast and slow polling are separated, and frequent metric refreshes are limited to the app-visible recent videos. A promoted item becomes eligible immediately without replaying an old notification.
- The Cloudflare Worker remains the public edge/API. The hosted authority is coordinated through Durable Objects, with D1 providing the canonical cloud backup and read fallback.
- Structural changes publish immediately, while metric observations are coalesced. Comment counts are retained locally for future activity features, but comment-only movement does not trigger a cloud write.

## Reliability and recovery

- Added bounded lease-conflict retry/backoff, verified pending-journal draining, and exact D1 reconciliation so a transient coordinator conflict cannot strand the hosted authority in a stale state.
- Added an unattended Windows startup supervisor with lock protection and readiness/progress checks for recovery after login, Docker startup, and temporary network interruption.
- Expanded the disaster-recovery runbook for rebuilding a replacement host from GitHub, D1/Durable Object state, and the existing Cloudflare, Google, and Firebase projects after complete local disk loss.

## Installation

Download `TubePulse-v4.0.0.apk`, transfer it to the Android device, allow installation from the selected file source if prompted, and install it over the existing TubePulse app.

Cloudflare Worker deployments are operationally separate from this APK release.
