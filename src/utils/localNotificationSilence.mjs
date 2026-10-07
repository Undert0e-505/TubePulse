export const LOCAL_NOTIFICATION_CAPABILITY = 'local-v1';
export const LOCAL_NOTIFICATION_CATEGORY = 'tubepulse_local_mute';
export const LOCAL_NOTIFICATION_CHANNEL_MUTED_CATEGORY = 'tubepulse_local_channel_muted';
export const LOCAL_NOTIFICATION_GLOBAL_MUTED_CATEGORY = 'tubepulse_local_global_muted';
export const LOCAL_NOTIFICATION_SILENCE_STORAGE_KEY = '@tubepulse/local-notification-silence-v1';

export const NOTIFICATION_ACTIONS = Object.freeze({
  MUTE_CHANNEL_1H: 'TUBEPULSE_MUTE_CHANNEL_1H',
  MUTE_CHANNEL_8H: 'TUBEPULSE_MUTE_CHANNEL_8H',
  MUTE_ALL: 'TUBEPULSE_MUTE_ALL',
  UNMUTE_CHANNEL: 'TUBEPULSE_UNMUTE_CHANNEL',
  UNMUTE_ALL: 'TUBEPULSE_UNMUTE_ALL',
});

const ACTION_DURATIONS_MS = Object.freeze({
  [NOTIFICATION_ACTIONS.MUTE_CHANNEL_1H]: 60 * 60 * 1000,
  [NOTIFICATION_ACTIONS.MUTE_CHANNEL_8H]: 8 * 60 * 60 * 1000,
});

export function emptySilenceState() {
  return { globalMuted: false, channels: {}, audibleOverrides: {} };
}

export function normalizeSilenceState(value, now = Date.now()) {
  const state = emptySilenceState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return state;
  state.globalMuted = value.globalMuted === true;
  if (value.channels && typeof value.channels === 'object' && !Array.isArray(value.channels)) {
    for (const [channelId, expiresAt] of Object.entries(value.channels)) {
      if (typeof channelId !== 'string' || !channelId) continue;
      const timestamp = Number(expiresAt);
      if (Number.isFinite(timestamp) && timestamp > now) state.channels[channelId] = timestamp;
    }
  }
  if (
    state.globalMuted
    && value.audibleOverrides
    && typeof value.audibleOverrides === 'object'
    && !Array.isArray(value.audibleOverrides)
  ) {
    for (const [channelId, enabled] of Object.entries(value.audibleOverrides)) {
      if (typeof channelId === 'string' && channelId && enabled === true) {
        state.audibleOverrides[channelId] = true;
      }
    }
  }
  return state;
}

export function isNotificationSilenced(state, channelId, now = Date.now()) {
  const normalized = normalizeSilenceState(state, now);
  const channelTimedMute = Boolean(channelId && normalized.channels[channelId] > now);
  const globallyMuted = normalized.globalMuted
    && !(channelId && normalized.audibleOverrides[channelId] === true);
  return globallyMuted || channelTimedMute;
}

export function applyNotificationSilenceAction(state, actionIdentifier, channelId, now = Date.now()) {
  const next = normalizeSilenceState(state, now);
  if (actionIdentifier === NOTIFICATION_ACTIONS.UNMUTE_ALL) {
    return emptySilenceState();
  }
  if (actionIdentifier === NOTIFICATION_ACTIONS.UNMUTE_CHANNEL) {
    return resumeChannelSound(next, channelId, now);
  }
  if (actionIdentifier === NOTIFICATION_ACTIONS.MUTE_ALL) {
    next.globalMuted = true;
    next.audibleOverrides = {};
    return next;
  }
  const duration = ACTION_DURATIONS_MS[actionIdentifier];
  if (!duration || !channelId) return next;
  delete next.audibleOverrides[channelId];
  next.channels[channelId] = now + duration;
  return next;
}

export function resumeGlobalSound(state, now = Date.now()) {
  return {
    ...normalizeSilenceState(state, now),
    globalMuted: false,
    audibleOverrides: {},
  };
}

export function clearAllNotificationSilence() {
  return emptySilenceState();
}

export function resumeChannelSound(state, channelId, now = Date.now()) {
  const next = normalizeSilenceState(state, now);
  if (channelId) {
    delete next.channels[channelId];
    if (next.globalMuted) next.audibleOverrides[channelId] = true;
  }
  return next;
}

export function channelSilenceUntil(state, channelId, now = Date.now()) {
  const normalized = normalizeSilenceState(state, now);
  return channelId ? normalized.channels[channelId] || null : null;
}

export function nextNotificationSilenceExpiry(state, now = Date.now()) {
  const normalized = normalizeSilenceState(state, now);
  const expiries = Object.values(normalized.channels);
  return expiries.length ? Math.min(...expiries) : null;
}

export function notificationSilencePresentation(state, channelId, now = Date.now()) {
  const normalized = normalizeSilenceState(state, now);
  const silent = isNotificationSilenced(normalized, channelId, now);
  if (normalized.globalMuted && silent) {
    return {
      silent: true,
      categoryIdentifier: LOCAL_NOTIFICATION_GLOBAL_MUTED_CATEGORY,
    };
  }
  if (silent) {
    return {
      silent: true,
      categoryIdentifier: LOCAL_NOTIFICATION_CHANNEL_MUTED_CATEGORY,
    };
  }
  return {
    silent: false,
    categoryIdentifier: LOCAL_NOTIFICATION_CATEGORY,
  };
}

export function formatNotificationSilenceStatus(expiresAt, now = Date.now(), locales) {
  if (expiresAt == null) return 'Silent';
  const timestamp = Number(expiresAt);
  if (!Number.isFinite(timestamp) || timestamp <= now) return null;
  const time = new Intl.DateTimeFormat(locales, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
  return `Silent until ${time}`;
}

export function isNotificationAction(actionIdentifier) {
  return Object.values(NOTIFICATION_ACTIONS).includes(actionIdentifier);
}

export function notificationResponseRoute(actionIdentifier, defaultActionIdentifier) {
  if (isNotificationAction(actionIdentifier)) return 'silence';
  return actionIdentifier === defaultActionIdentifier ? 'default' : 'ignore';
}
