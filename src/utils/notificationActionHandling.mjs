import { isSilenceNotificationAction } from './localNotificationSilence.mjs';
import { notificationResponseData } from './notificationResponseNormalization.mjs';

export function notificationActionDetails(response) {
  if (!response || !isSilenceNotificationAction(response.actionIdentifier)) return null;
  const request = response?.notification?.request;
  const data = notificationResponseData(response).data;
  if (!data) return null;
  return {
    actionIdentifier: response.actionIdentifier,
    channelId: data.channelId || null,
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
