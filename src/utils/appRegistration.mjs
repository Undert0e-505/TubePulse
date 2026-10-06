export function buildRegistrationPayload({ fcmToken, platform = 'android', appVersion } = {}) {
  const normalizedVersion = typeof appVersion === 'string' && appVersion.trim()
    ? appVersion.trim()
    : null;
  return {
    fcmToken: fcmToken || null,
    platform,
    appVersion: normalizedVersion,
  };
}
