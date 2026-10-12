import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleNotificationSeenResponse,
  notificationIdsAreCovered,
  notificationSeenDetails,
} from '../src/utils/notificationSeenAction.mjs';

function response(data, identifier = 'notification-1') {
  return { notification: { request: { identifier, content: { data } } } };
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
    applyLocal: async () => events.push('local'),
    updateSurface: async () => events.push('widget'),
    dismissCovered: async () => events.push('dismiss'),
    flush: async () => { events.push('flush'); return { remaining: 1 }; },
  });
  assert.equal(result.handled, true);
  assert.deepEqual(events, ['enqueue:v1,v2', 'local', 'widget', 'dismiss', 'flush']);
});
