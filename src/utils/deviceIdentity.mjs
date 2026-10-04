/**
 * Build a process-stable device-ID resolver.
 *
 * React can request the ID from multiple mounted components during the first
 * launch. SecureStore's individual operations are safe, but a read followed by
 * a generated write is not atomic. Sharing the complete resolution promise
 * prevents concurrent callers from minting different IDs.
 */
export function createDeviceIdResolver({
  secureStore,
  application,
  asyncStorage,
  secureStoreKey,
  fallbackStorageKey,
  generateUuid,
  warn = () => {},
}) {
  let resolutionPromise = null;

  async function resolveDeviceId() {
    try {
      const secureId = await secureStore.getItemAsync(secureStoreKey);
      if (secureId && typeof secureId === 'string') return secureId;

      const newId = `secure:${generateUuid()}`;
      await secureStore.setItemAsync(secureStoreKey, newId);
      return newId;
    } catch (error) {
      warn('[deviceId] SecureStore unavailable, falling back to Android ID:', error?.message || error);
    }

    try {
      const androidId = application.getAndroidId();
      if (androidId && typeof androidId === 'string') return `android:${androidId}`;
    } catch (error) {
      warn('[deviceId] Application.getAndroidId() failed, falling back to AsyncStorage UUID:', error?.message || error);
    }

    let fallbackId = await asyncStorage.getItem(fallbackStorageKey);
    if (!fallbackId) {
      fallbackId = `uuid:${generateUuid()}`;
      await asyncStorage.setItem(fallbackStorageKey, fallbackId);
    }
    return fallbackId;
  }

  return function getDeviceId() {
    if (!resolutionPromise) {
      resolutionPromise = resolveDeviceId().catch((error) => {
        resolutionPromise = null;
        throw error;
      });
    }
    return resolutionPromise;
  };
}
