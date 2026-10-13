import { parseNotificationContentIds } from './notificationTap.mjs';

export function notificationTag(data = {}) {
  return data.notificationTag
    || (data.videoId ? `video-${data.videoId}` : null)
    || (data.activityId ? `post-${data.activityId}` : null)
    || null;
}

function safeIdentifierPart(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(-96);
}

function snapshotHash(data = {}) {
  const value = parseNotificationContentIds(data).join('\u001f');
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function notificationPresentationIdentifier(data = {}, messageId = null) {
  const tag = notificationTag(data);
  if (!tag) return `local-${safeIdentifierPart(messageId) || Date.now()}`;
  const revision = safeIdentifierPart(messageId) || `snapshot-${snapshotHash(data)}`;
  return `local-${tag}-event-${revision}`;
}

export function isSnapshotSpecificNotificationIdentifier(identifier) {
  return String(identifier || '').includes('-event-');
}
