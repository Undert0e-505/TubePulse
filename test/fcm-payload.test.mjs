import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFcmMessage,
  classifyPermanentFcmTokenError,
  normalizeNotificationCapability,
  sendFCMPush,
} from '../worker/tubepulse-cron/shared.mjs';

const payloads = [
  ['single upload', { title: 'Channel uploaded', body: 'Video', data: { type: 'video', channelId: 'UC1', videoId: 'v1' }, tag: 'video-v1' }],
  ['multi-video upload batch', { title: 'Channel - 2 new videos', body: 'One\nTwo', data: { type: 'batch', channelId: 'UC1', count: '2', contentIds: '["v1","v2"]' }, tag: 'tubepulse-batch' }],
  ['single-video reminder', { title: 'Channel - reminder', body: 'Video', data: { type: 'nag', channelId: 'UC1', videoId: 'v1', notificationTag: 'video-v1' }, tag: 'video-v1' }],
  ['single-community reminder', { title: 'Channel - reminder', body: 'Post', data: { type: 'nag', channelId: 'UC1', activityId: 'p1', notificationTag: 'post-p1' }, tag: 'post-p1' }],
  ['mixed unread reminder batch', { title: 'Channel - 2 unread', body: 'Unread content', data: { type: 'batch', channelId: 'UC1', count: '2', contentIds: '["v1","post:p1"]' }, tag: 'tubepulse-nag-UC1' }],
  ['live prewarning', { notification: { title: 'Going live soon', body: 'Starting in 30 minutes' }, data: { type: 'prewarn', channelId: 'UC1', videoId: 'v1' }, tag: 'video-v1' }],
  ['community post', { notification: { title: 'Channel posted', body: 'Post' }, data: { type: 'post', channelId: 'UC1', activityId: 'p1', notificationTag: 'post-p1' }, tag: 'post-p1' }],
];

test('legacy profiles retain notification plus data Android payloads', () => {
  for (const [name, payload] of payloads) {
    const message = buildFcmMessage('token', payload, null);
    assert.ok(message.notification, `${name} retains Android auto-display for old clients`);
    assert.equal(message.android.priority, 'high');
    assert.ok(message.android.notification.channel_id);
    assert.equal(message.data, payload.data);
    assert.equal('localRender' in message.data, false);
  }
});

test('capable profiles receive self-contained high-priority data-only payloads', () => {
  for (const [name, payload] of payloads) {
    const message = buildFcmMessage('token', payload, 'local-v1');
    assert.equal(message.notification, undefined, `${name} must be rendered by the capable client`);
    assert.deepEqual(message.android, { priority: 'high' });
    assert.equal(message.data.localRender, '1');
    assert.equal(message.data.channelId, 'UC1', `${name} carries the channel needed by mute actions`);
    assert.equal(message.data.notificationTitle, payload.title ?? payload.notification.title);
    assert.equal(message.data.notificationBody, payload.body ?? payload.notification.body);
    assert.equal(message.data.notificationTag, payload.tag);
    assert.ok(Object.values(message.data).every((value) => typeof value === 'string'));
  }
});

test('capability validation fails closed', () => {
  assert.equal(normalizeNotificationCapability('local-v1'), 'local-v1');
  assert.equal(normalizeNotificationCapability('local-v2'), null);
  assert.equal(normalizeNotificationCapability(true), null);
});

test('permanent FCM token errors classify only established cleanup outcomes', () => {
  assert.equal(classifyPermanentFcmTokenError(404, '{}'), 'http-404');
  assert.equal(classifyPermanentFcmTokenError(400, '{"errorCode":"UNREGISTERED"}'), 'unregistered');
  assert.equal(classifyPermanentFcmTokenError(400, 'registration token is NotRegistered'), 'not-registered');
  for (const [status, body] of [
    [401, 'UNAUTHENTICATED'],
    [403, 'PERMISSION_DENIED'],
    [429, 'QUOTA_EXCEEDED'],
    [500, 'INTERNAL'],
    [503, 'UNAVAILABLE'],
    [400, 'INVALID_ARGUMENT'],
    [200, 'UNREGISTERED'],
    [400, 'unregistered'],
    [400, 'Not Registered'],
  ]) {
    assert.equal(classifyPermanentFcmTokenError(status, body), null, `${status} ${body}`);
  }
});

test('FCM sender annotates permanent token invalidation without broadening transient failures', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}', { status: 400 });
    const permanent = await sendFCMPush('access', 'project', 'token', payloads[0][1]);
    assert.equal(permanent.sent, false);
    assert.equal(permanent.deadToken, true);
    assert.equal(permanent.permanentInvalidTokenClass, 'unregistered');

    globalThis.fetch = async () => new Response('{"error":{"status":"UNAVAILABLE"}}', { status: 503 });
    const transient = await sendFCMPush('access', 'project', 'token', payloads[0][1]);
    assert.equal(transient.sent, false);
    assert.equal(transient.deadToken, false);
    assert.equal(transient.permanentInvalidTokenClass, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
