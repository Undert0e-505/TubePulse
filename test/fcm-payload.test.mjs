import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFcmMessage,
  normalizeNotificationCapability,
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
