import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StatusBar, Text, TouchableOpacity, Platform, Linking, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import HomeScreen from './src/screens/HomeScreen';
import ChannelsScreen from './src/screens/ChannelsScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import PreviewServerScreen from './src/screens/PreviewServerScreen';
import { COLORS } from './src/utils/constants';
import { getChannels, getSettings, getLastSeen, saveLastSeen, getChannelCache, saveChannelCache } from './src/utils/storage';
import { requestPermissionAndGetToken, onTokenRefresh, onForegroundMessage, onNotificationOpenedApp, getInitialNotification, setBackgroundMessageHandler } from './src/utils/fcm';
import { registerDevice, markSeen, getDeviceId, subscribeChannel, updateSettings, bootstrapChannel } from './src/utils/api';
import { setupNotificationChannel } from './src/utils/notifications';
import { ConfirmHost } from './src/components/Confirm';
import SettingsCogIcon from './src/components/SettingsCogIcon';
import { updateWidget } from './src/components/widgetTaskHandler';
import {
  IS_TUBEPULSE_PREVIEW,
  PREVIEW_PUSH_ENABLED,
  getConfiguredPreviewOrigin,
  subscribeToPreviewOriginChanges,
} from './src/utils/apiEndpointConfig';
import { bootstrapTrackedChannel } from './src/utils/channelBootstrap.mjs';
import {
  APP_INITIALIZATION_STORAGE_KEY,
  createAppInitializationMarker,
} from './src/utils/appInitialization.mjs';
import {
  applyOptimisticNotificationSeen,
  notificationTapDedupeKey,
  notificationTapPlan,
} from './src/utils/notificationTap.mjs';

// Configure expo-notifications to show notifications while the app is
// in the foreground. Without this, scheduleNotificationAsync calls
// made from the onForegroundMessage handler will not display a banner/sound.
// This must be set at the top level, before any component renders.
try {
  const Notifications = require('expo-notifications');
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
} catch (e) {
  console.warn('Failed to set expo-notifications handler:', e);
}

const Stack = createNativeStackNavigator();

const screenOptions = {
  headerStyle: { backgroundColor: COLORS.bg },
  headerTintColor: COLORS.text,
  headerTitleStyle: { fontWeight: '600', fontSize: 17 },
  contentStyle: { backgroundColor: COLORS.bg },
};

function HeaderButton({ title, children, onPress, style, textStyle, accessibilityLabel, accessibilityHint }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }, style]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || title}
      accessibilityHint={accessibilityHint}
    >
      {children || (
        <Text style={[{ color: COLORS.accent, fontSize: 14, fontWeight: '500' }, textStyle]}>
          {title}
        </Text>
      )}
    </TouchableOpacity>
  );
}

// Background message handler — must be registered at top level
// This runs when the app is in the background or killed and a push arrives.
// It needs to:
//   1. Pull the latest feed from the server (so the local cache has the new video)
//   2. Update the channel cache in AsyncStorage
//   3. Trigger a widget re-render so the home screen widget shows the new video
// Without this, the widget stays stale until the user opens the app.
if (PREVIEW_PUSH_ENABLED) setBackgroundMessageHandler(async (remoteMessage) => {
  console.log('Background push received:', remoteMessage?.messageId, remoteMessage?.data?.videoId);
  try {
    const { getDeviceId, fetchFeed } = require('./src/utils/api');
    const deviceId = await getDeviceId();
    if (!deviceId) return;

    const result = await fetchFeed(deviceId);
    if (!result?.ok || !Array.isArray(result.channels)) return;

    // Get current local channels to resolve handle from channelId
    const { getChannels } = require('./src/utils/storage');
    const localChannels = await getChannels();
    const channelById = Object.fromEntries(
      localChannels.filter((c) => c.channelId).map((c) => [c.channelId, c])
    );

    const freshCache = await getChannelCache();
    let changed = false;
    for (const feed of result.channels) {
      const local = channelById[feed.channelId];
      const handle = local?.handle;
      if (!handle) continue;
      const existing = freshCache[handle] || {};

      // Detect new content: compare the first videoId (newest) and
      // check for any post IDs we haven't cached yet.  This replaces
      // the old "more videos than before" check which never triggered
      // because the server caps at 15 videos — a new upload pushes
      // one off the end, so the count stays the same.
      const serverFirstVideoId = feed.videos?.[0]?.videoId;
      const cachedFirstVideoId = existing.videos?.[0]?.videoId;
      const serverPostIds = new Set((feed.posts || []).map(p => p.activityId));
      const cachedPostIds = new Set((existing.posts || []).map(p => p.activityId));
      const hasNewPosts = [...serverPostIds].some(id => !cachedPostIds.has(id));
      const hasNewVideo = serverFirstVideoId && serverFirstVideoId !== cachedFirstVideoId;
      const hasAvatarGap = !existing.avatar && feed.meta?.avatarUrl;

      if (hasNewVideo || hasNewPosts || hasAvatarGap) {
        freshCache[handle] = {
          name: feed.meta?.name || existing.name || local.name || handle,
          avatar: feed.meta?.avatarUrl || existing.avatar || null,
          videos: feed.videos || existing.videos || [],
          // Preserve posts from the server response, falling back to
          // any existing posts we already had (the server always
          // returns the current set, so this replaces rather than
          // merges — which is correct).
          posts: feed.posts || existing.posts || [],
          latestVideo: (feed.videos || [])[0] || existing.latestVideo || null,
          channelId: feed.channelId,
          lastChecked: new Date().toISOString(),
        };
        changed = true;
      }
    }
    if (changed) {
      await saveChannelCache(freshCache);
    }

    // Always trigger a widget update — the widget task handler will read
    // whatever is in the cache and re-render. If the cache is unchanged,
    // the widget still re-renders to a no-op state but at least stays
    // consistent.
    try { await updateWidget('bg-push'); } catch {}
  } catch (e) {
    console.warn('Background push handler failed:', e);
  }
});

function TubePulseApplication() {
  const fcmTokenRef = useRef(null);
  const deviceIdRef = useRef(null);
  const [initializationMarker] = useState(() => createAppInitializationMarker());
  const processedTapKeysRef = useRef(new Map());

  useEffect(() => {
    (async () => {
      try {
        // Set up Android notification channels
        await setupNotificationChannel();

        // Get persistent device ID
        const deviceId = await getDeviceId();
        deviceIdRef.current = deviceId;

        // Preview APKs use a null token unless built with a real, separately
        // registered Firebase Android client for the preview package.
        const fcmToken = PREVIEW_PUSH_ENABLED ? await requestPermissionAndGetToken() : null;
        // Register device with the server. We do this even if FCM is unavailable —
        // the device profile is what the preseed channel bootstrap subscribes against.
        // FCM token is a separate field on the profile and is set/updated below.
        try {
          await registerDevice(deviceId, fcmToken || null);
        } catch (e) {
          console.warn('Device register failed:', e);
        }

        if (fcmToken) {
          fcmTokenRef.current = fcmToken;
        }

        // Self-healing: on every launch, ensure every local channel is
        // subscribed on the server. This handles:
        //   - Fresh install (preseeded channels not yet on server)
        //   - Upgrades from builds where init failed silently
        //   - Drift between local state and server state (e.g. a
        //     subscribe-channel call that failed on first add but the
        //     channel was saved locally anyway — the pre-fix bug)
        //
        // Idempotent: re-subscribing an already-subscribed channel is a
        // cheap no-op on the server side (alreadySubscribed: true).
        //
        // Throttled: runs at most once per 4 hours. The timestamp is in
        // AsyncStorage so it survives across rapid re-launches.
        try {
          const { getChannels, getSettings, getLastReconcileAt, saveLastReconcileAt } = require('./src/utils/storage');
          const localChannels = await getChannels();
          const localSettings = await getSettings();

          // Push settings to server (always, even if reconcile is throttled)
          try { await updateSettings(deviceId, localSettings); } catch (e) {}

          // Reconciliation: re-subscribe ALL local channels that have a
          // channelId. The server's /subscribe-channel is idempotent, so
          // already-subscribed channels are a cheap no-op. This repairs
          // the pre-fix bug where a channel was saved locally but the
          // server subscribe call failed silently.
          const now = Date.now();
          const lastReconcile = await getLastReconcileAt();
          const RECONCILE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

          if (now - lastReconcile > RECONCILE_INTERVAL_MS) {
            const channelsWithId = localChannels.filter((ch) => ch.channelId);
            if (channelsWithId.length > 0) {
              console.log(`[Init] Reconciling ${channelsWithId.length} channel(s) with server`);
              let reconciled = 0;
              let failed = 0;
              for (const ch of channelsWithId) {
                try {
                  const subResult = await subscribeChannel(deviceId, ch.channelId);
                  if (subResult?.ok) {
                    reconciled++;
                    // If the server returned meta we didn't have, update cache.
                    if (!subResult.alreadySubscribed && subResult.channel?.meta) {
                      const { getChannelCache, saveChannelCache } = require('./src/utils/storage');
                      const cache = await getChannelCache();
                      if (cache[ch.handle]) {
                        cache[ch.handle] = {
                          ...cache[ch.handle],
                          name: subResult.channel.meta.name || cache[ch.handle].name,
                          avatar: subResult.channel.meta.avatarUrl || cache[ch.handle].avatar,
                        };
                        await saveChannelCache(cache);
                      }
                    }
                  } else {
                    failed++;
                    console.warn(`[Init] Subscribe failed for ${ch.handle}:`, subResult?.error || 'unknown');
                  }
                } catch (e) {
                  failed++;
                  console.warn(`[Init] Subscribe exception for ${ch.handle}:`, e);
                }
              }
              console.log(`[Init] Reconcile done: ${reconciled} ok, ${failed} failed`);
            }
            await saveLastReconcileAt(now);
          }

          // Bootstrap channels that have no cache (brand-new channels
          // added locally but not yet bootstrapped, e.g. default channels
          // on a fresh install). This is separate from reconciliation —
          // reconciliation ensures the server knows about the channel;
          // bootstrap fills in the initial video/avatar data.
          const { getChannelCache } = require('./src/utils/storage');
          const cache = await getChannelCache();
          const channelsNeedingBootstrap = localChannels.filter((ch) => {
            if (!ch.channelId) return false;
            const cached = cache[ch.handle];
            return !cached || !cached.avatar || !cached.videos || cached.videos.length === 0;
          });

          if (channelsNeedingBootstrap.length > 0) {
            console.log(`[Init] Bootstrapping ${channelsNeedingBootstrap.length} channels: ${channelsNeedingBootstrap.map((c) => c.handle).join(', ')}`);
            for (const ch of channelsNeedingBootstrap) {
              // Bootstrap — fetches RSS + avatar from server
              try {
                const bootResult = await bootstrapTrackedChannel({
                  deviceId,
                  channelId: ch.channelId,
                  bootstrapChannel,
                  subscribeChannel,
                });
                if (bootResult?.ok && bootResult.videos?.length > 0) {
                  const { saveChannelCache, getLastSeen, saveLastSeen } = require('./src/utils/storage');
                  const freshCache = await getChannelCache();
                  const existingEntry = freshCache[ch.handle] || {};
                  // Only keep the latest video on first install/bootstrap.
                  // The server retains the full 15-video recent list for
                  // future diffing; the client only needs the latest to
                  // show in the feed/widget. Everything is marked as
                  // seen so the user isn't spammed with old content.
                  const latestOnly = [bootResult.videos[0]];
                  freshCache[ch.handle] = {
                    name: bootResult.name || existingEntry.name || ch.name || ch.handle,
                    avatar: bootResult.avatar || existingEntry.avatar || null,
                    videos: latestOnly,
                    latestVideo: latestOnly[0] || null,
                    channelId: ch.channelId,
                    lastChecked: new Date().toISOString(),
                  };
                  await saveChannelCache(freshCache);

                  // Mark the latest video as seen locally
                  const lastSeen = await getLastSeen();
                  if (!lastSeen[ch.handle]) lastSeen[ch.handle] = { seenIds: [] };
                  const seenIds = new Set(lastSeen[ch.handle].seenIds || []);
                  if (latestOnly[0]?.videoId) seenIds.add(latestOnly[0].videoId);
                  lastSeen[ch.handle].seenIds = [...seenIds];
                  await saveLastSeen(lastSeen);

                  // Mark ALL existing videos as seen on the server too,
                  // so the /feed response won't flag old uploads as
                  // unwatched. Only genuinely new uploads (detected by
                  // the cron after this point) will appear as "New".
                  try {
                    const { markSeen } = require('./src/utils/api');
                    await markSeen(deviceId, ch.channelId, [], true);
                  } catch (e) {
                    console.warn(`[Init] markSeen clearAll failed for ${ch.handle}:`, e);
                  }
                }
              } catch (e) {
                console.warn(`[Init] Bootstrap failed for ${ch.handle}:`, e);
              }
            }
            console.log(`[Init] Bootstrapped ${channelsNeedingBootstrap.length} channels`);
          }
        } catch (e) {
          console.warn('[Init] Channel reconciliation failed:', e);
        }
      } catch (e) {
        console.warn('Init error:', e);
      } finally {
        // Signal completion even when initialization failed. Home waits for
        // this current-session marker before its first Preview feed request,
        // then surfaces any real offline/registration error normally.
        try {
          await AsyncStorage.setItem(APP_INITIALIZATION_STORAGE_KEY, initializationMarker);
        } catch (e) {
          console.warn('Could not persist initialization completion:', e);
        }
      }
    })();

    // Handle token refresh — re-register with updated FCM token
    const tokenUnsubscribe = PREVIEW_PUSH_ENABLED ? onTokenRefresh(async (newToken) => {
      fcmTokenRef.current = newToken;
      try {
        const deviceId = deviceIdRef.current || await getDeviceId();
        await registerDevice(deviceId, newToken);
      } catch (e) {
        console.warn('Token refresh re-register failed:', e);
      }
    }) : () => {};

    // Handle foreground messages
    // When the app is in the foreground, FCM does NOT automatically show
    // a system notification. We must explicitly display one using
    // expo-notifications' scheduleNotificationAsync.
    const foregroundUnsubscribe = PREVIEW_PUSH_ENABLED ? onForegroundMessage(async (remoteMessage) => {
      console.log('Foreground push:', remoteMessage?.data?.videoId || remoteMessage?.data?.activityId);
      try {
        const Notifications = require('expo-notifications');
        const data = remoteMessage?.data || {};
        const title = remoteMessage?.notification?.title || 'TubePulse';
        const body = remoteMessage?.notification?.body || '';
        const channelId = 'new-videos';
        // Use the notificationTag from the FCM payload if provided.
        const notifTag = data.notificationTag
          || (data.videoId ? `video-${data.videoId}` : null)
          || (data.activityId ? `post-${data.activityId}` : null)
          || null;
        const notifId = notifTag ? `fg-${notifTag}` : `fg-${remoteMessage?.messageId || Date.now()}`;

        // Dismiss any already-delivered TubePulse notifications for the
        // same item before scheduling the replacement. Without this,
        // each foreground reminder creates a new row in the notification
        // shade because scheduleNotificationAsync's identifier only
        // dedupes pending (not yet delivered) notifications.
        try {
          const presented = await Notifications.getPresentedNotificationsAsync();
          for (const n of presented) {
            const nData = n?.request?.content?.data || {};
            const nTag = nData.notificationTag
              || (nData.videoId ? `video-${nData.videoId}` : null)
              || (nData.activityId ? `post-${nData.activityId}` : null)
              || null;
            // Dismiss if same item tag, or if both are TubePulse
            // notifications with the same channelId (catches batch/nag
            // replacements for the same channel).
            if (nTag && notifTag && nTag === notifTag) {
              await Notifications.dismissNotificationAsync(n.request.identifier);
            }
          }
        } catch (e) {
          // Non-critical — continue with scheduling
        }

        await Notifications.scheduleNotificationAsync({
          identifier: notifId,
          content: {
            title,
            body,
            data,
            sound: 'default',
          },
          trigger: {
            channelId,
            type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
            seconds: 1,
          },
        });
      } catch (e) {
        console.warn('Foreground notification display failed:', e);
      }
    }) : () => {};

    // Firebase-delivered notifications and foreground notifications re-published
    // through expo-notifications both enter this one path.
    const handleNotificationTap = async (messageOrResponse) => {
      const data = messageOrResponse?.data
        || messageOrResponse?.notification?.request?.content?.data
        || null;
      if (!data?.videoId && !data?.channelId && !data?.activityId) return;

      const dedupeKey = notificationTapDedupeKey(data);
      const now = Date.now();
      for (const [key, at] of processedTapKeysRef.current) {
        if (now - at > 30_000) processedTapKeysRef.current.delete(key);
      }
      if (now - (processedTapKeysRef.current.get(dedupeKey) || 0) < 10_000) return;
      processedTapKeysRef.current.set(dedupeKey, now);

      let plan;
      let deviceId;
      let channels = [];
      try {
        const [settings, localChannels, resolvedDeviceId] = await Promise.all([
          getSettings(),
          getChannels(),
          deviceIdRef.current ? Promise.resolve(deviceIdRef.current) : getDeviceId(),
        ]);
        channels = localChannels;
        deviceId = resolvedDeviceId;
        const handle = localChannels.find((channel) => channel.channelId === data.channelId)?.handle || null;
        plan = notificationTapPlan(data, { localTapAction: settings.tapAction, handle });
      } catch (error) {
        console.warn('Notification tap setup failed:', error);
        plan = notificationTapPlan(data, { localTapAction: 'video', handle: null });
      }
      if (!plan) return;

      // Opening the destination is the primary action. Start it before any
      // network persistence and do not allow local/remote failures to block it.
      if (plan.url) {
        Linking.openURL(plan.url).catch((error) => {
          console.warn('Notification destination could not be opened:', error);
        });
      }

      if (plan.kind !== 'prewarn') {
        try {
          const [cache, lastSeen] = await Promise.all([getChannelCache(), getLastSeen()]);
          const optimistic = applyOptimisticNotificationSeen({
            channels,
            cache,
            lastSeen,
            channelId: data.channelId,
            contentIds: plan.contentIds,
            clearAll: plan.clearAll,
          });
          if (optimistic.handle) {
            await Promise.all([
              saveLastSeen(optimistic.lastSeen),
              saveChannelCache(optimistic.cache),
            ]);
          }
        } catch (error) {
          console.warn('Notification local seen update failed:', error);
        }

        try { await updateWidget('notif-tap'); } catch {}

        if (deviceId && data.channelId) {
          markSeen(deviceId, data.channelId, plan.contentIds, plan.clearAll).catch((error) => {
            console.warn('Notification remote seen update failed:', error);
          });
        }
      }
    };

    // Check if app was opened from a notification (cold start)
    if (PREVIEW_PUSH_ENABLED) {
      getInitialNotification().then((remoteMessage) => {
        if (remoteMessage) {
          handleNotificationTap(remoteMessage);
        }
      });
    }

    let expoTapSubscription;
    try {
      const Notifications = require('expo-notifications');
      expoTapSubscription = Notifications.addNotificationResponseReceivedListener(handleNotificationTap);
      Notifications.getLastNotificationResponseAsync?.().then(async (response) => {
        if (!response) return;
        try { await Notifications.clearLastNotificationResponseAsync?.(); } catch {}
        const responseDate = Number(response?.notification?.date);
        if (Number.isFinite(responseDate) && Date.now() - responseDate > 5 * 60_000) return;
        await handleNotificationTap(response);
      }).catch((error) => console.warn('Cold notification response check failed:', error));
    } catch (error) {
      console.warn('Expo notification tap listener unavailable:', error);
    }

    // Listen for notification taps (warm start)
    const tapUnsubscribe = PREVIEW_PUSH_ENABLED
      ? onNotificationOpenedApp(handleNotificationTap)
      : () => {};

    return () => {
      tokenUnsubscribe();
      foregroundUnsubscribe();
      tapUnsubscribe();
      expoTapSubscription?.remove?.();
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />
      <NavigationContainer
        theme={{
          ...DefaultTheme,
          dark: true,
          colors: {
            ...DefaultTheme.colors,
            primary: COLORS.accent,
            background: COLORS.bg,
            card: COLORS.bg,
            text: COLORS.text,
            border: COLORS.border,
            notification: COLORS.accent,
          },
        }}
      >
        <Stack.Navigator screenOptions={screenOptions}>
          <Stack.Screen
            name="Home"
            options={({ navigation }) => ({
              title: IS_TUBEPULSE_PREVIEW ? 'TubePulse Preview' : 'TubePulse',
              headerRight: () => (
                <>
                  <HeaderButton title="Channels" onPress={() => navigation.navigate('Channels')} />
                  <HeaderButton
                    onPress={() => navigation.navigate('Settings')}
                    style={{ marginLeft: 6 }}
                    accessibilityLabel="Settings"
                    accessibilityHint="Opens TubePulse settings"
                  >
                    <SettingsCogIcon />
                  </HeaderButton>
                </>
              ),
            })}
          >
            {(screenProps) => (
              <HomeScreen
                {...screenProps}
                previewInitializationMarker={IS_TUBEPULSE_PREVIEW ? initializationMarker : null}
              />
            )}
          </Stack.Screen>
          <Stack.Screen name="Channels" component={ChannelsScreen} />
          <Stack.Screen name="Settings" component={SettingsScreen} />
          {IS_TUBEPULSE_PREVIEW ? (
            <Stack.Screen name="PreviewServer" component={PreviewServerScreen} options={{ title: 'Preview Server' }} />
          ) : null}
        </Stack.Navigator>
      </NavigationContainer>
      {/* ConfirmHost is a global modal host. Any `confirm()` call from
          anywhere in the app will resolve here, drawing the themed
          ConfirmDialog above whatever screen is currently visible. */}
      <ConfirmHost />
    </GestureHandlerRootView>
  );
}

export default function App() {
  const [previewReady, setPreviewReady] = useState(!IS_TUBEPULSE_PREVIEW);
  const [checkingPreview, setCheckingPreview] = useState(IS_TUBEPULSE_PREVIEW);
  const [previewRevision, setPreviewRevision] = useState(0);

  useEffect(() => {
    if (!IS_TUBEPULSE_PREVIEW) return undefined;
    let cancelled = false;
    getConfiguredPreviewOrigin()
      .then((origin) => {
        if (!cancelled) setPreviewReady(Boolean(origin));
      })
      .finally(() => {
        if (!cancelled) setCheckingPreview(false);
      });
    const unsubscribe = subscribeToPreviewOriginChanges(() => {
      setPreviewReady(true);
      setCheckingPreview(false);
      // Remount normal initialization so the new Home receives registration,
      // settings and subscription reconciliation immediately.
      setPreviewRevision((value) => value + 1);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (checkingPreview) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.bg }}>
          <ActivityIndicator color={COLORS.accent} />
          <Text style={{ color: COLORS.textDim, marginTop: 12 }}>Loading TubePulse Preview…</Text>
        </View>
      </GestureHandlerRootView>
    );
  }

  if (IS_TUBEPULSE_PREVIEW && !previewReady) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />
        <PreviewServerScreen initialSetup />
      </GestureHandlerRootView>
    );
  }

  return <TubePulseApplication key={`endpoint-${previewRevision}`} />;
}
