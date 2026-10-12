import { parseNotificationContentIds } from './notificationTap.mjs';

export function notificationSeenDetails(response) {
  const request = response?.notification?.request;
  const data = request?.content?.data || response?.data || {};
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

export async function handleNotificationSeenResponse(response, {
  enqueue,
  applyLocal,
  flush,
  dismissCovered,
  updateSurface,
}) {
  const details = notificationSeenDetails(response);
  if (!details) return { handled: false };

  // The durable exact-ID intent is the commit point. Later arrivals can never
  // be consumed by a retry because clearAll is deliberately not represented.
  await enqueue(details);
  const localErrors = [];
  for (const [stage, operation] of [
    ['local', applyLocal],
    ['surface', updateSurface],
    ['dismiss', dismissCovered],
  ]) {
    try { await operation(details); }
    catch (error) { localErrors.push({ stage, error }); }
  }
  const delivery = await flush(details);
  return { handled: true, ...details, delivery, localErrors };
}
