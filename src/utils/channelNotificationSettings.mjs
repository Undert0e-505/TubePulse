export function prepareChannelNotificationSettings(settings = {}) {
  const { latestVideosPerChannel = null, ...notificationSettings } = settings;
  const overridePayload = Object.fromEntries(
    Object.entries(notificationSettings).filter(([, value]) => value !== null),
  );

  return {
    notificationSettings,
    latestVideosPerChannel,
    overridePayload,
  };
}
