# TubePulse v4.1.0

TubePulse v4.1.0 adds local, temporary notification silencing and a secure update indicator while
preserving delivery, unseen state and compatibility with existing installations.

## Notification sound controls

- Silence a channel for one or eight hours, or mute all TubePulse sound, directly from an expanded
  notification. Notifications continue to arrive and remain visible; only their audible/intrusive
  presentation changes on that Android device.
- Notification actions adapt to current state with **Unmute channel** and **Unmute all**. Under
  global mute, an individual channel can remain audible while every other channel stays silent.
- The app feed shows active local silence clearly, including timed expiry, channel recovery and the global
  **Unmute all** control. Local silence is separate from server-side do-not-disturb and creates no
  cloud state or writes.

## Reliable actionable notifications

- New clients render high-priority notification data locally so actions work in foreground,
  background and terminated states. Action state is saved before the acted notification is
  dismissed, and mute actions never navigate or mark content seen.
- Capability-gated delivery keeps existing released clients on the previous notification payload
  behavior until they upgrade.
- Notification rendering, feed/widget refresh and host visibility checks retain their existing
  durability and fail-safe behavior.

## Updates

- Settings now shows an animated **Update available** indicator when a newer stable TubePulse
  GitHub release is available and opens the exact validated release page.
- The check is cached, rate-limited, uses conditional requests and does not collect installation,
  channel or usage data.

## Installation

Download `TubePulse-v4.1.0.apk` and install it over the existing TubePulse app. The Android package
and signing identity are unchanged, so existing channels, settings and local state are retained.

Cloudflare Worker and host deployment remain operationally separate from this APK release.
