import assert from 'node:assert/strict';
import test from 'node:test';
import { runSeenMutation } from '../src/utils/seenPersistence.mjs';

test('successful seen persistence keeps the optimistic UI state', async () => {
  let rolledBack = false;
  const result = await runSeenMutation({
    persist: async () => ({ ok: true, unwatchedCount: 0 }),
    rollback: async () => { rolledBack = true; },
  });
  assert.equal(result.ok, true);
  assert.equal(rolledBack, false);
});

test('an HTTP-style {ok:false} result rolls back instead of pretending seen state persisted', async () => {
  let rollbacks = 0;
  const result = await runSeenMutation({
    persist: async () => ({ ok: false, status: 500, error: 'Internal server error' }),
    rollback: async () => { rollbacks++; },
  });
  assert.deepEqual(result, { ok: false, status: 500, error: 'Internal server error' });
  assert.equal(rollbacks, 1);
});

test('a thrown network failure also rolls back exactly once', async () => {
  let rollbacks = 0;
  const result = await runSeenMutation({
    persist: async () => { throw new Error('Network error'); },
    rollback: async () => { rollbacks++; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Network error');
  assert.equal(rollbacks, 1);
});
