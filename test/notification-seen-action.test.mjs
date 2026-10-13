import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dismissExactSeenNotification,
  handleNotificationSeenResponse,
  notificationIdsAreCovered,
  notificationSeenDetails,
} from '../src/utils/notificationSeenAction.mjs';
import {
  notificationPresentationIdentifier,
  notificationTag,
} from '../src/utils/notificationIdentity.mjs';

function response(data, identifier = 'notification-1') {
  return { notification: { request: { identifier, content: { data } } } };
}

function rawHeadlessResponse(data, identifier = 'notification-1') {
  return {
    actionIdentifier: 'TUBEPULSE_MARK_SEEN',
    notification: {
      request: { identifier, content: { dataString: JSON.stringify(data) } },
    },
  };
}

test('single and bundled actions retain the exact represented content snapshot', () => {
  assert.deepEqual(notificationSeenDetails(response({ channelId: 'UC1', videoId: 'v1' })), {
    channelId: 'UC1', contentIds: ['v1'], notificationIdentifier: 'notification-1',
  });
  assert.deepEqual(notificationSeenDetails(response({
    channelId: 'UC1', contentIds: '["v2","post:p1","v2"]', type: 'batch',
  })), {
    channelId: 'UC1', contentIds: ['v2', 'post:p1'], notificationIdentifier: 'notification-1',
  });
  assert.equal(notificationSeenDetails(response({ channelId: 'UC1', videoId: 'future', type: 'prewarn' })), null);
});

test('notification dismissal never removes a newer mixed snapshot', () => {
  const seen = new Set(['old-1', 'old-2']);
  assert.equal(notificationIdsAreCovered({ contentIds: '["old-1","old-2"]' }, seen), true);
  assert.equal(notificationIdsAreCovered({ contentIds: '["old-1","newer"]' }, seen), false);
});

test('durable exact-ID enqueue precedes local UI, dismissal and retry', async () => {
  const events = [];
  const result = await handleNotificationSeenResponse(response({
    channelId: 'UC1', contentIds: '["v1","v2"]', type: 'batch',
  }), {
    enqueue: async ({ contentIds }) => events.push(`enqueue:${contentIds.join(',')}`),
    dismissExact: async ({ notificationIdentifier }) => events.push(`exact:${notificationIdentifier}`),
    applyLocal: async () => events.push('local'),
    updateSurface: async () => events.push('widget'),
    dismissCovered: async () => events.push('dismiss'),
    flush: async () => { events.push('flush'); return { remaining: 1 }; },
  });
  assert.equal(result.handled, true);
  assert.deepEqual(events, [
    'enqueue:v1,v2', 'exact:notification-1', 'local', 'dismiss', 'widget', 'flush',
  ]);
});

test('exact runtime notification is dismissed after durable enqueue and before local surfaces', async () => {
  const events = [];
  const notifications = {
    getPresentedNotificationsAsync: async () => [{
      request: {
        identifier: 'notification-1',
        content: { data: { channelId: 'UC1', videoId: 'v1' } },
      },
    }],
    dismissNotificationAsync: async (identifier) => events.push(`expo-dismiss:${identifier}`),
  };
  await handleNotificationSeenResponse(response({ channelId: 'UC1', videoId: 'v1' }), {
    enqueue: async () => events.push('enqueue'),
    dismissExact: (details) => dismissExactSeenNotification(notifications, details),
    applyLocal: async () => events.push('local'),
    dismissCovered: async () => events.push('sweep'),
    updateSurface: async () => events.push('widget'),
    flush: async () => events.push('flush'),
  });
  assert.deepEqual(events, [
    'enqueue', 'expo-dismiss:notification-1', 'local', 'sweep', 'widget', 'flush',
  ]);
});

test('foreground, background and headless event shapes preserve the runtime request ID', async () => {
  for (const mode of ['foreground', 'background', 'headless']) {
    const runtimeId = `local-tubepulse-channel-UC1-event-${mode}`;
    const events = [];
    const notifications = {
      dismissNotificationAsync: async (identifier) => events.push(`dismiss:${identifier}`),
      getPresentedNotificationsAsync: async () => { throw new Error('snapshot ID must dismiss directly'); },
    };
    const event = mode === 'headless'
      ? rawHeadlessResponse({ channelId: 'UC1', videoId: 'v1' }, runtimeId)
      : response({ channelId: 'UC1', videoId: 'v1' }, runtimeId);
    await handleNotificationSeenResponse(event, {
      enqueue: async () => events.push('enqueue'),
      dismissExact: (details) => dismissExactSeenNotification(notifications, details),
      applyLocal: async () => events.push('local'),
      dismissCovered: async () => events.push('sweep'),
      updateSurface: async () => events.push('widget'),
      flush: async () => events.push('flush'),
    });
    assert.deepEqual(events, [
      'enqueue', `dismiss:${runtimeId}`, 'local', 'sweep', 'widget', 'flush',
    ]);
  }
});

test('newer same-channel replacement is not dismissed by an older action snapshot', async () => {
  const dismissed = [];
  const notifications = {
    getPresentedNotificationsAsync: async () => [{
      request: {
        identifier: 'notification-1',
        content: { data: { channelId: 'UC1', contentIds: '["v1","newer"]', type: 'batch' } },
      },
    }],
    dismissNotificationAsync: async (identifier) => dismissed.push(identifier),
  };
  const result = await dismissExactSeenNotification(notifications, {
    notificationIdentifier: 'notification-1', contentIds: ['v1'],
  });
  assert.deepEqual(result, { dismissed: false, reason: 'newer-replacement' });
  assert.deepEqual(dismissed, []);
});

test('presentation IDs change for newer same-channel messages while replacement tag stays stable', async () => {
  const oldData = {
    channelId: 'UC1', videoId: 'v1', contentIds: '["v1"]', notificationTag: 'tubepulse-channel-UC1',
  };
  const newerData = {
    channelId: 'UC1', videoId: 'v2', contentIds: '["v2","v1"]', notificationTag: 'tubepulse-channel-UC1',
  };
  const oldId = notificationPresentationIdentifier(oldData, 'fcm-old');
  const newerId = notificationPresentationIdentifier(newerData, 'fcm-new');
  assert.equal(notificationTag(oldData), notificationTag(newerData));
  assert.notEqual(oldId, newerId);

  const displayed = new Set([newerId]);
  const notifications = {
    dismissNotificationAsync: async (identifier) => displayed.delete(identifier),
    getPresentedNotificationsAsync: async () => { throw new Error('snapshot IDs dismiss directly'); },
  };
  const result = await dismissExactSeenNotification(notifications, {
    notificationIdentifier: oldId, contentIds: ['v1'],
  });
  assert.equal(result.dismissed, true);
  assert.deepEqual([...displayed], [newerId]);
});

test('single, bundle, post and muted categories use the runtime event identifier', async () => {
  for (const data of [
    { channelId: 'UC1', videoId: 'v1' },
    { channelId: 'UC1', contentIds: '["v1","v2"]', type: 'batch' },
    { channelId: 'UC1', activityId: 'p1', type: 'post' },
    { channelId: 'UC1', videoId: 'v1', localSilent: '1' },
    { channelId: 'UC1', videoId: 'v1', localSilent: '1', globallyMuted: '1' },
  ]) {
    const runtimeId = `runtime-${data.type || 'video'}-${data.contentIds || data.activityId || data.videoId}`;
    const dismissed = [];
    const notifications = {
      getPresentedNotificationsAsync: async () => [{
        request: { identifier: runtimeId, content: { data } },
      }],
      dismissNotificationAsync: async (identifier) => dismissed.push(identifier),
    };
    const details = notificationSeenDetails(response(data, runtimeId));
    const result = await dismissExactSeenNotification(notifications, details);
    assert.equal(result.dismissed, true);
    assert.deepEqual(dismissed, [runtimeId]);
  }
});

test('dismiss failure and missing identifiers never block seen processing', async () => {
  for (const [identifier, dismissExact] of [
    ['notification-1', async () => { throw new Error('native dismissal failed'); }],
    [null, async (details) => dismissExactSeenNotification({
      getPresentedNotificationsAsync: async () => { throw new Error('should not enumerate'); },
    }, details)],
  ]) {
    const events = [];
    const result = await handleNotificationSeenResponse(
      response({ channelId: 'UC1', videoId: 'v1' }, identifier),
      {
        enqueue: async () => events.push('enqueue'),
        dismissExact,
        applyLocal: async () => events.push('local'),
        dismissCovered: async () => events.push('sweep'),
        updateSurface: async () => events.push('widget'),
        flush: async () => { events.push('flush'); return { confirmed: 1 }; },
      },
    );
    assert.equal(result.handled, true);
    assert.deepEqual(events, ['enqueue', 'local', 'sweep', 'widget', 'flush']);
    assert.equal(result.delivery.confirmed, 1);
    assert.equal(result.localErrors.length, identifier ? 1 : 0);
  }
});

test('blocked widget refresh is bounded after exact dismissal and covered sweep', async () => {
  const events = [];
  const result = await handleNotificationSeenResponse(response({ channelId: 'UC1', videoId: 'v1' }), {
    enqueue: async () => events.push('enqueue'),
    dismissExact: async () => events.push('exact'),
    applyLocal: async () => events.push('local'),
    dismissCovered: async () => events.push('sweep'),
    updateSurface: async () => {
      events.push('widget-start');
      return await new Promise(() => {});
    },
    flush: async () => { events.push('flush'); return { confirmed: 1 }; },
    surfaceTimeoutMs: 5,
  });
  assert.deepEqual(events, ['enqueue', 'exact', 'local', 'sweep', 'widget-start', 'flush']);
  assert.equal(result.delivery.confirmed, 1);
  assert.deepEqual(result.localErrors.map(({ stage }) => stage), ['surface']);
});
