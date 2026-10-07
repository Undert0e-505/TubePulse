import { COLORS } from './constants';
import {
  LOCAL_NOTIFICATION_CHANNEL_MUTED_CATEGORY,
  LOCAL_NOTIFICATION_CATEGORY,
  LOCAL_NOTIFICATION_GLOBAL_MUTED_CATEGORY,
  NOTIFICATION_ACTIONS,
} from './localNotificationSilence.mjs';
import { getLocalNotificationPresentation } from './localNotificationSilenceStorage';
import { createRetryableAsyncSetup } from './retryableAsyncSetup.mjs';

export function isLocallyRenderedRemoteMessage(remoteMessage) {
  return remoteMessage?.data?.localRender === '1';
}

const ensureNotificationCategory = createRetryableAsyncSetup(async () => {
  const Notifications = require('expo-notifications');
  await Promise.all([
    Notifications.setNotificationCategoryAsync(LOCAL_NOTIFICATION_CATEGORY, [
      {
        identifier: NOTIFICATION_ACTIONS.MUTE_CHANNEL_1H,
        buttonTitle: 'Mute channel 1hr',
        options: { opensAppToForeground: false },
      },
      {
        identifier: NOTIFICATION_ACTIONS.MUTE_CHANNEL_8H,
        buttonTitle: 'Mute channel 8hr',
        options: { opensAppToForeground: false },
      },
      {
        identifier: NOTIFICATION_ACTIONS.MUTE_ALL,
        buttonTitle: 'Mute all',
        options: { opensAppToForeground: false },
      },
    ]),
    Notifications.setNotificationCategoryAsync(LOCAL_NOTIFICATION_CHANNEL_MUTED_CATEGORY, [
      {
        identifier: NOTIFICATION_ACTIONS.UNMUTE_CHANNEL,
        buttonTitle: 'Unmute channel',
        options: { opensAppToForeground: false },
      },
    ]),
    Notifications.setNotificationCategoryAsync(LOCAL_NOTIFICATION_GLOBAL_MUTED_CATEGORY, [
      {
        identifier: NOTIFICATION_ACTIONS.UNMUTE_CHANNEL,
        buttonTitle: 'Unmute channel',
        options: { opensAppToForeground: false },
      },
      {
        identifier: NOTIFICATION_ACTIONS.UNMUTE_ALL,
        buttonTitle: 'Unmute all',
        options: { opensAppToForeground: false },
      },
    ]),
  ]);
});

export async function setupLocalNotificationPresentation() {
  await ensureNotificationCategory();
}

function notificationTag(data) {
  return data.notificationTag
    || (data.videoId ? `video-${data.videoId}` : null)
    || (data.activityId ? `post-${data.activityId}` : null)
    || null;
}

export async function presentRemoteMessageLocally(remoteMessage) {
  if (!isLocallyRenderedRemoteMessage(remoteMessage)) return false;
  const Notifications = require('expo-notifications');
  const data = remoteMessage?.data || {};
  const title = data.notificationTitle || 'TubePulse';
  const body = data.notificationBody || '';
  const tag = notificationTag(data);
  // Categories must exist before a notification using them is posted. App
  // startup registers this before advertising local-v1, but a headless/cold
  // delivery must not depend on React mounting first. Keep display resilient:
  // a native category failure may omit actions, but must not hide the push.
  try {
    await setupLocalNotificationPresentation();
  } catch (error) {
    console.warn('Notification actions setup failed during presentation:', error);
  }

  const localPresentation = await getLocalNotificationPresentation(data.channelId || null);
  const silent = localPresentation.silent;
  const channelId = silent ? 'new-videos-silent' : 'new-videos';
  const identifier = tag ? `local-${tag}` : `local-${remoteMessage?.messageId || Date.now()}`;

  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const notification of presented) {
      const existingData = notification?.request?.content?.data || {};
      if (tag && notificationTag(existingData) === tag) {
        await Notifications.dismissNotificationAsync(notification.request.identifier);
      }
    }
  } catch { /* replacement is best effort */ }

  await Notifications.scheduleNotificationAsync({
    identifier,
    content: {
      title,
      body,
      data: { ...data, localSilent: silent ? '1' : '0' },
      categoryIdentifier: localPresentation.categoryIdentifier,
      sound: silent ? null : 'default',
      color: COLORS.accent,
    },
    trigger: { channelId },
  });
  return true;
}
