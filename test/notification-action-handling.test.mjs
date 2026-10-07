import assert from 'node:assert/strict';
import test from 'node:test';
import { NOTIFICATION_ACTIONS } from '../src/utils/localNotificationSilence.mjs';
import {
  handleLocalNotificationActionResponse,
  notificationActionDetails,
} from '../src/utils/notificationActionHandling.mjs';

function response(actionIdentifier = NOTIFICATION_ACTIONS.MUTE_CHANNEL_1H) {
  return {
    actionIdentifier,
    notification: {
      request: {
        identifier: 'local-video-abc',
        content: { data: { channelId: 'UC-one', videoId: 'abc' } },
      },
    },
  };
}

test('action response exposes the exact notification and channel identifiers', () => {
  assert.deepEqual(notificationActionDetails(response()), {
    actionIdentifier: NOTIFICATION_ACTIONS.MUTE_CHANNEL_1H,
    channelId: 'UC-one',
    notificationIdentifier: 'local-video-abc',
  });
  assert.equal(notificationActionDetails(response('expo_default')), null);
});

test('foreground/background/headless action path persists before exact dismissal', async () => {
  for (const [mode, action] of [
    ['foreground', NOTIFICATION_ACTIONS.MUTE_CHANNEL_1H],
    ['background', NOTIFICATION_ACTIONS.UNMUTE_CHANNEL],
    ['headless', NOTIFICATION_ACTIONS.UNMUTE_ALL],
  ]) {
    const events = [];
    const result = await handleLocalNotificationActionResponse(response(action), {
      persistAction: async (action, channelId) => {
        events.push(`${mode}:persist:${action}:${channelId}`);
        return { globalMuted: false, channels: { 'UC-one': 123 } };
      },
      dismissNotification: async (identifier) => events.push(`${mode}:dismiss:${identifier}`),
    });
    assert.equal(result.handled, true);
    assert.deepEqual(events, [
      `${mode}:persist:${action}:UC-one`,
      `${mode}:dismiss:local-video-abc`,
    ]);
  }
});

test('persistence failure remains visible and never dismisses the notification', async () => {
  let dismissed = false;
  await assert.rejects(() => handleLocalNotificationActionResponse(response(NOTIFICATION_ACTIONS.UNMUTE_ALL), {
    persistAction: async () => { throw new Error('storage unavailable'); },
    dismissNotification: async () => { dismissed = true; },
  }), /storage unavailable/);
  assert.equal(dismissed, false);
});

test('non-action response is ignored without persistence, dismissal, navigation or seen work', async () => {
  let called = false;
  const result = await handleLocalNotificationActionResponse(response('expo_default'), {
    persistAction: async () => { called = true; },
    dismissNotification: async () => { called = true; },
  });
  assert.deepEqual(result, { handled: false });
  assert.equal(called, false);
});
