import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeviceIdResolver } from '../src/utils/deviceIdentity.mjs';

function createDependencies(overrides = {}) {
  const state = {
    secureValue: null,
    fallbackValue: null,
    secureGets: 0,
    secureSets: 0,
    fallbackGets: 0,
    fallbackSets: 0,
    uuidCalls: 0,
  };
  const dependencies = {
    secureStore: {
      async getItemAsync() {
        state.secureGets += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return state.secureValue;
      },
      async setItemAsync(_key, value) {
        state.secureSets += 1;
        state.secureValue = value;
      },
    },
    application: { getAndroidId: () => 'android-id' },
    asyncStorage: {
      async getItem() {
        state.fallbackGets += 1;
        return state.fallbackValue;
      },
      async setItem(_key, value) {
        state.fallbackSets += 1;
        state.fallbackValue = value;
      },
    },
    secureStoreKey: 'secure-key',
    fallbackStorageKey: 'fallback-key',
    generateUuid() {
      state.uuidCalls += 1;
      return 'generated-id';
    },
    warn: () => {},
    ...overrides,
  };
  return { dependencies, state };
}

test('concurrent first-launch calls mint and persist one secure identity', async () => {
  const { dependencies, state } = createDependencies();
  const getDeviceId = createDeviceIdResolver(dependencies);

  const ids = await Promise.all(Array.from({ length: 12 }, () => getDeviceId()));

  assert.deepEqual(new Set(ids), new Set(['secure:generated-id']));
  assert.equal(state.secureGets, 1);
  assert.equal(state.secureSets, 1);
  assert.equal(state.uuidCalls, 1);
});

test('a failed resolution is retryable instead of caching a rejected promise', async () => {
  let fallbackAttempts = 0;
  const { dependencies } = createDependencies({
    secureStore: {
      async getItemAsync() { throw new Error('secure store unavailable'); },
      async setItemAsync() {},
    },
    application: { getAndroidId: () => { throw new Error('android id unavailable'); } },
    asyncStorage: {
      async getItem() {
        fallbackAttempts += 1;
        if (fallbackAttempts === 1) throw new Error('storage temporarily unavailable');
        return 'uuid:recovered';
      },
      async setItem() {},
    },
  });
  const getDeviceId = createDeviceIdResolver(dependencies);

  await assert.rejects(getDeviceId(), /temporarily unavailable/);
  assert.equal(await getDeviceId(), 'uuid:recovered');
  assert.equal(fallbackAttempts, 2);
});
