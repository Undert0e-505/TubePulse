// Expo inlines direct EXPO_PUBLIC_* references at build time. Ordinary builds
// leave both unset. Preview exercise example:
// EXPO_PUBLIC_TUBEPULSE_UPDATE_DEMO=1 EXPO_PUBLIC_TUBEPULSE_UPDATE_DEMO_TAG=v4.0.1
export const UPDATE_INDICATOR_DEMO = process.env.EXPO_PUBLIC_TUBEPULSE_UPDATE_DEMO === '1';
export const UPDATE_INDICATOR_DEMO_TAG = process.env.EXPO_PUBLIC_TUBEPULSE_UPDATE_DEMO_TAG || '';

if (UPDATE_INDICATOR_DEMO_TAG
  && !/^(?:v)?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(UPDATE_INDICATOR_DEMO_TAG)) {
  throw new Error('EXPO_PUBLIC_TUBEPULSE_UPDATE_DEMO_TAG must be a stable semantic version tag');
}
