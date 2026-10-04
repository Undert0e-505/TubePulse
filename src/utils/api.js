/**
 * TubePulse API Client — v3.0 (channel-first architecture)
 *
 * REST client for the tubepulse-api Cloudflare Worker.
 * Uses a persistent device ID as authentication. The device ID
 * is sourced from a 3-tier priority chain (secure store → Android
 * ID → AsyncStorage UUID) — see getDeviceId() below for the full
 * rationale and cross-version migration notes.
 *
 * Key changes from v2:
 * - POST /subscribe-channel + POST /unsubscribe replace PUT /channels
 * - POST /bootstrap replaces GET /bootstrap
 * - POST /settings replaces PUT /settings
 * - POST /channel-override (new)
 * - GET /feed returns { channels: [{ channelId, meta, videos, unwatchedCount }] }
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import * as SecureStore from 'expo-secure-store';
import {
  fetchWithEndpointFailover,
} from './apiEndpointPolicy.mjs';
import {
  getApiEndpointPolicy,
  resetApiEndpointPolicy,
} from './apiEndpointConfig';
import { createDeviceIdResolver } from './deviceIdentity.mjs';

const DEVICE_ID_KEY = 'tubepulse_device_id'; // AsyncStorage (fallback)
const SECURE_DEVICE_ID_KEY = 'tubepulse_device_id_v1'; // Keystore/Keychain (primary)

function _generateUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Get a persistent device ID for this install.
 *
 * Three-tier resolution, preferred in order:
 *
 * 1. **Secure store** (`expo-secure-store` → Android Keystore / iOS Keychain).
 *    Encrypted at rest, hardware-backed on most modern devices, scoped
 *    to the app's signing key. Wiped automatically on uninstall.
 *    Survives app updates, data clears, factory resets (with backup
 *    restore). Invalidated if the user changes biometrics. This is
 *    the right primitive for "per-install identity that the user
 *    can't easily lose but we can re-issue on uninstall".
 *
 * 2. **Android ID** (`Application.getAndroidId()` from expo-application).
 *    Synchronous, race-free, per-app-install. Used as a fallback when
 *    the Keystore is unavailable (some older devices, broken Keystores,
 *    Expo Go). Same lifecycle as secure store (reset on uninstall).
 *
 * 3. **AsyncStorage UUID**. Last-resort fallback when neither native
 *    identity source is available.
 *
 * The complete read-or-create resolution is protected by one module-level
 * promise. Concurrent first-launch callers therefore receive the same ID,
 * including while the SecureStore value is still being created. All three
 * paths return a Promise<string>; callers don't need to know which path was
 * used. The server treats all of them as a stable per-install identifier.
 *
 * Cross-tier stability: a v3.0.19 install with `android:abc...` that
 * upgrades to v3.0.20 will get a fresh `secure:xyz...` on first
 * launch (because secure store is empty on upgrade). The server's
 * `/register` migration block detects the FCM token matches the old
 * profile and migrates state to the new deviceId. Same mechanism as
 * the v3.0.18→v3.0.19 migration.
 */
const resolveDeviceId = createDeviceIdResolver({
  secureStore: SecureStore,
  application: Application,
  asyncStorage: AsyncStorage,
  secureStoreKey: SECURE_DEVICE_ID_KEY,
  fallbackStorageKey: DEVICE_ID_KEY,
  generateUuid: _generateUuid,
  warn: (...args) => console.warn(...args),
});

export async function getDeviceId() {
  return await resolveDeviceId();
}

async function apiFetch(path, options = {}) {
  const { deviceId, body, method = 'GET' } = options;

  const headers = {
    'Content-Type': 'application/json',
  };

  if (deviceId) {
    headers['Authorization'] = `Bearer ${deviceId}`;
  }

  const fetchOptions = {
    method,
    headers,
  };

  if (body !== undefined) {
    fetchOptions.body = JSON.stringify(body);
  }

  try {
    const endpointPolicy = await getApiEndpointPolicy();
    const resp = await fetchWithEndpointFailover({
      policy: endpointPolicy,
      path,
      init: fetchOptions,
      fetchImpl: fetch,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      console.error(`API ${method} ${path} failed:`, resp.status, err);
      return { ok: false, error: err.error || resp.statusText, status: resp.status };
    }

    const data = await resp.json();
    return { ok: true, ...data };
  } catch (err) {
    console.error(`API ${method} ${path} network error:`, err.message);
    return { ok: false, error: 'Network error' };
  }
}

/**
 * Explicitly clear process-lifetime fallback stickiness. The app never calls
 * this automatically; it exists for tests and deliberate recovery tooling.
 */
export function resetApiFailoverEndpoint() {
  resetApiEndpointPolicy();
}

/**
 * Register device with the API Worker.
 * Called on app launch and token refresh.
 * Only sends profile data (FCM token) — channels and settings are separate.
 */
export async function registerDevice(deviceId, fcmToken, platform = 'android', appVersion = null) {
  return await apiFetch('/register', {
    method: 'POST',
    deviceId,
    body: { fcmToken, platform, appVersion },
  });
}

/**
 * Subscribe to a channel.
 * Replaces the old PUT /channels (full list replacement) with per-channel subscribe.
 */
export async function subscribeChannel(deviceId, channelId) {
  return await apiFetch('/subscribe-channel', {
    method: 'POST',
    deviceId,
    body: { channelId },
  });
}

/**
 * Unsubscribe from a channel.
 * Replaces the old PUT /channels with per-channel unsubscribe.
 */
export async function unsubscribeChannel(deviceId, channelId) {
  return await apiFetch('/unsubscribe', {
    method: 'POST',
    deviceId,
    body: { channelId },
  });
}

/**
 * Get the device's IANA timezone (e.g. "Europe/London").
 * Falls back to "UTC" if Intl is unavailable (very old runtimes).
 */
export function getLocalTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Convert local settings shape to the server-expected shape.
 * Local uses `notificationMode` (UX-friendly); server uses `mode` (compact).
 * Also stamps the current device timezone so DND works regardless of the
 * worker's UTC clock.
 */
function toServerSettings(local) {
  if (!local) return local;
  const { notificationMode, ...rest } = local;
  return {
    ...rest,
    mode: notificationMode ?? 'chill',
    dndTimezone: getLocalTimezone(),
  };
}

/**
 * Update notification settings (full replacement).
 * The local settings shape is automatically converted to the server shape.
 */
export async function updateSettings(deviceId, settings) {
  return await apiFetch('/settings', {
    method: 'POST',
    deviceId,
    body: { settings: toServerSettings(settings) },
  });
}

/**
 * Set or update per-channel notification override.
 * Empty override deletes the override (inherits from device-level).
 */
export async function setChannelOverride(deviceId, channelId, override) {
  return await apiFetch('/channel-override', {
    method: 'POST',
    deviceId,
    body: { channelId, override },
  });
}

/**
 * Mark video(s) as seen.
 */
export async function markSeen(deviceId, channelId, videoIds = [], clearAll = false) {
  const body = { channelId };
  if (clearAll) {
    body.clearAll = true;
  } else {
    body.videoIds = videoIds;
  }
  return await apiFetch('/seen', {
    method: 'POST',
    deviceId,
    body,
  });
}

/**
 * Fetch current feed data from the server.
 * Returns { channels: [{ channelId, meta, videos, unwatchedCount }] }
 */
export async function fetchFeed(deviceId) {
  return await apiFetch('/feed', {
    method: 'GET',
    deviceId,
  });
}

/**
 * Bootstrap a newly added channel — fetches RSS + avatar from server synchronously.
 * Now POST instead of GET.
 */
export async function bootstrapChannel(deviceId, channelId) {
  return await apiFetch('/bootstrap', {
    method: 'POST',
    deviceId,
    body: { channelId },
  });
}

/**
 * Resolve a YouTube handle to channelId + name + avatar.
 */
export async function resolveHandle(deviceId, handle) {
  const clean = handle.replace(/^@/, '');
  return await apiFetch(`/resolve?handle=@${encodeURIComponent(clean)}`, {
    deviceId,
  });
}
