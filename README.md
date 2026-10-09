# TubePulse

**Follow the YouTube channels you choose, without losing new uploads in the noise.**

TubePulse is an open-source Android app that brings videos and community posts from selected
YouTube channels into a focused feed, widget and configurable notification flow.

[![Latest release](https://img.shields.io/github/v/release/Undert0e-505/TubePulse)](https://github.com/Undert0e-505/TubePulse/releases/latest)
[![Android](https://img.shields.io/badge/platform-Android-3DDC84.svg)](https://github.com/Undert0e-505/TubePulse/releases/latest)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Download the latest release](https://github.com/Undert0e-505/TubePulse/releases/latest) ·
[What’s new in v4.1.0](RELEASE_NOTES_v4.1.0.md) · [User guide](docs/USER_GUIDE.md)

## See your channels at a glance

| Home feed | Channels | Settings |
| :---: | :---: | :---: |
| [<img src="docs/screenshots/home-feed.jpg" width="250" alt="TubePulse Home feed showing recent videos and community posts">](docs/screenshots/home-feed.jpg) | [<img src="docs/screenshots/channel-list.jpg" width="250" alt="TubePulse Channels screen for adding, removing and ordering channels">](docs/screenshots/channel-list.jpg) | [<img src="docs/screenshots/settings.jpg" width="250" alt="TubePulse notification and content settings">](docs/screenshots/settings.jpg) |

## Notifications on your terms

Choose a quiet Chill reminder or a more persistent Relentless schedule, set do-not-disturb hours,
and override individual channels when one creator needs different treatment. Scheduled livestreams
can warn you ahead of time, while stacked alerts open the channel without marking later arrivals
seen. Upload alerts follow the same five-minute detection clock; near a scheduled livestream's
published start, the host checks its public state more frequently for a prompt live transition.
One unseen item produces one alert, while two or three produce one exact channel bundle rather than
separate notifications.

## A feed and widget without recommendations

The Home feed keeps the recent content from your selected channels together. The widget puts each
displayed channel's newest cached video or community post on the Android home screen, retaining its
seen or unseen state. Manual ordering stays yours even when automatic newest-first display is on.

## What TubePulse does

- Tracks channels added by YouTube handle or channel ID.
- Sends notifications for new uploads and, when enabled, community posts.
- Offers Chill or Relentless reminders, quiet hours, livestream prewarnings and per-channel
  overrides.
- Routes a notification tap to the video or channel according to your setting; stacked
  notifications open the channel and mark only their bundled content seen.
- Shows videos and posts in a dark, recommendation-free Home feed with clear unseen markers.
- Keeps failed seen-state updates in a silent local retry queue, so opening YouTube never waits on
  the network and blue dots do not return unexpectedly.
- Supports saved manual channel order or automatic newest-first ordering across the app and widget.
- Provides an Android home-screen widget with the newest published video or post for each displayed
  channel.

See the [user guide](docs/USER_GUIDE.md) for settings, channel controls, notification behavior and
widget details.

## How it works

The Android app talks to a Cloudflare Worker that provides TubePulse's public API. A private
production host polls YouTube, owns scheduled processing and sends eligible notifications through
Firebase Cloud Messaging. Cloudflare D1 holds a coordinated cloud backup and read fallback when
the host cannot serve a current feed.

The host uses the official YouTube Data API for video discovery and statistics. Community-post
support uses an unofficial YouTube web surface and may need maintenance when YouTube changes it.
Detailed component, storage and recovery behavior lives in the
[architecture specification](ARCHITECTURE.md), not this landing page.

## Get started

1. Download the signed APK from the [latest release](https://github.com/Undert0e-505/TubePulse/releases/latest).
2. Install it on an Android device and allow notifications if you want push alerts.
3. Open **Channels** to add or remove creators and choose manual or automatic ordering.
4. Open **Settings** to choose tap behavior, reminder style, quiet hours, livestream prewarning and
   whether community posts appear.
5. Use the Home feed or add the TubePulse widget to the Android home screen.

Existing installations can install a newer signed release over the current app. Each device keeps
its own channel list and settings; TubePulse does not provide cross-device sync.

## Privacy and limitations

- TubePulse is Android-only and does not require a TubePulse user account.
- The service registers a pseudonymous installation identifier and, when notifications are
  permitted, a Firebase push token. These are required for per-device subscriptions and delivery.
- Operational monitoring is aggregate-only. It is designed not to expose installation or channel
  identifiers, push tokens, titles or content.
- Community posts are distinct from YouTube comments. Post detection depends on an unofficial web
  surface; comment counts may be observed by the host but comments are not shown in the app.
- Push delivery, Android background behavior, YouTube availability and network connectivity can
  delay updates.
- TubePulse is not affiliated with, endorsed by or sponsored by YouTube or Google.

See [SECURITY.md](SECURITY.md) for security reporting and the
[Worker contracts](worker/CONTRACTS.md) for the precise service data boundary.

## Documentation

- [User guide](docs/USER_GUIDE.md) — installation, channels, feed, notifications, settings and widget
- [Project status](STATUS.md) — current deployment state and known operational caveats
- [Architecture](ARCHITECTURE.md) — component responsibilities, data model and failure behavior
- [Host runtime](self-host/README.md) — production/preview modes and operator guidance
- [Recovery runbook](self-host/RECOVERY.md) — startup recovery and replacement-host procedure
- [Aggregate monitoring](monitoring/README.md) — privacy boundary, dashboard and retention
- [Cloud services](worker/README.md) and [Worker contracts](worker/CONTRACTS.md) — implementation,
  endpoints and canonical storage contracts
- [Release process](RELEASE.md) and [release notes](RELEASE_NOTES_v4.1.0.md)
- [Historical plans](MIGRATION_PLAN.md) — retained for context, not current operating instructions

## Build from source

Install Node.js/npm, JDK 21 and an Android SDK, then from the repository root run:

```powershell
npm install
npm run android
```

To build the checked-in production version through the repository's signed Windows build path:

```powershell
.\build-and-release.ps1 -BuildOnly
```

The [release guide](RELEASE.md) lists the exact Android tools, validation behavior and maintainer-only
publication steps. Backend deployment is intentionally separate from building the Android app.

## Contributing

Focused issues and pull requests are welcome. Preserve the app's notification, seen-state and
authority safety contracts, add tests for behavior changes, and never commit credentials or local
runtime data. Start with [STATUS.md](STATUS.md) and the relevant technical document above.

Licensed under the [MIT License](LICENSE).
