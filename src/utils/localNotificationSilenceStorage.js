import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  LOCAL_NOTIFICATION_SILENCE_STORAGE_KEY,
  applyNotificationSilenceAction,
  channelSilenceUntil,
  clearAllNotificationSilence,
  emptySilenceState,
  isNotificationSilenced,
  notificationSilencePresentation,
  normalizeSilenceState,
  resumeChannelSound,
} from './localNotificationSilence.mjs';

const listeners = new Set();

function notifyListeners(state) {
  for (const listener of listeners) {
    try { listener(state); } catch { /* one screen must not block persistence */ }
  }
}

export function subscribeLocalNotificationSilence(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function readLocalNotificationSilence(now = Date.now()) {
  try {
    const raw = await AsyncStorage.getItem(LOCAL_NOTIFICATION_SILENCE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : emptySilenceState();
    const normalized = normalizeSilenceState(parsed, now);
    if (raw && JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      await AsyncStorage.setItem(LOCAL_NOTIFICATION_SILENCE_STORAGE_KEY, JSON.stringify(normalized));
    }
    return normalized;
  } catch {
    return emptySilenceState();
  }
}

async function saveState(state) {
  await AsyncStorage.setItem(LOCAL_NOTIFICATION_SILENCE_STORAGE_KEY, JSON.stringify(state));
  notifyListeners(state);
  return state;
}

export async function applyLocalNotificationAction(actionIdentifier, channelId, now = Date.now()) {
  const state = await readLocalNotificationSilence(now);
  return await saveState(applyNotificationSilenceAction(state, actionIdentifier, channelId, now));
}

export async function notificationShouldBeSilent(channelId, now = Date.now()) {
  return isNotificationSilenced(await readLocalNotificationSilence(now), channelId, now);
}

export async function getLocalNotificationPresentation(channelId, now = Date.now()) {
  return notificationSilencePresentation(
    await readLocalNotificationSilence(now),
    channelId,
    now,
  );
}

export async function resumeAllNotificationSound(now = Date.now()) {
  return await saveState(clearAllNotificationSilence());
}

export async function resumeChannelNotificationSound(channelId, now = Date.now()) {
  return await saveState(resumeChannelSound(await readLocalNotificationSilence(now), channelId, now));
}

export async function getChannelSilenceUntil(channelId, now = Date.now()) {
  return channelSilenceUntil(await readLocalNotificationSilence(now), channelId, now);
}
