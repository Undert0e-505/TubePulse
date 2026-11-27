const SCHEMA_VERSION = 1;
const MAX_CHANNELS = 500;
const MAX_VALUE_BYTES = 256 * 1024;

export function nagLedgerKey(deviceId) {
  return `device:${deviceId}:nag-ledger`;
}

function deviceChannelsKey(deviceId) {
  return `device:${deviceId}:channels`;
}

function deviceStateKey(deviceId, channelId) {
  return `device:${deviceId}:state:${channelId}`;
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function cursor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const lastNagAt = Number(value.lastNagAt);
  const nagCount = Number(value.nagCount || 0);
  if (!Number.isFinite(lastNagAt) || lastNagAt <= 0) return null;
  if (!Number.isFinite(nagCount) || nagCount < 0) return null;
  return { lastNagAt, nagCount: Math.floor(nagCount) };
}

function orderedLedger(channels) {
  const ordered = {};
  for (const channelId of Object.keys(channels).sort()) ordered[channelId] = channels[channelId];
  return { schemaVersion: SCHEMA_VERSION, channels: ordered };
}

function serializeLedger(channels) {
  if (Object.keys(channels).length > MAX_CHANNELS) throw new Error('Packed nag ledger has too many channels');
  const value = JSON.stringify(orderedLedger(channels));
  if (byteLength(value) > MAX_VALUE_BYTES) throw new Error('Packed nag ledger exceeds the value-size guard');
  return value;
}

export async function readNagLedger(kv, deviceId) {
  const raw = await kv.get(nagLedgerKey(deviceId), 'text');
  if (raw === null || raw === undefined) return { exists: false, channels: {} };
  if (typeof raw !== 'string' || byteLength(raw) > MAX_VALUE_BYTES) {
    throw new Error('Packed nag ledger is oversized or unreadable');
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Packed nag ledger is invalid JSON'); }
  if (parsed?.schemaVersion !== SCHEMA_VERSION
    || !parsed.channels || typeof parsed.channels !== 'object' || Array.isArray(parsed.channels)) {
    throw new Error('Packed nag ledger schema is invalid');
  }
  const entries = Object.entries(parsed.channels);
  if (entries.length > MAX_CHANNELS) throw new Error('Packed nag ledger has too many channels');
  const channels = {};
  for (const [channelId, value] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!channelId || channelId === '__proto__' || channelId === 'constructor' || channelId === 'prototype') {
      throw new Error('Packed nag ledger contains an invalid channel');
    }
    const normalized = cursor(value);
    if (!normalized) throw new Error('Packed nag ledger contains an invalid cursor');
    channels[channelId] = normalized;
  }
  return { exists: true, channels, raw };
}

export function nagCursorForChannel(ledger, channelId, legacyState) {
  if (ledger?.exists) return ledger.channels[channelId] || { lastNagAt: null, nagCount: 0 };
  return cursor(legacyState) || { lastNagAt: null, nagCount: 0 };
}

async function currentUnseenStates(kv, deviceId) {
  const channels = await kv.get(deviceChannelsKey(deviceId), 'json');
  if (!Array.isArray(channels)) return new Map();
  const unique = [...new Set(channels.map(String).filter(Boolean))].sort().slice(0, MAX_CHANNELS + 1);
  if (unique.length > MAX_CHANNELS) throw new Error('Installation channel count exceeds nag-ledger guard');
  const states = await Promise.all(unique.map(async (channelId) => [
    channelId,
    await kv.get(deviceStateKey(deviceId, channelId), 'json'),
  ]));
  return new Map(states.filter(([, state]) => Array.isArray(state?.unwatched) && state.unwatched.length > 0));
}

export async function applyNagLedgerAdvances(kv, deviceId, advances = []) {
  const existing = await readNagLedger(kv, deviceId);
  const unseen = await currentUnseenStates(kv, deviceId);
  const channels = {};

  for (const [channelId, state] of unseen) {
    const value = existing.exists ? existing.channels[channelId] : cursor(state);
    if (value) channels[channelId] = value;
  }
  for (const advance of advances) {
    const channelId = String(advance?.channelId || '');
    if (!unseen.has(channelId)) continue;
    const lastNagAt = Number(advance?.lastNagAt);
    if (!Number.isFinite(lastNagAt) || lastNagAt <= 0) continue;
    const previous = channels[channelId] || { lastNagAt: null, nagCount: 0 };
    const isNewRaster = !Number.isFinite(Number(previous.lastNagAt)) || lastNagAt > Number(previous.lastNagAt);
    channels[channelId] = {
      lastNagAt: Math.max(Number(previous.lastNagAt) || 0, lastNagAt),
      nagCount: Math.max(0, Number(previous.nagCount) || 0)
        + (isNewRaster && advance.incrementNagCount ? 1 : 0),
    };
  }

  const next = serializeLedger(channels);
  if (existing.exists && existing.raw === next) return { changed: false, channels: Object.keys(channels).length };
  if (!existing.exists && Object.keys(channels).length === 0) return { changed: false, channels: 0 };
  await kv.put(nagLedgerKey(deviceId), next);
  return { changed: true, channels: Object.keys(channels).length };
}

export async function pruneNagLedgerChannels(kv, deviceId, channelIds) {
  const existing = await readNagLedger(kv, deviceId);
  if (!existing.exists) return false;
  const removed = new Set((channelIds || []).map(String));
  const channels = Object.fromEntries(Object.entries(existing.channels)
    .filter(([channelId]) => !removed.has(channelId)));
  const next = serializeLedger(channels);
  if (next === existing.raw) return false;
  await kv.put(nagLedgerKey(deviceId), next);
  return true;
}

export async function mergeNagLedgers(kv, oldDeviceId, newDeviceId) {
  const [oldLedger, newLedger] = await Promise.all([
    readNagLedger(kv, oldDeviceId),
    readNagLedger(kv, newDeviceId),
  ]);
  if (!oldLedger.exists) return false;
  const channels = { ...oldLedger.channels, ...newLedger.channels };
  const next = serializeLedger(channels);
  if (!newLedger.exists || next !== newLedger.raw) await kv.put(nagLedgerKey(newDeviceId), next);
  return true;
}

export async function advanceNagLedgerCursor(env, deviceId, channelId, {
  lastNagAt,
  incrementNagCount = false,
} = {}) {
  if (typeof env?.TUBEPULSE_NAG_LEDGER_ADVANCE === 'function') {
    return await env.TUBEPULSE_NAG_LEDGER_ADVANCE(deviceId, channelId, { lastNagAt, incrementNagCount });
  }
  const operation = async () => await applyNagLedgerAdvances(env.TUBEPULSE_KV, deviceId, [{
    channelId, lastNagAt, incrementNagCount,
  }]);
  if (typeof env?.TUBEPULSE_KV_MUTATION_LOCK === 'function') {
    return await env.TUBEPULSE_KV_MUTATION_LOCK(nagLedgerKey(deviceId), operation);
  }
  return await operation();
}

export function modelPackedNagLedger({ logicalMutations, installations, cyclesPerDay = 288, rowsPerWrite = 3 }) {
  const before = Math.max(0, Math.floor(Number(logicalMutations) || 0));
  const ceiling = Math.min(before, Math.max(0, Math.floor(Number(installations) || 0))
    * Math.max(0, Math.floor(Number(cyclesPerDay) || 0)));
  return {
    logicalBefore: before,
    logicalAfterCeiling: ceiling,
    logicalSavedFloor: before - ceiling,
    d1RowsBefore: before * rowsPerWrite,
    d1RowsAfterCeiling: ceiling * rowsPerWrite,
    d1RowsSavedFloor: (before - ceiling) * rowsPerWrite,
  };
}

export const nagLedgerLimits = { schemaVersion: SCHEMA_VERSION, maxChannels: MAX_CHANNELS, maxValueBytes: MAX_VALUE_BYTES };
