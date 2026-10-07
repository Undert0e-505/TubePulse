import * as Notifications from 'expo-notifications';
import { applyLocalNotificationAction } from './localNotificationSilenceStorage';
import { handleLocalNotificationActionResponse } from './notificationActionHandling.mjs';

export async function processLocalNotificationActionResponse(response) {
  return await handleLocalNotificationActionResponse(response, {
    persistAction: applyLocalNotificationAction,
    dismissNotification: (identifier) => Notifications.dismissNotificationAsync(identifier),
  });
}
