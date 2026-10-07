import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCAL_NOTIFICATION_CATEGORY,
  LOCAL_NOTIFICATION_CHANNEL_MUTED_CATEGORY,
  LOCAL_NOTIFICATION_GLOBAL_MUTED_CATEGORY,
  NOTIFICATION_ACTIONS,
  applyNotificationSilenceAction,
  channelSilenceUntil,
  clearAllNotificationSilence,
  formatNotificationSilenceStatus,
  isNotificationSilenced,
  normalizeSilenceState,
  nextNotificationSilenceExpiry,
  notificationSilencePresentation,
  notificationResponseRoute,
  resumeChannelSound,
  resumeGlobalSound,
} from '../src/utils/localNotificationSilence.mjs';

test('channel actions use absolute expiry and expire lazily', () => {
  const now = 1_000_000;
  let state = applyNotificationSilenceAction({}, NOTIFICATION_ACTIONS.MUTE_CHANNEL_1H, 'UC-one', now);
  assert.equal(channelSilenceUntil(state, 'UC-one', now), now + 3_600_000);
  assert.equal(isNotificationSilenced(state, 'UC-one', now + 3_599_999), true);
  assert.equal(isNotificationSilenced(state, 'UC-one', now + 3_600_000), false);
  assert.deepEqual(normalizeSilenceState(state, now + 3_600_000).channels, {});

  state = applyNotificationSilenceAction(state, NOTIFICATION_ACTIONS.MUTE_CHANNEL_8H, 'UC-two', now);
  assert.equal(state.channels['UC-two'], now + 8 * 3_600_000);
});

test('global mute is explicit, indefinite and independently resumable', () => {
  const muted = applyNotificationSilenceAction({}, NOTIFICATION_ACTIONS.MUTE_ALL, null, 10);
  assert.deepEqual(muted, { globalMuted: true, channels: {}, audibleOverrides: {} });
  assert.equal(isNotificationSilenced(muted, 'UC-any', Number.MAX_SAFE_INTEGER), true);
  assert.deepEqual(resumeGlobalSound({ ...muted, audibleOverrides: { a: true } }, 20), {
    globalMuted: false,
    channels: {},
    audibleOverrides: {},
  });
});

test('channel resume under global mute creates one audible exception and clears its timed mute', () => {
  const state = { globalMuted: true, channels: { a: 1000, b: 2000 } };
  assert.deepEqual(resumeChannelSound(state, 'a', 10), {
    globalMuted: true,
    channels: { b: 2000 },
    audibleOverrides: { a: true },
  });
});

test('unmute notification actions clear the appropriate local silence state', () => {
  const state = { globalMuted: true, channels: { a: 5000, b: 6000 } };
  assert.deepEqual(
    applyNotificationSilenceAction(state, NOTIFICATION_ACTIONS.UNMUTE_CHANNEL, 'a', 1000),
    { globalMuted: true, channels: { b: 6000 }, audibleOverrides: { a: true } },
  );
  assert.deepEqual(
    applyNotificationSilenceAction(state, NOTIFICATION_ACTIONS.UNMUTE_ALL, 'a', 1000),
    { globalMuted: false, channels: {}, audibleOverrides: {} },
  );
});

test('clear all removes global and channel silence while nearest expiry is efficient', () => {
  const state = { globalMuted: true, channels: { later: 9000, sooner: 5000 } };
  assert.equal(nextNotificationSilenceExpiry(state, 1000), 5000);
  assert.equal(nextNotificationSilenceExpiry(state, 6000), 9000);
  assert.deepEqual(clearAllNotificationSilence(state, 1000), {
    globalMuted: false,
    channels: {},
    audibleOverrides: {},
  });
});

test('old stored state migrates with no audible exceptions and JSON restart preserves valid ones', () => {
  const now = 1000;
  assert.deepEqual(normalizeSilenceState({ globalMuted: true, channels: { a: 5000 } }, now), {
    globalMuted: true,
    channels: { a: 5000 },
    audibleOverrides: {},
  });
  const persisted = JSON.parse(JSON.stringify({
    globalMuted: true,
    channels: { b: 6000 },
    audibleOverrides: { a: true, invalid: false },
  }));
  assert.deepEqual(normalizeSilenceState(persisted, now), {
    globalMuted: true,
    channels: { b: 6000 },
    audibleOverrides: { a: true },
  });
  assert.deepEqual(normalizeSilenceState({ globalMuted: false, audibleOverrides: { a: true } }, now), {
    globalMuted: false,
    channels: {},
    audibleOverrides: {},
  });
});

test('audible exception affects only its channel and any mute action revokes it', () => {
  const now = 1000;
  const exempt = { globalMuted: true, channels: {}, audibleOverrides: { a: true } };
  assert.equal(isNotificationSilenced(exempt, 'a', now), false);
  assert.equal(isNotificationSilenced(exempt, 'b', now), true);
  const remuted = applyNotificationSilenceAction(
    exempt,
    NOTIFICATION_ACTIONS.MUTE_CHANNEL_1H,
    'a',
    now,
  );
  assert.equal(remuted.audibleOverrides.a, undefined);
  assert.equal(isNotificationSilenced(remuted, 'a', now), true);
  assert.deepEqual(
    applyNotificationSilenceAction(exempt, NOTIFICATION_ACTIONS.MUTE_ALL, null, now),
    { globalMuted: true, channels: {}, audibleOverrides: {} },
  );
});

test('silence status is compact, locale-aware and suppresses expired timestamps', () => {
  const now = new Date(2026, 9, 7, 13, 0, 0).getTime();
  const until = new Date(2026, 9, 7, 15, 5, 0).getTime();
  assert.equal(formatNotificationSilenceStatus(until, now, 'en-GB'), 'Silent until 15:05');
  assert.equal(formatNotificationSilenceStatus(null, now, 'en-GB'), 'Silent');
  assert.equal(formatNotificationSilenceStatus(now, now, 'en-GB'), null);
});

test('notification category selection follows global precedence and timed expiry', () => {
  const now = 1000;
  assert.deepEqual(notificationSilencePresentation({}, 'a', now), {
    silent: false,
    categoryIdentifier: LOCAL_NOTIFICATION_CATEGORY,
  });
  assert.deepEqual(notificationSilencePresentation({ channels: { a: 5000 } }, 'a', now), {
    silent: true,
    categoryIdentifier: LOCAL_NOTIFICATION_CHANNEL_MUTED_CATEGORY,
  });
  assert.deepEqual(notificationSilencePresentation({ channels: { a: 1000 } }, 'a', now), {
    silent: false,
    categoryIdentifier: LOCAL_NOTIFICATION_CATEGORY,
  });
  assert.deepEqual(
    notificationSilencePresentation({ globalMuted: true, channels: { a: 5000 } }, 'a', now),
    { silent: true, categoryIdentifier: LOCAL_NOTIFICATION_GLOBAL_MUTED_CATEGORY },
  );
  assert.deepEqual(
    notificationSilencePresentation({ globalMuted: true, audibleOverrides: { a: true } }, 'a', now),
    { silent: false, categoryIdentifier: LOCAL_NOTIFICATION_CATEGORY },
  );
  assert.deepEqual(
    notificationSilencePresentation({
      globalMuted: true,
      audibleOverrides: { a: true },
      channels: { a: 5000 },
    }, 'a', now),
    { silent: true, categoryIdentifier: LOCAL_NOTIFICATION_GLOBAL_MUTED_CATEGORY },
  );
});

test('notification actions never route through the default tap path', () => {
  assert.equal(notificationResponseRoute(NOTIFICATION_ACTIONS.MUTE_ALL, 'expo_default'), 'silence');
  assert.equal(notificationResponseRoute(NOTIFICATION_ACTIONS.MUTE_CHANNEL_1H, 'expo_default'), 'silence');
  assert.equal(notificationResponseRoute(NOTIFICATION_ACTIONS.UNMUTE_CHANNEL, 'expo_default'), 'silence');
  assert.equal(notificationResponseRoute(NOTIFICATION_ACTIONS.UNMUTE_ALL, 'expo_default'), 'silence');
  assert.equal(notificationResponseRoute('expo_default', 'expo_default'), 'default');
  assert.equal(notificationResponseRoute('unknown', 'expo_default'), 'ignore');
});
