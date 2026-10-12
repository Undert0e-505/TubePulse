# TubePulse v4.3.0

## Mark content seen without opening YouTube

- Notifications now offer **Mute 1h**, **Mute 8h**, then **Mark seen** in that order; **Mark seen** clears only the video or bundle represented by that notification.
- The main feed shows a right-aligned **Mark seen** control for each channel with unseen content and a conditional **Mark all seen** control for the current feed snapshot.
- New content arriving after an action was created or tapped remains unseen, including when an offline retry completes later.
- Seen actions immediately update blue dots, the widget and the notification tray, while a durable retry queue safely finishes the server update after temporary network failures.
- Sound controls remain local to the phone: channel bundles expose **Mute all**, muted notifications retain the appropriate unmute choices, and silent notifications continue to arrive visibly.

## Reliability and operations

- Batched, installation-scoped seen updates reduce API work while preserving the existing single-channel contract for older app versions.
- Notification monitoring now uses durable exact Firebase accepted/failed counters, with settled five-minute collection that normally attributes each interval to one completed host scheduler cycle.
- Aggregate monitoring records permanent invalid-token responses and deduplicated cleanup lifecycles without exposing installation, token, channel or content identifiers.
- The operations wallboard presents the corrected **Notifications Sent** history and the new invalid-token trend alongside the existing privacy-safe service metrics.

## Install

Download `TubePulse-v4.3.0.apk` and install it over the current signed TubePulse app. Existing channels, settings, seen state and notification preferences are retained.
