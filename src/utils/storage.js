import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS, DEFAULT_CHANNELS, DEFAULT_SETTINGS } from './constants';

// gentleState shape: { [handle]: { videoId, firstNotifiedAt, lastRemindedAt } }
export async function getGentleNotifState() {
  const data = await AsyncStorage.getItem(STORAGE_KEYS.GENTLE_NOTIF_STATE);
  return data ? JSON.parse(data) : {};
}

export async function saveGentleNotifState(state) {
  await AsyncStorage.setItem(STORAGE_KEYS.GENTLE_NOTIF_STATE, JSON.stringify(state));
}

export async function getChannels() {
  const data = await AsyncStorage.getItem(STORAGE_KEYS.CHANNELS);
  if (data) {
    // Backfill channelIds from defaults for any channels that are missing them
    const channels = JSON.parse(data);
    const defaultMap = {};
    for (const d of DEFAULT_CHANNELS) {
      defaultMap[d.handle] = d.channelId;
    }
    let updated = false;
    for (const ch of channels) {
      if (!ch.channelId && defaultMap[ch.handle]) {
        ch.channelId = defaultMap[ch.handle];
        updated = true;
      }
    }
    if (updated) await saveChannels(channels);
    return channels;
  }
  // First run — seed defaults
  await saveChannels(DEFAULT_CHANNELS);
  return DEFAULT_CHANNELS;
}

export async function saveChannels(channels) {
  await AsyncStorage.setItem(STORAGE_KEYS.CHANNELS, JSON.stringify(channels));
}

export async function getSettings() {
  const data = await AsyncStorage.getItem(STORAGE_KEYS.SETTINGS);
  if (data) {
    const settings = JSON.parse(data);
    // Migrate pollInterval → nagInterval
    if (settings.pollInterval && !settings.nagInterval) {
      settings.nagInterval = settings.pollInterval;
      delete settings.pollInterval;
      await saveSettings(settings);
    }
    return { ...DEFAULT_SETTINGS, ...settings };
  }
  await saveSettings(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS };
}

export async function saveSettings(settings) {
  await AsyncStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
}

export async function getLastSeen() {
  const data = await AsyncStorage.getItem(STORAGE_KEYS.LAST_SEEN);
  return data ? JSON.parse(data) : {};
}

export async function saveLastSeen(lastSeen) {
  await AsyncStorage.setItem(STORAGE_KEYS.LAST_SEEN, JSON.stringify(lastSeen));
}

export async function getChannelCache() {
  const data = await AsyncStorage.getItem(STORAGE_KEYS.CHANNEL_CACHE);
  return data ? JSON.parse(data) : {};
}

export async function saveChannelCache(cache) {
  await AsyncStorage.setItem(STORAGE_KEYS.CHANNEL_CACHE, JSON.stringify(cache));
}

// Per-channel notification settings
// Shape: { [handle]: { notificationMode, dndEnabled, dndStart, dndEnd } }
export async function getChannelNotifSettings() {
  const data = await AsyncStorage.getItem(STORAGE_KEYS.CHANNEL_NOTIF_SETTINGS);
  return data ? JSON.parse(data) : {};
}

export async function saveChannelNotifSettings(settings) {
  await AsyncStorage.setItem(STORAGE_KEYS.CHANNEL_NOTIF_SETTINGS, JSON.stringify(settings));
}

// Per-channel display settings
// Shape: { [handle]: { latestVideosPerChannel } }  — null/undefined means inherit global
export async function getChannelDisplaySettings() {
  const data = await AsyncStorage.getItem(STORAGE_KEYS.CHANNEL_DISPLAY_SETTINGS);
  return data ? JSON.parse(data) : {};
}

export async function saveChannelDisplaySettings(settings) {
  await AsyncStorage.setItem(STORAGE_KEYS.CHANNEL_DISPLAY_SETTINGS, JSON.stringify(settings));
}

export async function getLastReconcileAt() {
  const data = await AsyncStorage.getItem(STORAGE_KEYS.LAST_RECONCILE_AT);
  return data ? parseInt(data, 10) : 0;
}

export async function saveLastReconcileAt(ts) {
  await AsyncStorage.setItem(STORAGE_KEYS.LAST_RECONCILE_AT, String(ts));
}

export async function getChannelNotifSetting(handle) {
  const all = await getChannelNotifSettings();
  return all[handle] || null;
}

export async function saveChannelNotifSetting(handle, setting) {
  const all = await getChannelNotifSettings();
  all[handle] = setting;
  await saveChannelNotifSettings(all);
}
