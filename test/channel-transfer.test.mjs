import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_TRANSFER_MAX_BYTES,
  CHANNEL_TRANSFER_MAX_CHANNELS,
  applyChannelTransferOperations,
  buildImportedLocalState,
  buildImportedSilenceState,
  createChannelBackup,
  parseChannelTransfer,
  planChannelTransfer,
  serializeChannelBackup,
} from '../src/utils/channelTransfer.mjs';

const currentChannels = [
  { handle: 'Alpha', name: 'Alpha channel', channelId: 'UC_ALPHA' },
  { handle: 'Bravo', name: 'Bravo channel', channelId: 'UC_BRAVO' },
];

test('backup round trip preserves manual order, supported settings and readable handles', () => {
  const text = serializeChannelBackup({
    appVersion: '4.4.0',
    exportedAt: '2026-11-05T12:00:00.000Z',
    channels: currentChannels,
    settings: {
      tapAction: 'channel',
      autoOrderChannels: true,
      notificationMode: 'relentless',
      nagInterval: 30,
      includeCommunityPosts: true,
      dndEnabled: true,
      dndStart: '23:00',
      dndEnd: '06:30',
      perChannelNotifications: true,
      prewarnMinutes: 120,
      latestVideosPerChannel: 3,
      dndTimezone: 'Europe/London',
    },
    notificationSettings: {
      Alpha: { notificationMode: 'chill', includeCommunityPosts: null, prewarnMinutes: null },
    },
    displaySettings: { Alpha: { latestVideosPerChannel: 2 } },
    silenceState: {
      globalMuted: true,
      channels: { UC_ALPHA: Date.parse('2026-11-05T13:00:00.000Z') },
      audibleOverrides: { UC_BRAVO: true },
    },
  });
  assert.match(text, /"handle": "@Alpha"/);
  const parsed = parseChannelTransfer(text);
  assert.equal(parsed.kind, 'backup');
  assert.deepEqual(parsed.channels.map((channel) => channel.handle), ['Alpha', 'Bravo']);
  assert.equal(parsed.settings.autoOrderChannels, true);
  assert.equal(parsed.settings.dndTimezone, undefined);
  assert.deepEqual(parsed.channels[0].notification, {
    notificationMode: 'chill',
    includeCommunityPosts: null,
    prewarnMinutes: null,
  });
  assert.deepEqual(parsed.channels[0].display, { latestVideosPerChannel: 2 });
  assert.equal(parsed.channels[0].mute.until, Date.parse('2026-11-05T13:00:00.000Z'));
  assert.equal(parsed.channels[1].mute.audibleWhenAllMuted, true);
});

test('backup excludes identity, credentials, history, cache and unknown settings', () => {
  const backup = createChannelBackup({
    channels: [{ ...currentChannels[0], fcmToken: 'channel-secret', seenIds: ['seen'] }],
    settings: {
      tapAction: 'video',
      deviceId: 'device-secret',
      fcmToken: 'token-secret',
      apiEndpoint: 'https://private.invalid',
      notificationHistory: ['history-secret'],
      channelCache: { Alpha: { title: 'cache-secret' } },
    },
  });
  const serialized = JSON.stringify(backup);
  for (const forbidden of ['device-secret', 'token-secret', 'channel-secret', 'history-secret', 'cache-secret', 'private.invalid', 'seenIds']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('parser rejects malformed, unsupported, empty and oversized imports', () => {
  assert.throws(() => parseChannelTransfer('{ nope'), /invalid JSON/);
  assert.throws(() => parseChannelTransfer(JSON.stringify({
    format: 'tubepulse-backup', schemaVersion: 2, channels: [{ handle: '@Alpha' }],
  })), /newer TubePulse version/);
  assert.throws(() => parseChannelTransfer('  '), /empty/);
  assert.throws(() => parseChannelTransfer('@Alpha', { byteLength: CHANNEL_TRANSFER_MAX_BYTES + 1 }), /too large/);
  assert.throws(() => parseChannelTransfer(JSON.stringify({
    format: 'wrong', schemaVersion: 1, channels: [],
  })), /not a TubePulse backup/);
  const tooManyChannels = Array.from(
    { length: CHANNEL_TRANSFER_MAX_CHANNELS + 1 },
    (_, index) => `@Channel${index}`,
  ).join('\n');
  assert.throws(() => parseChannelTransfer(tooManyChannels), /at most 100/);
});

test('serialization is deterministic for fixed input and planning a cancelled import is a no-op', () => {
  const input = {
    appVersion: '4.4.0',
    exportedAt: '2026-11-05T12:00:00.000Z',
    channels: currentChannels,
    settings: { tapAction: 'video' },
  };
  assert.equal(serializeChannelBackup(input), serializeChannelBackup(input));
  const before = structuredClone(currentChannels);
  const plan = planChannelTransfer(currentChannels, [{ handle: 'Charlie', channelId: 'UC_CHARLIE' }]);
  assert.equal(plan.additions.length, 1);
  assert.deepEqual(currentChannels, before);
});

test('plain-text handle list tolerates comments, commas and duplicates', () => {
  const parsed = parseChannelTransfer('# TubePulse list\n@Alpha, bravo\n@ALPHA\n\n@Charlie');
  assert.equal(parsed.kind, 'handles');
  assert.equal(parsed.hasSettings, false);
  assert.deepEqual(parsed.channels.map((channel) => channel.handle), ['Alpha', 'bravo', 'Charlie']);
});

test('invalid setting values and unknown fields are ignored safely', () => {
  const parsed = parseChannelTransfer(JSON.stringify({
    format: 'tubepulse-backup',
    schemaVersion: 1,
    unknown: 'ignored',
    settings: { tapAction: 'malicious', nagInterval: 7, dndStart: '99:99', latestVideosPerChannel: 10 },
    channels: [{
      handle: '@Alpha',
      notification: { notificationMode: 'other', dndEnabled: 'yes', prewarnMinutes: 17 },
      display: { latestVideosPerChannel: 99 },
      unknown: 'ignored',
    }],
  }));
  assert.deepEqual(parsed.settings, {});
  assert.equal(parsed.channels[0].notification, undefined);
  assert.equal(parsed.channels[0].display, undefined);
});

test('transfer plan distinguishes additions, existing channels and replace removals', () => {
  const plan = planChannelTransfer(currentChannels, [
    { handle: 'alpha-renamed', channelId: 'UC_ALPHA' },
    { handle: 'Charlie', channelId: 'UC_CHARLIE' },
  ]);
  assert.deepEqual(plan.additions.map((channel) => channel.channelId), ['UC_CHARLIE']);
  assert.equal(plan.existing.length, 1);
  assert.deepEqual(plan.removals.map((channel) => channel.channelId), ['UC_BRAVO']);
});

test('Merge preserves current order, settings and globals and applies settings only to additions', () => {
  const result = buildImportedLocalState({
    mode: 'merge',
    currentChannels,
    resolvedChannels: [
      { handle: 'Alpha', channelId: 'UC_ALPHA', notification: { notificationMode: 'relentless' } },
      { handle: 'Charlie', channelId: 'UC_CHARLIE', notification: { notificationMode: 'chill' }, display: { latestVideosPerChannel: 3 } },
    ],
    currentNotificationSettings: { Alpha: { notificationMode: 'chill' } },
    currentDisplaySettings: { Alpha: { latestVideosPerChannel: 2 } },
    currentSettings: { tapAction: 'video', autoOrderChannels: true },
    importedSettings: { tapAction: 'channel', autoOrderChannels: false },
  });
  assert.deepEqual(result.channels.map((channel) => channel.handle), ['Alpha', 'Bravo', 'Charlie']);
  assert.equal(result.notificationSettings.Alpha.notificationMode, 'chill');
  assert.equal(result.notificationSettings.Charlie.notificationMode, 'chill');
  assert.equal(result.displaySettings.Charlie.latestVideosPerChannel, 3);
  assert.deepEqual(result.settings, { tapAction: 'video', autoOrderChannels: true });
});

test('Replace makes imported order/settings authoritative while preserving non-transferable local defaults', () => {
  const result = buildImportedLocalState({
    mode: 'replace',
    currentChannels,
    resolvedChannels: [
      { handle: 'Charlie', channelId: 'UC_CHARLIE', notification: { notificationMode: 'chill' } },
      { handle: 'Alpha', channelId: 'UC_ALPHA' },
    ],
    currentNotificationSettings: { Alpha: { notificationMode: 'relentless' }, Bravo: { notificationMode: 'chill' } },
    currentDisplaySettings: { Bravo: { latestVideosPerChannel: 3 } },
    currentSettings: { tapAction: 'video', dndTimezone: 'Europe/London' },
    importedSettings: { tapAction: 'channel' },
  });
  assert.deepEqual(result.channels.map((channel) => channel.handle), ['Charlie', 'Alpha']);
  assert.deepEqual(result.notificationSettings, { Charlie: { notificationMode: 'chill' } });
  assert.deepEqual(result.displaySettings, {});
  assert.deepEqual(result.settings, { tapAction: 'channel', dndTimezone: 'Europe/London' });
});

test('silence import preserves current state for Merge and becomes authoritative for Replace', () => {
  const currentState = { globalMuted: true, channels: { UC_ALPHA: 5000 }, audibleOverrides: { UC_BRAVO: true } };
  const imported = [{ handle: 'Charlie', channelId: 'UC_CHARLIE', mute: { until: 6000 } }];
  assert.deepEqual(buildImportedSilenceState({
    mode: 'merge', currentState, importedChannels: imported, newChannelHandles: ['Charlie'], now: 1000,
  }), {
    globalMuted: true,
    channels: { UC_ALPHA: 5000, UC_CHARLIE: 6000 },
    audibleOverrides: { UC_BRAVO: true },
  });
  assert.deepEqual(buildImportedSilenceState({
    mode: 'replace', currentState, importedChannels: imported, importedAllMuted: false, now: 1000,
  }), {
    globalMuted: false,
    channels: { UC_CHARLIE: 6000 },
    audibleOverrides: {},
  });
});

test('Replace never starts removals when any required addition fails', async () => {
  const unsubscribed = [];
  const result = await applyChannelTransferOperations({
    mode: 'replace',
    currentChannels,
    importedChannels: [{ handle: 'Charlie', channelId: 'UC_CHARLIE' }],
    subscribe: async () => ({ ok: false, error: 'offline' }),
    unsubscribe: async (channel) => { unsubscribed.push(channel); return { ok: true }; },
  });
  assert.equal(result.completed, false);
  assert.equal(result.destructivePhaseStarted, false);
  assert.equal(result.addFailures.length, 1);
  assert.equal(unsubscribed.length, 0);
  assert.deepEqual(result.finalChannels, currentChannels);
});

test('Replace retains failed removals locally and reports a partial result', async () => {
  const result = await applyChannelTransferOperations({
    mode: 'replace',
    currentChannels,
    importedChannels: [{ handle: 'Charlie', channelId: 'UC_CHARLIE' }],
    subscribe: async () => ({ ok: true, channel: { meta: { name: 'Charlie channel' } } }),
    unsubscribe: async (channel) => channel.channelId === 'UC_ALPHA'
      ? { ok: false, error: 'offline' }
      : { ok: true },
  });
  assert.equal(result.completed, false);
  assert.equal(result.destructivePhaseStarted, true);
  assert.deepEqual(result.finalChannels.map((channel) => channel.channelId), ['UC_CHARLIE', 'UC_ALPHA']);
  assert.deepEqual(result.removed.map((channel) => channel.channelId), ['UC_BRAVO']);
  assert.deepEqual(result.retainedRemovals.map((channel) => channel.channelId), ['UC_ALPHA']);
});
