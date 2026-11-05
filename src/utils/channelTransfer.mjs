const FORMAT = 'tubepulse-backup';
export const CHANNEL_TRANSFER_SCHEMA_VERSION = 1;
export const CHANNEL_TRANSFER_MAX_CHANNELS = 100;
export const CHANNEL_TRANSFER_MAX_BYTES = 512 * 1024;

const GLOBAL_SETTING_KEYS = Object.freeze([
  'tapAction',
  'autoOrderChannels',
  'notificationMode',
  'nagInterval',
  'includeCommunityPosts',
  'dndEnabled',
  'dndStart',
  'dndEnd',
  'perChannelNotifications',
  'prewarnMinutes',
  'latestVideosPerChannel',
]);

const NOTIFICATION_SETTING_KEYS = Object.freeze([
  'notificationMode',
  'dndEnabled',
  'dndStart',
  'dndEnd',
  'includeCommunityPosts',
  'prewarnMinutes',
]);

const DISPLAY_SETTING_KEYS = Object.freeze(['latestVideosPerChannel']);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickKnown(source, keys) {
  if (!isRecord(source)) return {};
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
}

function validTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function sanitizeGlobalSettings(source) {
  const candidate = pickKnown(source, GLOBAL_SETTING_KEYS);
  const clean = {};
  if (candidate.tapAction === 'video' || candidate.tapAction === 'channel') clean.tapAction = candidate.tapAction;
  if (typeof candidate.autoOrderChannels === 'boolean') clean.autoOrderChannels = candidate.autoOrderChannels;
  if (candidate.notificationMode === 'chill' || candidate.notificationMode === 'relentless') clean.notificationMode = candidate.notificationMode;
  if ([5, 15, 30, 60, 120].includes(candidate.nagInterval)) clean.nagInterval = candidate.nagInterval;
  if (typeof candidate.includeCommunityPosts === 'boolean') clean.includeCommunityPosts = candidate.includeCommunityPosts;
  if (typeof candidate.dndEnabled === 'boolean') clean.dndEnabled = candidate.dndEnabled;
  if (validTime(candidate.dndStart)) clean.dndStart = candidate.dndStart;
  if (validTime(candidate.dndEnd)) clean.dndEnd = candidate.dndEnd;
  if (typeof candidate.perChannelNotifications === 'boolean') clean.perChannelNotifications = candidate.perChannelNotifications;
  if ([15, 30, 60, 120, 240, 1440].includes(candidate.prewarnMinutes)) clean.prewarnMinutes = candidate.prewarnMinutes;
  if ([1, 2, 3].includes(candidate.latestVideosPerChannel)) clean.latestVideosPerChannel = candidate.latestVideosPerChannel;
  return clean;
}

function sanitizeNotificationSettings(source) {
  const candidate = pickKnown(source, NOTIFICATION_SETTING_KEYS);
  const clean = {};
  if (candidate.notificationMode === 'chill' || candidate.notificationMode === 'relentless') clean.notificationMode = candidate.notificationMode;
  if (typeof candidate.dndEnabled === 'boolean') clean.dndEnabled = candidate.dndEnabled;
  if (validTime(candidate.dndStart)) clean.dndStart = candidate.dndStart;
  if (validTime(candidate.dndEnd)) clean.dndEnd = candidate.dndEnd;
  if ([null, true, false].includes(candidate.includeCommunityPosts)) clean.includeCommunityPosts = candidate.includeCommunityPosts;
  if (candidate.prewarnMinutes === null || [15, 30, 60, 120, 240, 1440].includes(candidate.prewarnMinutes)) {
    clean.prewarnMinutes = candidate.prewarnMinutes;
  }
  return clean;
}

function sanitizeDisplaySettings(source) {
  const candidate = pickKnown(source, DISPLAY_SETTING_KEYS);
  return [1, 2, 3].includes(candidate.latestVideosPerChannel)
    ? { latestVideosPerChannel: candidate.latestVideosPerChannel }
    : {};
}

export function normalizeTransferHandle(value) {
  if (typeof value !== 'string') return null;
  const handle = value.trim().replace(/^@+/, '');
  if (!handle || handle.length > 100 || /[\s/\\?#]/u.test(handle)) return null;
  return handle;
}

function channelKey(channel) {
  if (channel?.channelId) return `id:${String(channel.channelId)}`;
  const handle = normalizeTransferHandle(channel?.handle);
  return handle ? `handle:${handle.toLocaleLowerCase('en-US')}` : null;
}

function dedupeChannels(channels) {
  const seenIds = new Set();
  const seenHandles = new Set();
  const result = [];
  for (const channel of channels) {
    const handle = normalizeTransferHandle(channel?.handle);
    if (!handle) continue;
    const handleKey = handle.toLocaleLowerCase('en-US');
    const idKey = channel?.channelId ? String(channel.channelId) : null;
    if (seenHandles.has(handleKey) || (idKey && seenIds.has(idKey))) continue;
    seenHandles.add(handleKey);
    if (idKey) seenIds.add(idKey);
    result.push({ ...channel, handle });
  }
  return result;
}

function cleanChannelEntry(channel, notificationSettings, displaySettings, silenceState) {
  const handle = normalizeTransferHandle(channel?.handle);
  if (!handle) return null;
  const channelId = typeof channel?.channelId === 'string' && channel.channelId
    ? channel.channelId
    : null;
  const notification = sanitizeNotificationSettings(notificationSettings?.[handle]);
  const display = sanitizeDisplaySettings(displaySettings?.[handle]);
  const mutedUntil = channelId && Number(silenceState?.channels?.[channelId]);
  const audibleWhenAllMuted = Boolean(channelId && silenceState?.audibleOverrides?.[channelId] === true);
  return {
    handle: `@${handle}`,
    ...(channelId ? { channelId } : {}),
    ...(typeof channel?.name === 'string' && channel.name ? { name: channel.name } : {}),
    ...(Object.keys(notification).length ? { notification } : {}),
    ...(Object.keys(display).length ? { display } : {}),
    ...((Number.isFinite(mutedUntil) || audibleWhenAllMuted) ? {
      mute: {
        ...(Number.isFinite(mutedUntil) ? { until: new Date(mutedUntil).toISOString() } : {}),
        ...(audibleWhenAllMuted ? { audibleWhenAllMuted: true } : {}),
      },
    } : {}),
  };
}

export function createChannelBackup({
  appVersion,
  exportedAt = new Date().toISOString(),
  channels = [],
  settings = {},
  notificationSettings = {},
  displaySettings = {},
  silenceState = {},
} = {}) {
  const cleanChannels = channels
    .map((channel) => cleanChannelEntry(
      channel,
      notificationSettings,
      displaySettings,
      silenceState,
    ))
    .filter(Boolean);
  if (cleanChannels.length > CHANNEL_TRANSFER_MAX_CHANNELS) {
    throw new Error(`TubePulse supports at most ${CHANNEL_TRANSFER_MAX_CHANNELS} channels per backup.`);
  }
  return {
    format: FORMAT,
    schemaVersion: CHANNEL_TRANSFER_SCHEMA_VERSION,
    exportedAt,
    appVersion: typeof appVersion === 'string' ? appVersion : null,
    settings: sanitizeGlobalSettings(settings),
    notificationSilence: { allMuted: silenceState?.globalMuted === true },
    channels: cleanChannels,
  };
}

export function serializeChannelBackup(input) {
  return `${JSON.stringify(createChannelBackup(input), null, 2)}\n`;
}

function parseJsonBackup(parsed) {
  if (!isRecord(parsed) || parsed.format !== FORMAT) {
    throw new Error('This is not a TubePulse backup file.');
  }
  const version = Number(parsed.schemaVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('This TubePulse backup has an invalid schema version.');
  }
  if (version > CHANNEL_TRANSFER_SCHEMA_VERSION) {
    throw new Error('This backup was created by a newer TubePulse version. Update TubePulse before importing it.');
  }
  if (!Array.isArray(parsed.channels)) {
    throw new Error('This TubePulse backup does not contain a channel list.');
  }
  const invalid = [];
  const rawChannels = parsed.channels.map((entry, index) => {
    const source = typeof entry === 'string' ? { handle: entry } : entry;
    const handle = normalizeTransferHandle(source?.handle);
    if (!handle) {
      invalid.push(`Channel ${index + 1} has an invalid handle.`);
      return null;
    }
    const notification = sanitizeNotificationSettings(source.notification);
    const display = sanitizeDisplaySettings(source.display);
    const muteUntil = Date.parse(source?.mute?.until);
    return {
      handle,
      ...(typeof source?.channelId === 'string' && source.channelId ? { channelId: source.channelId } : {}),
      ...(typeof source?.name === 'string' && source.name ? { name: source.name } : {}),
      ...(Object.keys(notification).length ? { notification } : {}),
      ...(Object.keys(display).length ? { display } : {}),
      ...((Number.isFinite(muteUntil) || source?.mute?.audibleWhenAllMuted === true) ? {
        mute: {
          ...(Number.isFinite(muteUntil) ? { until: muteUntil } : {}),
          ...(source?.mute?.audibleWhenAllMuted === true ? { audibleWhenAllMuted: true } : {}),
        },
      } : {}),
    };
  }).filter(Boolean);
  if (invalid.length) throw new Error(invalid[0]);
  const channels = dedupeChannels(rawChannels);
  if (!channels.length) throw new Error('This TubePulse backup does not contain any valid channels.');
  if (channels.length > CHANNEL_TRANSFER_MAX_CHANNELS) {
    throw new Error(`TubePulse supports at most ${CHANNEL_TRANSFER_MAX_CHANNELS} imported channels.`);
  }
  return {
    kind: 'backup',
    schemaVersion: version,
    channels,
    settings: sanitizeGlobalSettings(parsed.settings),
    notificationSilence: { allMuted: parsed?.notificationSilence?.allMuted === true },
    hasSettings: Object.keys(sanitizeGlobalSettings(parsed.settings)).length > 0
      || channels.some((channel) => channel.notification || channel.display || channel.mute),
  };
}

function parsePlainText(text) {
  const tokens = text
    .split(/[,\r\n]+/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const invalid = [];
  const channels = [];
  for (const token of tokens) {
    const handle = normalizeTransferHandle(token);
    if (!handle) invalid.push(token);
    else channels.push({ handle });
  }
  if (invalid.length) throw new Error(`Invalid channel handle: ${invalid[0]}`);
  const deduped = dedupeChannels(channels);
  if (!deduped.length) throw new Error('The selected file does not contain any channel handles.');
  if (deduped.length > CHANNEL_TRANSFER_MAX_CHANNELS) {
    throw new Error(`TubePulse supports at most ${CHANNEL_TRANSFER_MAX_CHANNELS} imported channels.`);
  }
  return {
    kind: 'handles',
    schemaVersion: null,
    channels: deduped,
    settings: {},
    notificationSilence: { allMuted: false },
    hasSettings: false,
  };
}

export function parseChannelTransfer(text, { byteLength } = {}) {
  if (typeof text !== 'string') throw new Error('The selected file could not be read as text.');
  const measuredSize = Number.isFinite(byteLength) ? byteLength : text.length;
  if (measuredSize > CHANNEL_TRANSFER_MAX_BYTES || text.length > CHANNEL_TRANSFER_MAX_BYTES) {
    throw new Error('This import file is too large. The maximum size is 512 KB.');
  }
  const trimmed = text.replace(/^\uFEFF/u, '').trim();
  if (!trimmed) throw new Error('The selected file is empty.');
  if (!trimmed.startsWith('{')) return parsePlainText(trimmed);
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('This TubePulse backup contains invalid JSON.');
  }
  return parseJsonBackup(parsed);
}

export function planChannelTransfer(currentChannels = [], importedChannels = []) {
  const currentById = new Map();
  const currentByHandle = new Map();
  for (const channel of currentChannels) {
    if (channel?.channelId) currentById.set(String(channel.channelId), channel);
    const handle = normalizeTransferHandle(channel?.handle);
    if (handle) currentByHandle.set(handle.toLocaleLowerCase('en-US'), channel);
  }
  const resolved = dedupeChannels(importedChannels);
  const additions = [];
  const existing = [];
  for (const imported of resolved) {
    const match = (imported.channelId && currentById.get(String(imported.channelId)))
      || currentByHandle.get(imported.handle.toLocaleLowerCase('en-US'));
    if (match) existing.push({ imported, current: match });
    else additions.push(imported);
  }
  const importedKeys = new Set(resolved.map(channelKey).filter(Boolean));
  const importedHandles = new Set(
    resolved.map((channel) => channel.handle.toLocaleLowerCase('en-US')),
  );
  const removals = currentChannels.filter((channel) => {
    const key = channelKey(channel);
    const handle = normalizeTransferHandle(channel?.handle)?.toLocaleLowerCase('en-US');
    return !(key && importedKeys.has(key)) && !(handle && importedHandles.has(handle));
  });
  return { resolved, additions, existing, removals };
}

export function buildImportedLocalState({
  mode,
  currentChannels = [],
  resolvedChannels = [],
  currentNotificationSettings = {},
  currentDisplaySettings = {},
  currentSettings = {},
  importedSettings = {},
} = {}) {
  if (mode !== 'merge' && mode !== 'replace') throw new Error('Import mode must be merge or replace.');
  const plan = planChannelTransfer(currentChannels, resolvedChannels);
  const importedByHandle = new Map(
    resolvedChannels.map((channel) => [channel.handle.toLocaleLowerCase('en-US'), channel]),
  );
  const existingById = new Map(currentChannels.filter((channel) => channel.channelId)
    .map((channel) => [String(channel.channelId), channel]));
  const existingByHandle = new Map(currentChannels.map((channel) => [
    normalizeTransferHandle(channel.handle)?.toLocaleLowerCase('en-US'), channel,
  ]));
  const materialize = (imported) => {
    const current = (imported.channelId && existingById.get(String(imported.channelId)))
      || existingByHandle.get(imported.handle.toLocaleLowerCase('en-US'));
    return {
      handle: imported.handle,
      name: imported.name || current?.name || imported.handle,
      channelId: imported.channelId || current?.channelId,
    };
  };
  const channels = mode === 'replace'
    ? resolvedChannels.map(materialize)
    : [...currentChannels, ...plan.additions.map(materialize)];
  const notificationSettings = mode === 'replace' ? {} : { ...currentNotificationSettings };
  const displaySettings = mode === 'replace' ? {} : { ...currentDisplaySettings };
  const targets = mode === 'replace' ? resolvedChannels : plan.additions;
  for (const imported of targets) {
    const handle = imported.handle;
    if (imported.notification && Object.keys(imported.notification).length) {
      notificationSettings[handle] = { ...imported.notification };
    }
    if (imported.display && Object.keys(imported.display).length) {
      displaySettings[handle] = { ...imported.display };
    }
  }
  return {
    channels,
    notificationSettings,
    displaySettings,
    settings: mode === 'replace'
      ? { ...currentSettings, ...sanitizeGlobalSettings(importedSettings) }
      : { ...currentSettings },
    importedByHandle,
    plan,
  };
}

export function buildImportedSilenceState({
  mode,
  currentState = { globalMuted: false, channels: {}, audibleOverrides: {} },
  importedChannels = [],
  importedAllMuted = false,
  newChannelHandles = [],
  now = Date.now(),
} = {}) {
  const base = mode === 'replace'
    ? { globalMuted: importedAllMuted === true, channels: {}, audibleOverrides: {} }
    : {
        globalMuted: currentState?.globalMuted === true,
        channels: { ...(currentState?.channels || {}) },
        audibleOverrides: { ...(currentState?.audibleOverrides || {}) },
      };
  const allowedHandles = mode === 'replace'
    ? null
    : new Set(newChannelHandles.map((handle) => handle.toLocaleLowerCase('en-US')));
  for (const imported of importedChannels) {
    if (allowedHandles && !allowedHandles.has(imported.handle.toLocaleLowerCase('en-US'))) continue;
    if (!imported.channelId) continue;
    if (Number(imported?.mute?.until) > now) base.channels[imported.channelId] = Number(imported.mute.until);
    if (imported?.mute?.audibleWhenAllMuted === true && base.globalMuted) {
      base.audibleOverrides[imported.channelId] = true;
    }
  }
  return base;
}

export async function applyChannelTransferOperations({
  mode,
  currentChannels = [],
  importedChannels = [],
  subscribe,
  unsubscribe,
} = {}) {
  if (mode !== 'merge' && mode !== 'replace') throw new Error('Import mode must be merge or replace.');
  if (typeof subscribe !== 'function' || typeof unsubscribe !== 'function') {
    throw new Error('Channel transfer operations are unavailable.');
  }
  const plan = planChannelTransfer(currentChannels, importedChannels);
  const added = [];
  const addFailures = [];
  for (const channel of plan.additions) {
    let result;
    try {
      result = await subscribe(channel);
    } catch (error) {
      result = { ok: false, error: error?.message || 'Network error' };
    }
    if (!result?.ok) {
      addFailures.push({ channel, error: result?.error || 'Subscription failed' });
      continue;
    }
    const meta = result?.channel?.meta || {};
    added.push({
      ...channel,
      name: meta.name || channel.name || channel.handle,
      avatar: meta.avatarUrl || channel.avatar || null,
    });
  }

  // A Replace import must never remove a current subscription unless every
  // requested addition succeeded. Successful additions remain visible locally
  // so no server-side subscription is orphaned when another addition failed.
  if (addFailures.length) {
    return {
      completed: false,
      destructivePhaseStarted: false,
      added,
      addFailures,
      removed: [],
      removeFailures: [],
      retainedRemovals: plan.removals,
      finalChannels: [...currentChannels, ...added],
      plan,
    };
  }

  if (mode === 'merge') {
    return {
      completed: true,
      destructivePhaseStarted: false,
      added,
      addFailures: [],
      removed: [],
      removeFailures: [],
      retainedRemovals: [],
      finalChannels: [...currentChannels, ...added],
      plan,
    };
  }

  const removed = [];
  const removeFailures = [];
  for (const channel of plan.removals) {
    let result;
    try {
      result = await unsubscribe(channel);
    } catch (error) {
      result = { ok: false, error: error?.message || 'Network error' };
    }
    if (result?.ok) removed.push(channel);
    else removeFailures.push({ channel, error: result?.error || 'Unsubscribe failed' });
  }
  const retainedRemovals = removeFailures.map(({ channel }) => channel);
  return {
    completed: removeFailures.length === 0,
    destructivePhaseStarted: true,
    added,
    addFailures: [],
    removed,
    removeFailures,
    retainedRemovals,
    finalChannels: [
      ...plan.resolved.map((channel) => ({
        handle: channel.handle,
        name: channel.name || channel.handle,
        channelId: channel.channelId,
      })),
      ...retainedRemovals,
    ],
    plan,
  };
}

export const CHANNEL_TRANSFER_FORMAT = FORMAT;
