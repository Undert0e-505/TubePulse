import assert from 'node:assert/strict';
import test from 'node:test';

import { createRetryableAsyncSetup } from '../src/utils/retryableAsyncSetup.mjs';

test('notification category setup is single-flight and remains ready after success', async () => {
  let calls = 0;
  let release;
  const ensureSetup = createRetryableAsyncSetup(async () => {
    calls++;
    await new Promise((resolve) => { release = resolve; });
  });

  const first = ensureSetup();
  const second = ensureSetup();
  assert.equal(calls, 0, 'setup begins asynchronously so callers share the same promise');
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  await ensureSetup();
  assert.equal(calls, 1);
});

test('notification category setup can retry after a native registration failure', async () => {
  let calls = 0;
  const ensureSetup = createRetryableAsyncSetup(async () => {
    calls++;
    if (calls === 1) throw new Error('native category unavailable');
  });

  await assert.rejects(ensureSetup(), /native category unavailable/);
  await ensureSetup();
  assert.equal(calls, 2);
});
