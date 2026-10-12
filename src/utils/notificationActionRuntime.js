import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { applyLocalNotificationAction } from './localNotificationSilenceStorage';
import { handleLocalNotificationActionResponse } from './notificationActionHandling.mjs';
import { getChannels, getLastSeen, saveLastSeen, getChannelCache, saveChannelCache } from './storage';
import { getDeviceId, markSeen, markSeenBatch } from './api';
import { applyOptimisticNotificationSeen } from './notificationTap.mjs';
import { enqueueSeenMutation, flushSeenMutationQueue } from './seenPersistence.mjs';
import {
  handleNotificationSeenResponse,
  notificationIdsAreCovered,
} from './notificationSeenAction.mjs';
import { updateWidget } from '../components/widgetTaskHandler';
import { notifyLocalSeenChanged } from './localSeenEvents';

export async function processLocalNotificationActionResponse(response) {
  return await handleLocalNotificationActionResponse(response, {
    persistAction: applyLocalNotificationAction,
    dismissNotification: (identifier) => Notifications.dismissNotificationAsync(identifier),
  });
}

export async function dismissCoveredNotifications({ contentIds, notificationIdentifier = null }) {
  const seenIds = new Set(contentIds);
  const presented = await Notifications.getPresentedNotificationsAsync();
  for (const notification of presented) {
    const identifier = notification?.request?.identifier;
    const data = notification?.request?.content?.data || {};
    if (identifier === notificationIdentifier || notificationIdsAreCovered(data, seenIds)) {
      await Notifications.dismissNotificationAsync(identifier);
    }
  }
}

export async function processNotificationSeenResponse(response) {
  return await handleNotificationSeenResponse(response, {
    enqueue: ({ channelId, contentIds }) => enqueueSeenMutation({
      storage: AsyncStorage, channelId, contentIds,
    }),
    applyLocal: async ({ channelId, contentIds }) => {
      const [channels, cache, lastSeen] = await Promise.all([
        getChannels(), getChannelCache(), getLastSeen(),
      ]);
      const optimistic = applyOptimisticNotificationSeen({
        channels, cache, lastSeen, channelId, contentIds, clearAll: false,
      });
      if (optimistic.handle) {
        await Promise.all([
          saveLastSeen(optimistic.lastSeen),
          saveChannelCache(optimistic.cache),
        ]);
      }
    },
    updateSurface: async () => {
      notifyLocalSeenChanged();
      await updateWidget('notification-mark-seen');
    },
    dismissCovered: dismissCoveredNotifications,
    flush: async () => {
      const deviceId = await getDeviceId();
      return await flushSeenMutationQueue({
        storage: AsyncStorage,
        deviceId,
        persist: markSeen,
        persistBatch: markSeenBatch,
        force: true,
      });
    },
  });
}
