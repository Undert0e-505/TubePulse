import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableKvMirror, writeAtomicJson } from '../src/kv-durable-mirror.mjs';
import { contentHash } from '../src/kv-adapters.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-kv-mirror-'));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

for (const stage of ['temp-write', 'file-flush', 'rename', 'directory-flush']) {
  test(`atomic interruption after ${stage} leaves a complete old or new generation`, async (t) => {
    const directory = await fixture(t);
    const target = path.join(directory, 'record.json');
    await writeAtomicJson(target, { schemaVersion: 1, value: 'old' });
    await assert.rejects(() => writeAtomicJson(target, { schemaVersion: 1, value: 'new' }, {
      interruptAfter: stage,
    }), /simulated interruption/);
    const current = JSON.parse(await fs.readFile(target, 'utf8'));
    assert.ok(['old', 'new'].includes(current.value));
  });
}

test('orphan temp and displaced files are cleaned only when explicitly requested', async (t) => {
  const dataDir = await fixture(t);
  const mirror = new DurableKvMirror(dataDir);
  await fs.mkdir(mirror.directory, { recursive: true });
  await fs.writeFile(path.join(mirror.directory, 'interrupted.tmp'), '\0'.repeat(32));
  await fs.writeFile(path.join(mirror.directory, 'old.swap'), '{"valid":true}\n');
  assert.equal((await fs.readdir(mirror.directory)).length, 2);
  assert.equal(await mirror.cleanupOrphans(), 2);
  assert.deepEqual(await fs.readdir(mirror.directory), []);
});

test('mirror rejects NUL and empty values instead of legitimising them', async (t) => {
  const dataDir = await fixture(t);
  const mirror = new DurableKvMirror(dataDir);
  await assert.rejects(() => mirror.put('device:test:profile', '\0'.repeat(10)), /invalid durable KV mirror value/);
  await assert.rejects(() => mirror.put('device:test:profile', ''), /invalid durable KV mirror value/);
  await assert.rejects(() => fs.access(mirror.filePath('device:test:profile')), /ENOENT/);
});

test('bulk canonical reconciliation writes complete envelopes and validates the whole snapshot', async (t) => {
  const dataDir = await fixture(t);
  const mirror = new DurableKvMirror(dataDir);
  const records = Array.from({ length: 128 }, (_, index) => {
    const key = `device:bulk-${index}:profile`;
    const value = JSON.stringify({ index, enabled: true });
    return { key, value, hash: contentHash(value) };
  });
  await mirror.reconcile(records, { concurrency: 16 });
  assert.deepEqual(await mirror.validate(records), { status: 'passed', missing: 0, mismatched: 0 });
  assert.equal((await fs.readdir(path.join(dataDir, 'kv-durable-mirror')))
    .filter((name) => name.endsWith('.tmp') || name.endsWith('.swap')).length, 0);
});

test('ordinary writes flush the parent directory for every committed record', async (t) => {
  const dataDir = await fixture(t);
  const directorySyncs = [];
  const mirror = new DurableKvMirror(dataDir, {
    syncDirectoryFn: async (directory) => directorySyncs.push(directory),
  });
  await mirror.put('device:one:profile', JSON.stringify({ enabled: true }));
  await mirror.put('device:two:profile', JSON.stringify({ enabled: true }));
  assert.deepEqual(directorySyncs, [mirror.directory, mirror.directory]);
});

test('bulk reconciliation flushes every file but syncs the directory once', async (t) => {
  const dataDir = await fixture(t);
  let directorySyncs = 0;
  const writes = [];
  const mirror = new DurableKvMirror(dataDir, {
    atomicWriter: async (file, value, options) => {
      writes.push({ file, syncParent: options.syncParent });
      await writeAtomicJson(file, value, options);
    },
    syncDirectoryFn: async () => { directorySyncs++; },
  });
  const records = Array.from({ length: 64 }, (_, index) => {
    const key = `device:batch-${index}:profile`;
    const value = JSON.stringify({ index });
    return { key, value, hash: contentHash(value) };
  });
  await mirror.reconcile(records, { concurrency: 8 });
  assert.equal(writes.length, records.length);
  assert.ok(writes.every(({ syncParent }) => syncParent === false));
  assert.equal(directorySyncs, 1);
  assert.deepEqual(await mirror.validate(records), { status: 'passed', missing: 0, mismatched: 0 });
});

test('interrupted bulk reconciliation is not finalised and safely resumes', async (t) => {
  const dataDir = await fixture(t);
  let directorySyncs = 0;
  let writes = 0;
  let interrupt = true;
  const mirror = new DurableKvMirror(dataDir, {
    atomicWriter: async (file, value, options) => {
      writes++;
      if (interrupt && writes === 2) throw new Error('simulated bulk interruption');
      await writeAtomicJson(file, value, options);
    },
    syncDirectoryFn: async () => { directorySyncs++; },
  });
  const records = Array.from({ length: 12 }, (_, index) => {
    const key = `device:resume-${index}:profile`;
    const value = JSON.stringify({ index });
    return { key, value, hash: contentHash(value) };
  });
  await assert.rejects(() => mirror.reconcile(records, { concurrency: 1 }), /simulated bulk interruption/);
  assert.equal(directorySyncs, 0, 'an incomplete batch must not receive the final directory sync');
  assert.equal((await mirror.validate(records)).status, 'failed');

  interrupt = false;
  writes = 0;
  await mirror.reconcile(records, { concurrency: 4 });
  assert.equal(directorySyncs, 1);
  assert.deepEqual(await mirror.validate(records), { status: 'passed', missing: 0, mismatched: 0 });
});
