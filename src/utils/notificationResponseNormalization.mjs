const MAX_ACTION_DATA_STRING_LENGTH = 64 * 1024;

function isDataObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function notificationResponseData(response) {
  const content = response?.notification?.request?.content;
  if (!content || typeof content !== 'object') {
    return { data: null, source: null, reason: 'missing-content' };
  }

  // Foreground/listener responses have already been mapped by Expo. Never
  // replace their data with the raw compatibility field.
  if (isDataObject(content.data)) {
    return { data: content.data, source: 'data', reason: null };
  }

  const raw = content.dataString;
  if (typeof raw !== 'string') {
    return { data: null, source: null, reason: 'missing-data' };
  }
  if (raw.length === 0 || raw.length > MAX_ACTION_DATA_STRING_LENGTH) {
    return { data: null, source: null, reason: raw.length === 0 ? 'empty-data' : 'oversized-data' };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isDataObject(parsed)) {
      return { data: null, source: null, reason: 'invalid-data-shape' };
    }
    return { data: parsed, source: 'dataString', reason: null };
  } catch {
    return { data: null, source: null, reason: 'malformed-data' };
  }
}

export function normalizeNotificationActionResponse(response) {
  const resolved = notificationResponseData(response);
  if (!resolved.data) {
    return { response, valid: false, normalized: false, reason: resolved.reason };
  }
  if (resolved.source === 'data') {
    return { response, valid: true, normalized: false, reason: null };
  }

  const request = response.notification.request;
  return {
    response: {
      ...response,
      notification: {
        ...response.notification,
        request: {
          ...request,
          content: { ...request.content, data: resolved.data },
        },
      },
    },
    valid: true,
    normalized: true,
    reason: null,
  };
}
