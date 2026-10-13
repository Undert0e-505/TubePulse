import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { processBackgroundNotificationActionPayload } from '../src/utils/notificationBackgroundAction.mjs';
import { notificationActionDetails } from '../src/utils/notificationActionHandling.mjs';
import {
  normalizeNotificationActionResponse,
  notificationResponseData,
} from '../src/utils/notificationResponseNormalization.mjs';
import { notificationSeenDetails } from '../src/utils/notificationSeenAction.mjs';
import { NOTIFICATION_ACTIONS } from '../src/utils/localNotificationSilence.mjs';

function rawResponse(actionIdentifier, dataString, identifier = 'local-channel-event-message') {
  return {
    actionIdentifier,
    notification: {
      date: 1,
      request: {
        identifier,
        trigger: { type: 'channel', channelId: 'new-videos' },
        content: { title: 'Title', body: 'Body', dataString },
      },
    },
  };
}

function rawJsonResponse(actionIdentifier, data, identifier) {
  return rawResponse(actionIdentifier, JSON.stringify(data), identifier);
}

test('real Expo raw headless Mark Seen shapes normalize before dispatch', async () => {
  const variants = [
    ['single', { channelId: 'UC1', videoId: 'v1', type: 'nag' }, ['v1']],
    ['bundle', { channelId: 'UC1', contentIds: '["v2","v1"]', type: 'batch' }, ['v2', 'v1']],
    ['post', { channelId: 'UC1', activityId: 'post-1', type: 'post' }, ['post:post-1']],
    ['channel-muted', { channelId: 'UC1', videoId: 'v1', localSilent: '1' }, ['v1']],
    ['global-muted', { channelId: 'UC1', videoId: 'v1', localSilent: '1', globallyMuted: '1' }, ['v1']],
  ];

  for (const [name, data, expectedIds] of variants) {
    const identifier = `local-channel-event-${name}`;
    const calls = [];
    const result = await processBackgroundNotificationActionPayload({
      data: rawJsonResponse(NOTIFICATION_ACTIONS.MARK_SEEN, data, identifier),
      error: null,
    }, {
      processSeen: async (response) => {
        calls.push(notificationSeenDetails(response));
        return { handled: true };
      },
      processSilence: async () => { throw new Error('wrong route'); },
    });
    assert.deepEqual(result, { handled: true });
    assert.deepEqual(calls, [{
      channelId: 'UC1', contentIds: expectedIds, notificationIdentifier: identifier,
    }]);
  }
});
test('real Expo raw headless mute and unmute shapes normalize before dispatch', async () => {
  for (const actionIdentifier of [
    NOTIFICATION_ACTIONS.MUTE_CHANNEL_1H,
    NOTIFICATION_ACTIONS.MUTE_CHANNEL_8H,
    NOTIFICATION_ACTIONS.MUTE_ALL,
    NOTIFICATION_ACTIONS.UNMUTE_CHANNEL,
    NOTIFICATION_ACTIONS.UNMUTE_ALL,
  ]) {
    const identifier = `local-channel-event-${actionIdentifier}`;
    const calls = [];
    const result = await processBackgroundNotificationActionPayload({
      data: rawJsonResponse(actionIdentifier, { channelId: 'UC1', videoId: 'v1' }, identifier),
      error: null,
    }, {
      processSeen: async () => { throw new Error('wrong route'); },
      processSilence: async (response) => {
        calls.push(notificationActionDetails(response));
        return { handled: true };
      },
    });
    assert.deepEqual(result, { handled: true });
    assert.deepEqual(calls, [{ actionIdentifier, channelId: 'UC1', notificationIdentifier: identifier }]);
  }
});

test('already mapped foreground data wins and is not overwritten by dataString', () => {
  const response = rawJsonResponse(NOTIFICATION_ACTIONS.MARK_SEEN, {
    channelId: 'wrong', videoId: 'wrong',
  });
  response.notification.request.content.data = { channelId: 'correct', videoId: 'right' };
  const normalized = normalizeNotificationActionResponse(response);
  assert.equal(normalized.valid, true);
  assert.equal(normalized.normalized, false);
  assert.equal(normalized.response, response);
  assert.deepEqual(notificationSeenDetails(response), {
    channelId: 'correct', contentIds: ['right'], notificationIdentifier: 'local-channel-event-message',
  });
});

test('malformed, missing, array, primitive and oversized raw data fail closed', async () => {
  const invalid = [
    rawResponse(NOTIFICATION_ACTIONS.MARK_SEEN, undefined),
    rawResponse(NOTIFICATION_ACTIONS.MARK_SEEN, '{bad json'),
    rawResponse(NOTIFICATION_ACTIONS.MARK_SEEN, '[]'),
    rawResponse(NOTIFICATION_ACTIONS.MARK_SEEN, '"text"'),
    rawResponse(NOTIFICATION_ACTIONS.MARK_SEEN, JSON.stringify({ value: 'x'.repeat(70 * 1024) })),
  ];
  for (const data of invalid) {
    let called = false;
    const warnings = [];
    const result = await processBackgroundNotificationActionPayload({ data, error: null }, {
      processSeen: async () => { called = true; },
      processSilence: async () => { called = true; },
      warn: (message) => warnings.push(message),
    });
    assert.equal(result.handled, false);
    assert.equal(called, false);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes('UC1'), false);
  }
});

test('invalid mapped data can fall back to a valid raw object but never to a non-object', () => {
  const response = rawJsonResponse(NOTIFICATION_ACTIONS.MARK_SEEN, { channelId: 'UC1', videoId: 'v1' });
  response.notification.request.content.data = [];
  assert.equal(notificationResponseData(response).source, 'dataString');
  response.notification.request.content.dataString = 'null';
  assert.equal(notificationResponseData(response).data, null);
});

test('background boundary returns and awaits the complete processing promise', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let completed = false;
  const running = processBackgroundNotificationActionPayload({
    data: rawJsonResponse(NOTIFICATION_ACTIONS.MARK_SEEN, { channelId: 'UC1', videoId: 'v1' }),
    error: null,
  }, {
    processSeen: async () => { await blocked; completed = true; return { handled: true }; },
    processSilence: async () => { throw new Error('wrong route'); },
  });
  await Promise.resolve();
  assert.equal(completed, false);
  release();
  assert.deepEqual(await running, { handled: true });
  assert.equal(completed, true);
});

test('registered TaskManager executor awaits the shared normalized boundary', async () => {
  const source = await readFile(new URL('../src/utils/notificationBackgroundTask.js', import.meta.url), 'utf8');
  assert.match(source, /TaskManager\.defineTask\([\s\S]*await processBackgroundNotificationActionPayload\(task/);
  assert.match(source, /processSeen:\s*processNotificationSeenResponse/);
  assert.match(source, /processSilence:\s*processLocalNotificationActionResponse/);
});
