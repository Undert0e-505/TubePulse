import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alignedNotificationDecision,
  buildAlignedVideoPayload,
  runAlignedVideoNotifications,
  selectAlignedVisibleVideos,
} from './tubepulse-aux/aligned-video-notifications.mjs';
import { runAuxTick } from './tubepulse-aux/index.js';
import {
  buildFcmMessage,
  effectiveNotificationSettings,
  getAlignedNagIntervalMs,
  getNagIntervalMs,
} from './tubepulse-cron/shared.mjs';

const at = (value) => Date.parse(`2026-10-09T${value}:00.000Z`);
const video = (id, time) => ({ videoId: id, title: id, publishedAt: new Date(at(time)).toISOString() });

class MemoryKv {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)])); }
  async get(name, type) {
    const value = this.values.get(name);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }
  async put(name, value) { this.values.set(name, String(value)); }
  async delete(name) { this.values.delete(name); }
}

test('aligned model consolidates new uploads and repeats only at the exact mode raster', () => {
  const modes = [
    ['relentless', 5, 1], ['relentless', 15, 3], ['relentless', 30, 6],
    ['relentless', 60, 12], ['relentless', 120, 24], ['chill', 15, 48],
  ];
  for (const [mode, nagInterval, dueTicks] of modes) {
    let state = { unwatched: [], lastNagAt: null, nagCount: 0 };
    let recent = [];
    const effective = { mode, nagInterval, tapAction: 'video' };
    const activationAt = at('12:00');
    for (const [id, time, expected] of [['A', '12:00', ['A']], ['B', '12:05', ['B', 'A']], ['C', '12:10', ['C', 'B', 'A']], ['D', '12:15', ['D', 'C', 'B']]]) {
      state.unwatched.push(id);
      recent.unshift(video(id, time));
      const videos = selectAlignedVisibleVideos(state, recent);
      assert.deepEqual(videos.map((item) => item.videoId), expected);
      const decision = alignedNotificationDecision({
        scheduledTime: at(time), activationAt, state, videos, effective, newlyDetected: true,
      });
      assert.equal(decision.notify, true);
      assert.equal(decision.kind, 'video');
      state.lastNagAt = decision.raster;
    }
    const oneTick = alignedNotificationDecision({
      scheduledTime: at('12:20'), activationAt, state,
      videos: selectAlignedVisibleVideos(state, recent), effective,
    });
    assert.equal(oneTick.notify, dueTicks === 1);
    const due = alignedNotificationDecision({
      scheduledTime: state.lastNagAt + dueTicks * 5 * 60 * 1000,
      activationAt, state, videos: selectAlignedVisibleVideos(state, recent), effective,
    });
    assert.equal(due.notify, true);
    assert.equal(due.kind, 'nag');
  }
});

test('aligned relentless five-minute cadence never applies the legacy after-twelve backoff', () => {
  const effective = { mode: 'relentless', nagInterval: 5 };
  assert.equal(getAlignedNagIntervalMs(effective), 5 * 60 * 1000);
  assert.equal(getNagIntervalMs(effective, { nagCount: 12 }), 15 * 60 * 1000);
  let state = { unwatched: ['A'], lastNagAt: at('12:00'), nagCount: 12 };
  for (let tick = 1; tick <= 20; tick++) {
    const decision = alignedNotificationDecision({
      scheduledTime: at('12:00') + tick * 5 * 60 * 1000,
      activationAt: at('12:00'), state, videos: [video('A', '12:00')], effective,
    });
    assert.equal(decision.notify, true);
    state = { ...state, lastNagAt: decision.raster, nagCount: state.nagCount + 1 };
  }
});

test('top three selection retains a fourth unseen item and promotes it after deletion', () => {
  const state = { unwatched: ['A', 'B', 'C', 'D'] };
  const recent = [video('D', '12:15'), video('C', '12:10'), video('B', '12:05'), video('A', '12:00')];
  assert.deepEqual(selectAlignedVisibleVideos(state, recent).map((item) => item.videoId), ['D', 'C', 'B']);
  assert.deepEqual(selectAlignedVisibleVideos(state, recent.filter((item) => item.videoId !== 'C')).map((item) => item.videoId), ['D', 'B', 'A']);
  assert.deepEqual(state.unwatched, ['A', 'B', 'C', 'D']);
});

test('single and batch payloads use one stable per-channel surface in both Android render paths', () => {
  const base = { channelId: 'channel-a', channelName: 'Channel A', effective: { tapAction: 'video' } };
  const single = buildAlignedVideoPayload({ ...base, videos: [video('A', '12:00')], kind: 'video' });
  const batch = buildAlignedVideoPayload({ ...base, videos: [video('B', '12:05'), video('A', '12:00')], kind: 'video' });
  assert.equal(single.tag, 'tubepulse-channel-channel-a');
  assert.equal(batch.tag, single.tag);
  assert.deepEqual(JSON.parse(batch.data.contentIds), ['B', 'A']);
  assert.equal(buildFcmMessage('token', single).android.notification.tag, single.tag);
  assert.equal(buildFcmMessage('token', batch, 'local-v1').data.notificationTag, single.tag);
  const other = buildAlignedVideoPayload({ ...base, channelId: 'channel-b', videos: [video('A', '12:00')], kind: 'video' });
  assert.notEqual(other.tag, single.tag);
});

test('settings aliases and per-channel DND values override inherited settings', () => {
  assert.deepEqual(effectiveNotificationSettings(
    { notificationMode: 'chill', nagInterval: 60, dndEnabled: false, dndTimezone: 'UTC' },
    { notificationMode: 'relentless', nagInterval: 5, dndEnabled: true, dndStart: '08:00', dndEnd: '09:00', dndTimezone: 'Europe/London' },
  ), {
    mode: 'relentless', nagInterval: 5, muted: false,
    dndEnabled: true, dndStart: '08:00', dndEnd: '09:00', dndTimezone: 'Europe/London',
    dndBypass: false, tapAction: 'video', includeCommunityPosts: false,
  });
});

test('cutover does not manufacture a backlog but newer unseen content is immediately eligible', () => {
  const activationAt = at('12:00');
  const effective = { mode: 'relentless', nagInterval: 30 };
  const old = alignedNotificationDecision({
    scheduledTime: activationAt, activationAt, state: { unwatched: ['old'], lastNagAt: null },
    videos: [video('old', '11:00')], effective,
  });
  assert.equal(old.notify, false);
  const fresh = alignedNotificationDecision({
    scheduledTime: at('12:05'), activationAt, state: { unwatched: ['new'], lastNagAt: null },
    videos: [video('new', '12:05')], effective, newlyDetected: true,
  });
  assert.equal(fresh.notify, true);
  assert.equal(fresh.kind, 'video');

  const midRasterCutover = alignedNotificationDecision({
    scheduledTime: at('12:05'), activationAt: at('12:03'),
    state: { unwatched: ['recent-before-cutover'], lastNagAt: null },
    videos: [video('recent-before-cutover', '12:02')], effective,
  });
  assert.equal(midRasterCutover.notify, false);
});

test('an unsuccessful durable upload attempt is recalculated as a transient reminder next raster', () => {
  const state = { unwatched: ['A'], lastNagAt: at('11:55'), nagCount: 0 };
  const effective = { mode: 'relentless', nagInterval: 30 };
  const first = alignedNotificationDecision({
    scheduledTime: at('12:00'), activationAt: at('11:00'), state,
    videos: [video('A', '12:00')], effective, newlyDetected: true,
  });
  assert.equal(first.kind, 'video');
  const recovery = alignedNotificationDecision({
    scheduledTime: at('12:05'), activationAt: at('11:00'), state,
    videos: [video('A', '12:00')], effective,
  });
  assert.equal(recovery.notify, true);
  assert.equal(recovery.kind, 'nag');
});

test('aligned owner emits exactly one current top-three intent and success advances the raster clock', async () => {
  const deviceId = 'device';
  const channelId = 'channel';
  const stateKey = `device:${deviceId}:state:${channelId}`;
  const kv = new MemoryKv({
    'nag:active': [`${deviceId}|${channelId}`],
    [`device:${deviceId}:profile`]: { fcmToken: 'token', notificationCapability: 'local-v1' },
    [`device:${deviceId}:settings`]: { mode: 'relentless', nagInterval: 5 },
    [`device:${deviceId}:override:${channelId}`]: { notificationMode: 'relentless', nagInterval: 5 },
    [stateKey]: { unwatched: ['A', 'B', 'C', 'D'], lastNagAt: at('12:10'), nagCount: 12 },
    [`channel:${channelId}:meta`]: { name: 'Channel' },
    [`channel:${channelId}:recent`]: [video('D', '12:15'), video('C', '12:10'), video('B', '12:05'), video('A', '12:00')],
  });
  const intents = [];
  const env = {
    TUBEPULSE_KV: kv,
    TUBEPULSE_NOTIFICATION_MODE: 'shadow',
    TUBEPULSE_NOTIFICATION_DEFERRED: true,
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'project' }),
    TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER: async (intent) => intents.push(intent),
  };
  const result = await runAlignedVideoNotifications(env, { waitUntil() {} }, at('12:15'), {
    activationAt: at('11:00'), newlyDetectedPairs: new Set([`${deviceId}|${channelId}`]),
  });
  assert.equal(result.queued, 1);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, 'video');
  assert.deepEqual(intents[0].contentIds, ['D', 'C', 'B']);
  assert.equal(intents[0].payload.tag, `tubepulse-channel-${channelId}`);
  assert.equal(intents[0].watermarkAt, at('12:15'));
  assert.equal(JSON.parse(kv.values.get(stateKey)).lastNagAt, at('12:10'));
  await intents[0].onResult({ sent: true, deadToken: false });
  const state = JSON.parse(kv.values.get(stateKey));
  assert.equal(state.lastNagAt, at('12:15'));
  assert.equal(state.nagCount, 12, 'new content is not counted as a reminder');
  assert.deepEqual(state.unwatched, ['A', 'B', 'C', 'D']);
});

test('a precise live transition evaluates only its candidate device/channel pairs', async () => {
  const kv = new MemoryKv({
    'nag:active': ['device|live-channel', 'device|other-channel'],
    'device:device:profile': { fcmToken: 'token' },
    'device:device:settings': { mode: 'relentless', nagInterval: 5 },
    'device:device:state:live-channel': { unwatched: ['live'], lastNagAt: at('12:00'), nagCount: 0 },
    'device:device:state:other-channel': { unwatched: ['other'], lastNagAt: at('12:00'), nagCount: 0 },
    'channel:live-channel:meta': { name: 'Live channel' },
    'channel:live-channel:recent': [{ ...video('live', '12:05'), type: 'live' }],
    'channel:other-channel:meta': { name: 'Other channel' },
    'channel:other-channel:recent': [video('other', '12:00')],
  });
  const intents = [];
  const candidate = 'device|live-channel';
  const result = await runAlignedVideoNotifications({
    TUBEPULSE_KV: kv, TUBEPULSE_NOTIFICATION_MODE: 'shadow', TUBEPULSE_NOTIFICATION_DEFERRED: true,
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'project' }),
    TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER: async (intent) => intents.push(intent),
  }, { waitUntil() {} }, at('12:05'), {
    activationAt: at('11:00'),
    newlyDetectedPairs: new Set([candidate]),
    candidatePairs: new Set([candidate]),
  });
  assert.equal(result.checked, 1);
  assert.equal(result.queued, 1);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].channelId, 'live-channel');
});

test('aligned flag prevents the rotating aux owner from emitting a duplicate', async () => {
  const kv = new MemoryKv({
    'nag:active': ['device|channel'],
    'device:device:profile': { fcmToken: 'token' },
    'device:device:settings': { mode: 'relentless', nagInterval: 5 },
    'device:device:state:channel': { unwatched: ['A'], lastNagAt: 0, nagCount: 0 },
    'channel:channel:meta': { name: 'Channel' },
    'channel:channel:recent': [video('A', '12:00')],
  });
  const intents = [];
  await runAuxTick({
    TUBEPULSE_KV: kv,
    TUBEPULSE_ALIGNED_VIDEO_NOTIFICATIONS_ENABLED: true,
    TUBEPULSE_NOTIFICATION_MODE: 'shadow',
    TUBEPULSE_NOTIFICATION_DEFERRED: true,
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'project' }),
    TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER: async (intent) => intents.push(intent),
  }, { waitUntil() {} }, at('12:00'));
  assert.equal(intents.length, 0);
});

test('DND defers without advancing state and becomes eligible on the first aligned tick after release', async () => {
  const deviceId = 'device';
  const channelId = 'channel';
  const stateKey = `device:${deviceId}:state:${channelId}`;
  const kv = new MemoryKv({
    'nag:active': [`${deviceId}|${channelId}`],
    [`device:${deviceId}:profile`]: { fcmToken: 'token' },
    [`device:${deviceId}:settings`]: { mode: 'relentless', nagInterval: 30 },
    [`device:${deviceId}:override:${channelId}`]: {
      dndEnabled: true, dndStart: '12:00', dndEnd: '12:10', dndTimezone: 'UTC',
    },
    [stateKey]: { unwatched: ['A'], lastNagAt: at('11:55'), nagCount: 0 },
    [`channel:${channelId}:meta`]: { name: 'Channel' },
    [`channel:${channelId}:recent`]: [video('A', '12:00')],
  });
  const intents = [];
  const env = {
    TUBEPULSE_KV: kv, TUBEPULSE_NOTIFICATION_MODE: 'shadow', TUBEPULSE_NOTIFICATION_DEFERRED: true,
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'project' }),
    TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER: async (intent) => intents.push(intent),
  };
  await runAlignedVideoNotifications(env, { waitUntil() {} }, at('12:05'), { activationAt: at('11:00') });
  assert.equal(intents.length, 0);
  assert.equal(JSON.parse(kv.values.get(stateKey)).lastNagAt, at('11:55'));
  await runAlignedVideoNotifications(env, { waitUntil() {} }, at('12:10'), { activationAt: at('11:00') });
  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, 'nag');
});

test('a newly detected visible livestream preserves the existing DND bypass', async () => {
  const deviceId = 'device';
  const channelId = 'channel';
  const kv = new MemoryKv({
    'nag:active': [`${deviceId}|${channelId}`],
    [`device:${deviceId}:profile`]: { fcmToken: 'token' },
    [`device:${deviceId}:settings`]: {
      mode: 'relentless', nagInterval: 30,
      dndEnabled: true, dndStart: '12:00', dndEnd: '13:00', dndTimezone: 'UTC',
    },
    [`device:${deviceId}:state:${channelId}`]: { unwatched: ['live'], lastNagAt: at('11:55'), nagCount: 0 },
    [`channel:${channelId}:meta`]: { name: 'Channel' },
    [`channel:${channelId}:recent`]: [{ ...video('live', '12:05'), type: 'live' }],
  });
  const intents = [];
  await runAlignedVideoNotifications({
    TUBEPULSE_KV: kv, TUBEPULSE_NOTIFICATION_MODE: 'shadow', TUBEPULSE_NOTIFICATION_DEFERRED: true,
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'project' }),
    TUBEPULSE_SHADOW_NOTIFICATION_OBSERVER: async (intent) => intents.push(intent),
  }, { waitUntil() {} }, at('12:05'), {
    activationAt: at('11:00'), newlyDetectedPairs: new Set([`${deviceId}|${channelId}`]),
  });
  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, 'video');
});
