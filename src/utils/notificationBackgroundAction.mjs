import { NOTIFICATION_ACTIONS, isNotificationAction } from './localNotificationSilence.mjs';
import { normalizeNotificationActionResponse } from './notificationResponseNormalization.mjs';

export async function processBackgroundNotificationActionPayload({ data, error }, {
  processSeen,
  processSilence,
  warn = () => {},
}) {
  if (error || !data || typeof data !== 'object' || !('actionIdentifier' in data)) {
    return { handled: false, reason: error ? 'task-error' : 'not-action-response' };
  }
  if (!isNotificationAction(data.actionIdentifier)) {
    return { handled: false, reason: 'unknown-action' };
  }

  const normalized = normalizeNotificationActionResponse(data);
  if (!normalized.valid) {
    warn(`[notifications] Background action ignored: ${normalized.reason}`);
    return { handled: false, reason: normalized.reason };
  }

  if (normalized.response.actionIdentifier === NOTIFICATION_ACTIONS.MARK_SEEN) {
    return await processSeen(normalized.response);
  }
  return await processSilence(normalized.response);
}
