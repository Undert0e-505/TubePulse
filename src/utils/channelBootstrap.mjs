const CHANNEL_NOT_TRACKED_ERROR = 'Channel not tracked by this device';

/**
 * Bootstrap a locally configured channel and repair a missing server-side
 * subscription when a prior device-identity change left the local reconcile
 * throttle ahead of the new device profile.
 *
 * The retry is deliberately limited to the API's exact "not tracked" 404.
 * Registration failures and unrelated bootstrap errors remain visible to the
 * caller instead of being hidden behind an unnecessary subscribe request.
 */
export async function bootstrapTrackedChannel({
  deviceId,
  channelId,
  bootstrapChannel,
  subscribeChannel,
}) {
  let result = await bootstrapChannel(deviceId, channelId);

  if (
    result?.ok
    || result?.status !== 404
    || result?.error !== CHANNEL_NOT_TRACKED_ERROR
  ) {
    return result;
  }

  const subscription = await subscribeChannel(deviceId, channelId);
  if (!subscription?.ok) {
    return {
      ...result,
      subscriptionError: subscription?.error || 'Channel subscription failed',
    };
  }

  result = await bootstrapChannel(deviceId, channelId);
  return result;
}
