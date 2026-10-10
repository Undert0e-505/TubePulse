# TubePulse user guide

TubePulse is an Android app for following selected YouTube channels through a focused Home feed,
home-screen widget and configurable notifications. It has no TubePulse account or cross-device
sync: each installation manages its own channels and settings.

## Install and update

1. Download the signed APK from the [latest GitHub release](https://github.com/Undert0e-505/TubePulse/releases/latest).
2. Open the APK on the Android device and allow installation from that file source if Android asks.
3. Allow notifications if you want upload, post, reminder and livestream alerts. TubePulse still
   provides its feed when notification permission is denied.

A newer signed release can be installed over the existing app. The local channel list, settings,
unseen state and pending seen updates should remain in place.

When a newer stable GitHub release is available, Settings shows **Update available**. TubePulse
checks the public GitHub releases API at most once every 12 hours per installation, uses a cached
validated result while offline, and hides that exact release after the button is tapped. The button
opens the matching GitHub release page; TubePulse does not download or install an APK itself.

## Manage channels

Open **Channels** to add a creator by `@handle` or YouTube channel ID. TubePulse resolves the stable
channel identity and starts with recent cached content without treating the whole history as new.
Removing a channel stops that installation from following it.

With **Auto-order channels** off, drag channels into the order you want. With it on, the app orders
channel sections by newest cached video, and the widget applies automatic ordering to the content it
displays, without overwriting the saved manual order. Turning it off restores that manual order.

Long-press a channel to inspect its local sound state. When per-channel controls are enabled, the
same panel can override notification mode, quiet hours, community-post preference or livestream
prewarning. **Save** applies those controls; **Cancel** leaves the existing override untouched.

## Home feed and seen state

The Home feed groups recent videos and community posts by channel. A blue dot marks unseen content.
Video rows include the available thumbnail, publication age, likes, public comment total and views;
missing or hidden engagement figures are omitted. Post cards show the available text, image or poll
summary. A comment-only change does not cause an extra cloud update; the shown total advances when
that video is otherwise refreshed, including the periodic refresh policy.

Use **Videos shown per channel** in Settings to show one, two or three recent videos in each Home
section. A per-channel display override can inherit or replace that global choice without changing
the backend's detection or notification behavior.

- Tap a video to follow the configured **Tap action**.
- Tap a community post to open that channel's community surface.
- Long-press a video to copy its link.
- Pull to refresh to request the current feed.

TubePulse updates seen state locally first. If the service or network is unavailable, exact content
IDs remain in a durable local queue and retry later on normal app lifecycle and refresh
opportunities. The app does not restore a blue dot merely because a remote save failed.

## Notification taps

For a notification about one video, **Tap action** controls the destination:

- **Video** opens that specific video and marks it seen.
- **Channel** opens the channel and marks the content represented at that moment seen.

A stacked notification containing multiple items always opens the channel and marks the exact
bundled items seen. Delayed retries never use an unbounded clear-all operation, so newer content
that arrived after the tap is not consumed accidentally. Opening YouTube is not blocked by remote
seen persistence.

Community-post notifications open the channel's community surface. A livestream prewarning opens
the scheduled video but does not consume the later live-time notification.

## Notification settings

Settings starts with a compact service-status row. It quietly shows whether notifications are
operating normally, may be delayed, are unavailable, or cannot currently be checked, plus when the
check was made. It is informational only: there is nothing to tap and no user action is required.
The status contains no device, channel or operator details, and an offline phone is shown as unknown
rather than being mistaken for a service outage.

### Tap action

Choose whether ordinary single-video taps open the video or its channel. The choice is used by
notifications, the Home feed and the widget where applicable; the special batch and post rules
above still apply.

### Reminder mode and interval

- **Chill** sends the initial video notification and can nudge again every four hours while the video
  remains unseen.
- **Relentless** repeats at the selected nag interval while the video remains unseen.
- Available nag intervals are 5, 15, 30, 60 and 120 minutes.

Video checks are aligned to five-minute boundaries. A newly detected upload produces one notification
for that channel's complete current visible unseen set: a single item when one is waiting, or one
bundle when two or three are waiting. Later reminders use the same rule; a fourth unseen item is kept
but stays outside the notification until it enters the visible top three. Swiping a notification away
does not mark it seen, while tapping marks the exact single item or exact bundle contents seen. The
selected Relentless interval remains exact, including 5-minute mode; new content and a due reminder
on the same tick produce one consolidated alert. Server do-not-disturb defers delivery, while the
notification mute actions keep delivery visible but silent.

When community posts are enabled globally or for an individual channel, an unread currently visible
post can be included in that channel's reminder. Disabling posts excludes them from later reminders.

### Do not disturb

Enable DND and choose **From** and **Until** times to silence eligible notifications overnight or
across any other daily window. TubePulse evaluates the window in the device's reported time zone.
Multiple pending items from one channel can be delivered as a channel summary after DND ends rather
than as a burst of individual alerts.

Ordinary uploads, community posts and prewarnings are held during DND. A livestream notification
can bypass DND so the live event is not missed. Use per-channel controls when a creator needs
different quiet hours from the global settings.

### Temporarily mute notification sound

Expand a TubePulse notification to use **Mute channel 1hr**, **Mute channel 8hr** or **Mute all**.
These controls are device-local and affect sound only: later notifications still arrive, remain in
the Android notification shade, update the feed/widget, and keep their ordinary unseen/reminder
state. Pressing a mute action does not open YouTube or mark anything seen.
After the local mute is saved, the notification you acted on is dismissed as acknowledgement. If
local storage fails, the notification remains visible instead of pretending the mute succeeded.
While that channel is locally silent, later notifications offer **Unmute channel** instead of more
mute actions. During **Mute all**, a still-silent channel offers **Unmute channel** and **Unmute
all**. The first makes only that channel audible while global silence remains active; the second
clears global silence, timed channel mutes and audible exceptions. Successful unmute actions also
dismiss only the notification used for the action.

Android can collapse several TubePulse alerts under an automatic summary. The summary itself is
system-generated and does not carry TubePulse controls; expand the group and then the individual
notification to reveal its mute actions.

Temporary channel mutes expire automatically using their saved end time and survive an app or phone
restart. While a channel is muted, its Home feed heading shows **Silent until HH:MM** and **Unmute**.
During **Mute all**, each still-silent channel instead shows **Silent** and **Unmute**; unmuting a row
makes that channel an audible exception without disabling global silence. **Mute all** lasts until
**Unmute all** is pressed at the top of Home; that button clears both global and channel-specific
local mutes. No local sound action is sent to the host or stored in Cloudflare/D1. This is
intentionally different from DND, which is evaluated by the host and holds eligible notifications
until the DND window ends.

### Livestream prewarning

Choose how early TubePulse warns about a scheduled livestream or premiere: 15 or 30 minutes, 1, 2
or 4 hours, or 1 day. A regular notification can still arrive when the scheduled item becomes
current. A channel override can inherit or replace the global lead time.

The prewarning is only a heads-up: tapping it opens the scheduled video without marking it seen or
suppressing the later live notification. Near the published start time, the host checks the public
event state more frequently and sends the normal compatible video notification promptly once YouTube
confirms that it is live. If the broadcaster reschedules, the watcher follows the new time; temporary
API failures or a single missing response do not cancel the event.

### Community posts

Enable **Community posts** to include supported text, image and poll posts in the feed and initial
notification flow. A per-channel override can inherit, enable or disable the global choice.
Community posts are not YouTube comments, and detection depends on an unofficial YouTube web
surface that may change.

## Channel ordering

The default order is the saved manual channel order. Automatic ordering changes display order only;
it does not rewrite that saved list. Channels without dated cached content remain in stable manual
order after channels with current content.

## Android home-screen widget

Add the TubePulse widget through Android's widget picker. It shows at most one content item per
displayed channel: the newest published cached video or community post, whether seen or unseen.
Seen items are dimmed and unseen items retain their blue marker. Taps preserve the selected item's
video, channel or post behavior, and automatic channel ordering follows the app setting. Video rows
show the same available likes, public comment total and views as the Home feed.

Widget refresh timing is subject to Android launcher and battery policies. Open or refresh the app
if the widget remains stale after connectivity returns.

## Data and privacy

TubePulse creates a pseudonymous installation identifier for its service authentication and sends a
Firebase token when push permission is available. It stores the channel list, settings and seen
state needed to provide the product. It does not provide a TubePulse account or cross-device sync.
The update indicator sends a rate-limited request to GitHub's public releases API; it sends no
TubePulse installation identifier, channels or notification state.

Operational dashboards use aggregate service measurements and are designed not to expose raw
installation/channel identifiers, tokens, titles or content. See the repository's
[security guidance](../SECURITY.md) and [service contracts](../worker/CONTRACTS.md) for the technical
boundary.

## Troubleshooting

- **No push notifications:** confirm Android notification permission, battery/background policy and
  network access, then open the app so registration can refresh.
- **Feed or seen state is temporarily stale:** refresh later. Local seen changes remain optimistic
  and retry silently rather than blocking YouTube.
- **A community post is missing:** the unofficial post surface may be unavailable or may have
  changed; videos use a separate official API path.
- **Widget is stale:** open/refresh TubePulse, then ask the launcher to redraw the widget by resizing
  or re-adding it if necessary.

For current service limitations, consult [STATUS.md](../STATUS.md). For build and operator material,
return to the [project README](../README.md#documentation).
