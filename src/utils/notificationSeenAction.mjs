import { parseNotificationContentIds } from './notificationTap.mjs';
import { isSnapshotSpecificNotificationIdentifier } from './notificationIdentity.mjs';
import { notificationResponseData } from './notificationResponseNormalization.mjs';

export function notificationSeenDetails(response) {
  const request = response?.notification?.request;
  const resolved = notificationResponseData(response);
  const data = resolved.data || (
    response?.data && typeof response.data === 'object' && !Array.isArray(response.data)
      ? response.data
      : {}
  );
  const channelId = String(data.channelId || '').trim();
  const contentIds = parseNotificationContentIds(data);
  if (!channelId || contentIds.length === 0 || data.type === 'prewarn') return null;
  return {
    channelId,
    contentIds,
    notificationIdentifier: request?.identifier || null,
  };
}

export function notificationIdsAreCovered(data, seenIds) {
  const represented = parseNotificationContentIds(data || {});
  return represented.length > 0 && represented.every((id) => seenIds.has(id));
}

export async function dismissExactSeenNotification(notifications, {
  contentIds,
  notificationIdentifier,
}) {
  if (!notificationIdentifier) return { dismissed: false, reason: 'missing-identifier' };

  // v4.3.0 post-fix notifications have a per-presentation request ID. Android
  // cancellation is keyed by that exact ID, so cancelling it cannot affect a
  // newer same-tag notification and needs no potentially slow enumeration.
  if (isSnapshotSpecificNotificationIdentifier(notificationIdentifier)) {
    await notifications.dismissNotificationAsync(notificationIdentifier);
    return { dismissed: true, reason: 'snapshot-identifier' };
  }

  // Compatibility for notifications already displayed by the released build,
  // which reused one request ID per channel. Verify its current payload before
  // cancelling so an older action cannot hide a newer replacement.
  const presented = await notifications.getPresentedNotificationsAsync();
  const current = presented.find(
    (notification) => notification?.request?.identifier === notificationIdentifier,
  );
  if (!current) return { dismissed: false, reason: 'not-presented' };

  const currentData = current?.request?.content?.data || {};
  if (!notificationIdsAreCovered(currentData, new Set(contentIds))) {
    return { dismissed: false, reason: 'newer-replacement' };
  }

  await notifications.dismissNotificationAsync(notificationIdentifier);
  return { dismissed: true, reason: 'covered' };
}

async function boundedOperation(operation, timeoutMs) {
  if (!(Number(timeoutMs) > 0)) return await operation();
  let timeout;
  const running = Promise.resolve().then(operation);
  // If the timeout wins, retain a rejection handler on the native operation
  // so a later failure cannot become an unhandled rejection.
  running.catch(() => {});
  try {
    return await Promise.race([
      running,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Notification surface update timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function handleNotificationSeenResponse(response, {
  enqueue,
  dismissExact,
  applyLocal,
  flush,
  dismissCovered,
  updateSurface,
  surfaceTimeoutMs = 2_000,
}) {
  const details = notificationSeenDetails(response);
  if (!details) return { handled: false };

  // The durable exact-ID intent is the commit point. Later arrivals can never
  // be consumed by a retry because clearAll is deliberately not represented.
  await enqueue(details);
  const localErrors = [];

  // Android does not auto-cancel custom notification actions. A background
  // task can be stopped at any await, so acknowledge the exact tapped
  // notification immediately after the durable commit point and before cache,
  // widget or network work. This remains best effort; the seen action must
  // continue even if Android no longer exposes the notification.
  try { await dismissExact(details); }
  catch (error) { localErrors.push({ stage: 'exact-dismiss', error }); }

  for (const [stage, operation] of [
    ['local', applyLocal],
    ['dismiss', dismissCovered],
    ['surface', (value) => boundedOperation(() => updateSurface(value), surfaceTimeoutMs)],
  ]) {
    try { await operation(details); }
    catch (error) { localErrors.push({ stage, error }); }
  }
  const delivery = await flush(details);
  return { handled: true, ...details, delivery, localErrors };
}
