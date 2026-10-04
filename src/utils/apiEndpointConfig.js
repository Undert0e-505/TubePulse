import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from './constants';
import {
  createRuntimeEndpointResolver,
  testTubePulseHomeOrigin,
} from './previewEndpoint.mjs';
import { DEFAULT_TUBEPULSE_API_URL } from './apiEndpointPolicy.mjs';
import { APP_INITIALIZATION_STORAGE_KEY } from './appInitialization.mjs';

// Expo embeds EXPO_PUBLIC_* values only when referenced directly like this.
// Normal builds leave PREVIEW unset and retain the historical production policy.
export const IS_TUBEPULSE_PREVIEW = process.env.EXPO_PUBLIC_TUBEPULSE_PREVIEW === '1';
export const PREVIEW_DEFAULT_ORIGIN = process.env.EXPO_PUBLIC_TUBEPULSE_PREVIEW_DEFAULT_URL || '';
export const PREVIEW_PUSH_ENABLED = !IS_TUBEPULSE_PREVIEW
  || process.env.EXPO_PUBLIC_TUBEPULSE_PREVIEW_PUSH_ENABLED === '1';

const productionPrimaryUrl = process.env.EXPO_PUBLIC_TUBEPULSE_API_URL || DEFAULT_TUBEPULSE_API_URL;
const productionFallbackUrl = process.env.EXPO_PUBLIC_TUBEPULSE_FALLBACK_API_URL || '';
const endpointResolver = createRuntimeEndpointResolver({
  preview: IS_TUBEPULSE_PREVIEW,
  storage: AsyncStorage,
  productionPrimaryUrl,
  productionFallbackUrl,
});
const endpointChangeListeners = new Set();

export async function getConfiguredPreviewOrigin() {
  return await endpointResolver.getPreviewOrigin();
}

export async function saveConfiguredPreviewOrigin(value) {
  const previous = await endpointResolver.getPreviewOrigin();
  const origin = await endpointResolver.setPreviewOrigin(value);
  if (origin !== previous) {
    // Reconcile against the new Home immediately instead of allowing the
    // four-hour throttle from the previous Home to carry over.
    await AsyncStorage.multiRemove([
      STORAGE_KEYS.LAST_RECONCILE_AT,
      APP_INITIALIZATION_STORAGE_KEY,
    ]);
    for (const listener of endpointChangeListeners) listener(origin);
  }
  return origin;
}

export async function testPreviewOrigin(value) {
  if (!IS_TUBEPULSE_PREVIEW) {
    return { ok: false, error: 'Preview server configuration is unavailable in the production app.' };
  }
  return await testTubePulseHomeOrigin(value, { fetchImpl: fetch, allowLanHttp: true });
}

export function subscribeToPreviewOriginChanges(listener) {
  if (!IS_TUBEPULSE_PREVIEW) return () => {};
  endpointChangeListeners.add(listener);
  return () => endpointChangeListeners.delete(listener);
}

export async function getApiEndpointPolicy() {
  return await endpointResolver.endpointPolicy();
}

export function resetApiEndpointPolicy() {
  endpointResolver.reset();
}
