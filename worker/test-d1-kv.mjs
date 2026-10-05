import assert from 'node:assert/strict';
import test from 'node:test';
import { D1KvNamespace, D1_MAX_VALUE_BYTES, d1KvTestHelpers } from './tubepulse-api/d1-kv.mjs';
import { FakeD1 } from './test-support/fake-d1.mjs';

async function activeStore(now = () => Date.parse('2026-10-05T12:00:00Z')) {
  const database = new FakeD1();
  const store = new D1KvNamespace(database, 'production-v1', { now });
  await store.activate({ manifestHash: '0'.repeat(64), recordCount: 0 });
  return { database, store };
}

test('D1 KV adapter preserves text, JSON, explicit null and explicit zero', async () => {
  const { store } = await activeStore();
  await store.put('text', 'hello');
  await store.put('json', JSON.stringify({ zero: 0, nil: null }));
  assert.equal(await store.get('text'), 'hello');
  assert.deepEqual(await store.get('json', 'json'), { zero: 0, nil: null });
  assert.equal(await store.get('missing'), null);
  await store.delete('text');
  assert.equal(await store.get('text'), null);
});

test('D1 KV adapter honors expiration and TTL without exposing expired rows', async () => {
  let now = Date.parse('2026-10-05T12:00:00Z');
  const { store } = await activeStore(() => now);
  await store.put('absolute', 'a', { expiration: Math.floor(now / 1000) + 90 });
  await store.put('ttl', 'b', { expirationTtl: 60 });
  assert.equal(await store.get('ttl'), 'b');
  now += 61_000;
  assert.equal(await store.get('ttl'), null);
  assert.equal((await store.list()).keys.some(({ name }) => name === 'ttl'), false);
  assert.equal(await store.get('absolute'), 'a');
});

test('D1 KV list is prefix ordered and cursor stable across limits', async () => {
  const { store } = await activeStore();
  for (const key of ['other', 'prefix:c', 'prefix:a', 'prefix:b']) await store.put(key, key);
  const first = await store.list({ prefix: 'prefix:', limit: 2 });
  assert.deepEqual(first.keys.map(({ name }) => name), ['prefix:a', 'prefix:b']);
  assert.equal(Object.hasOwn(first.keys[0], 'expiration'), false, 'non-expiring rows omit expiration');
  assert.equal(first.list_complete, false);
  const second = await store.list({ prefix: 'prefix:', limit: 2, cursor: first.cursor });
  assert.deepEqual(second.keys.map(({ name }) => name), ['prefix:c']);
  assert.equal(second.list_complete, true);
});

test('D1 canonical snapshot reads every visible value in one set query', async () => {
  let now = Date.parse('2026-10-05T12:00:00Z');
  const { database, store } = await activeStore(() => now);
  for (let index = 0; index < 60; index++) await store.put(`snapshot:${index}`, String(index));
  await store.put('snapshot:expired', 'old', { expiration: Math.floor(now / 1000) + 1 });
  now += 2_000;
  const before = database.statementCount;
  const records = await store.snapshotRecords();
  assert.equal(database.statementCount - before, 2, 'active-generation check plus one set query');
  assert.equal(records.length, 60);
  assert.equal(records.some(({ key }) => key === 'snapshot:expired'), false);
  assert.equal(records.some((record) => Object.hasOwn(record, 'expiration')), false);
  assert.deepEqual(records, [...records].sort((left, right) => left.key.localeCompare(right.key)));
});

test('D1 KV adapter rejects values that could exceed the D1 row limit', async () => {
  const { store } = await activeStore();
  await assert.rejects(() => store.put('large', 'x'.repeat(D1_MAX_VALUE_BYTES + 1)), /too-large/);
});

test('conditional D1 batch is atomic, hash guarded and safely retryable', async () => {
  const { store } = await activeStore();
  const oldHash = await d1KvTestHelpers.sha256('old');
  const nextHash = await d1KvTestHelpers.sha256('next');
  await store.put('alpha', 'old');
  await store.applyConditionalBatch([
    { key: 'alpha', operation: 'put', value: 'next', baseHash: oldHash, nextHash, options: {} },
    { key: 'beta', operation: 'put', value: 'new', baseHash: null,
      nextHash: await d1KvTestHelpers.sha256('new'), options: {} },
  ]);
  assert.equal(await store.get('alpha'), 'next');
  assert.equal(await store.get('beta'), 'new');
  await store.applyConditionalBatch([
    { key: 'alpha', operation: 'put', value: 'next', baseHash: oldHash, nextHash, options: {} },
  ]);
  const unsafeHash = await d1KvTestHelpers.sha256('unsafe');
  const betaHash = await d1KvTestHelpers.sha256('new');
  await assert.rejects(() => store.applyConditionalBatch([
    { key: 'alpha', operation: 'put', value: 'unsafe', baseHash: 'f'.repeat(64),
      nextHash: unsafeHash, options: {} },
    { key: 'beta', operation: 'delete', baseHash: betaHash, nextHash: null },
  ]), /CHECK constraint/);
  assert.equal(await store.get('alpha'), 'next');
  assert.equal(await store.get('beta'), 'new', 'failed precondition rolls back the whole batch');
});

test('large conditional D1 publication remains a constant four-query atomic batch', async () => {
  const { database, store } = await activeStore();
  const deltas = [];
  for (let index = 0; index < 60; index++) {
    const value = JSON.stringify({ index });
    deltas.push({
      key: `bulk:${String(index).padStart(3, '0')}`,
      operation: 'put',
      value,
      baseHash: null,
      nextHash: await d1KvTestHelpers.sha256(value),
      options: {},
    });
  }
  const result = await store.applyConditionalBatch(deltas);
  assert.equal(database.lastBatchStatementCount, 4);
  assert.equal(result.logicalWrites, 60);
  assert.equal(result.estimatedRowsWritten, 180);
  assert.equal(await store.get('bulk:059', 'json').then((value) => value.index), 59);
});

test('staged manifest preserves the established mixed-case Home collation', async () => {
  const database = new FakeD1();
  const store = new D1KvNamespace(database, 'production-v1');
  const records = await Promise.all(['channel:a', 'channel:Z', 'channel:B'].map(async (key) => ({
    key, value: key, hash: await d1KvTestHelpers.sha256(key),
  })));
  await store.stageRecords(records);
  const staged = await store.stagedManifest();
  const expected = [...records].sort((left, right) => left.key.localeCompare(right.key));
  assert.deepEqual(staged.records.map(({ key }) => key), expected.map(({ key }) => key));
  assert.equal(staged.manifestHash, await d1KvTestHelpers.sha256(
    expected.map(({ key, hash }) => `${key}\0${hash}\n`).join(''),
  ));
});
