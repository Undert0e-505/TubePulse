import { LOCAL_NOTIFICATION_CAPABILITY } from './localNotificationSilence.mjs';

export function buildRegistrationPayload({
  fcmToken,
  platform = 'android',
  appVersion,
  notificationCapability = LOCAL_NOTIFICATION_CAPABILITY,
} = {}) {
  const normalizedVersion = typeof appVersion === 'string' && appVersion.trim()
    ? appVersion.trim()
    : null;
  return {
    fcmToken: fcmToken || null,
    platform,
    appVersion: normalizedVersion,
    notificationCapability: notificationCapability === LOCAL_NOTIFICATION_CAPABILITY
      ? LOCAL_NOTIFICATION_CAPABILITY
      : null,
  };
}
