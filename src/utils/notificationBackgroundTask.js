import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import {
  processLocalNotificationActionResponse,
  processNotificationSeenResponse,
} from './notificationActionRuntime';
import { createRetryableAsyncSetup } from './retryableAsyncSetup.mjs';
import { processBackgroundNotificationActionPayload } from './notificationBackgroundAction.mjs';

export const LOCAL_NOTIFICATION_RESPONSE_TASK = 'TUBEPULSE_LOCAL_NOTIFICATION_RESPONSE';

// Expo also invokes this task for remote receipt. RNFirebase owns receipt and
// local display, so only action responses are handled here.
if (!TaskManager.isTaskDefined(LOCAL_NOTIFICATION_RESPONSE_TASK)) {
  TaskManager.defineTask(LOCAL_NOTIFICATION_RESPONSE_TASK, async (task) => (
    await processBackgroundNotificationActionPayload(task, {
      processSeen: processNotificationSeenResponse,
      processSilence: processLocalNotificationActionResponse,
      warn: (message) => console.warn(message),
    })
  ));
}

const registerNotificationResponseTask = createRetryableAsyncSetup(async () => {
  const registered = await TaskManager.isTaskRegisteredAsync(LOCAL_NOTIFICATION_RESPONSE_TASK);
  if (!registered) await Notifications.registerTaskAsync(LOCAL_NOTIFICATION_RESPONSE_TASK);
});

export async function ensureNotificationResponseTaskRegistered() {
  await registerNotificationResponseTask();
}

ensureNotificationResponseTaskRegistered().catch((error) => {
  console.warn('Notification action background task registration failed:', error);
});
