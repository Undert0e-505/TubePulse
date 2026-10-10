# TubePulse v4.2.0

TubePulse v4.2.0 makes notification-service health visible in the app and adds YouTube comment totals
to video rows without increasing comment-driven cloud writes.

## Service status in Settings

- Settings now starts with a compact, one-line service status showing whether notifications are
  operating normally, may be delayed, are unavailable, or cannot currently be checked.
- The row includes a concise freshness time, keeps its normal quiet Settings surface in every state,
  and stays blank while the first status is loading.
- Status comes from the active notification authority through a privacy-safe public route. It exposes
  no devices, channels, queues, infrastructure details, or operator diagnostics, and an unprovable
  check is shown as unavailable rather than declaring a false outage.

## Comment totals at a glance

- Home and the Android widget now show each video's available public comment total immediately beside
  its like count, using the same compact number formatting and a matching outline icon.
- Explicit zero is shown as `0`; hidden or unavailable totals are omitted.
- Comment totals continue to come from the existing official YouTube statistics collection. Comment-only
  movement does not trigger canonical publication, D1/Cloudflare writes, notifications, or faster
  adaptive polling. The displayed value advances when that video is otherwise published or refreshed,
  including the existing periodic refresh policy.

## Installation

Download `TubePulse-v4.2.0.apk` and install it over the existing TubePulse app. The Android package
and signing identity are unchanged, so existing channels, settings and local state are retained.

The notification host and public status route are deployed separately from the APK release.
