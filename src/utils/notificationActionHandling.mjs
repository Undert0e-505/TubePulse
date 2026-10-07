import { isNotificationAction } from './localNotificationSilence.mjs';

export function notificationActionDetails(response) {
  if (!response || !isNotificationAction(response.actionIdentifier)) return null;
  const request = response?.notification?.request;
  return {
    actionIdentifier: response.actionIdentifier,
    channelId: request?.content?.data?.channelId || null,
    notificationIdentifier: request?.identifier || null,
  };
}

export async function handleLocalNotificationActionResponse(response, {
  persistAction,
  dismissNotification,
}) {
  const details = notificationActionDetails(response);
  if (!details) return { handled: false };

  const state = await persistAction(details.actionIdentifier, details.channelId);
  if (details.notificationIdentifier) {
    await dismissNotification(details.notificationIdentifier);
  }
  return {
    handled: true,
    dismissed: Boolean(details.notificationIdentifier),
    state,
  };
}
