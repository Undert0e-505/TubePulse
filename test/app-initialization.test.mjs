import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAppInitializationMarker,
  getPreviewHomeConnectionPhase,
  isExpectedInitializationComplete,
  isCurrentInitializationComplete,
  waitForCurrentInitialization,
} from '../src/utils/appInitialization.mjs';

test('persisted completion from an earlier app session does not release Home', () => {
  assert.equal(isCurrentInitializationComplete('999', 1000), false);
  assert.equal(isCurrentInitializationComplete('1000', 1000), true);
  assert.equal(isCurrentInitializationComplete('not-a-time', 1000), false);
});

test('one application remount cannot consume another mount completion marker', async () => {
  const first = createAppInitializationMarker({ now: () => 1000, random: () => 0.1 });
  const second = createAppInitializationMarker({ now: () => 1000, random: () => 0.1 });
  assert.notEqual(first, second);
  assert.equal(isExpectedInitializationComplete(first, second), false);
  assert.equal(isExpectedInitializationComplete(second, second), true);

  const values = [first, second];
  const completed = await waitForCurrentInitialization({
    expectedMarker: second,
    maxAttempts: 2,
    pollIntervalMs: 1,
    readCompletion: async () => values.shift(),
    sleep: async () => {},
  });
  assert.equal(completed, true);
});

test('first feed work waits until registration initialization completes', async () => {
  const events = [];
  let reads = 0;
  const completed = await waitForCurrentInitialization({
    notBefore: 1000,
    maxAttempts: 3,
    pollIntervalMs: 1,
    readCompletion: async () => {
      reads += 1;
      events.push(`read-${reads}`);
      return reads < 3 ? '900' : '1001';
    },
    sleep: async () => { events.push('wait'); },
  });
  events.push('feed');

  assert.equal(completed, true);
  assert.deepEqual(events, ['read-1', 'wait', 'read-2', 'wait', 'read-3', 'feed']);
});

test('initialization wait is bounded so real failures remain visible', async () => {
  let sleeps = 0;
  const completed = await waitForCurrentInitialization({
    notBefore: 1000,
    maxAttempts: 3,
    pollIntervalMs: 1,
    readCompletion: async () => null,
    sleep: async () => { sleeps += 1; },
  });

  assert.equal(completed, false);
  assert.equal(sleeps, 2);
  assert.equal(getPreviewHomeConnectionPhase({
    initializationPending: completed,
    connectionError: 'Network error',
  }), 'error');
});

test('Preview banner stays neutral while pending, then reflects success or failure', () => {
  assert.equal(getPreviewHomeConnectionPhase({
    initializationPending: true,
    connectionError: 'Device not registered',
  }), 'connecting');
  assert.equal(getPreviewHomeConnectionPhase({
    initializationPending: false,
    connectionError: null,
  }), 'ready');
  assert.equal(getPreviewHomeConnectionPhase({
    initializationPending: false,
    connectionError: 'Network error',
  }), 'error');
});
