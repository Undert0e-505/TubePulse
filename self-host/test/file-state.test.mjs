import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStateFile, StateFileCorruptionError } from '../src/file-state.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-file-state-'));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  return { directory, filePath, stateFile: new JsonStateFile(filePath, { schemaVersion: 1, count: 0 }) };
}

test('a completed write flushes matching primary and last-known-good generations', async (t) => {
  const { filePath, stateFile } = await fixture(t);
  await stateFile.write({ schemaVersion: 1, count: 7 });

  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), { schemaVersion: 1, count: 7 });
  assert.deepEqual(JSON.parse(await fs.readFile(`${filePath}.bak`, 'utf8')), { schemaVersion: 1, count: 7 });
});

for (const [name, corrupt] of [
  ['zero-filled', '\0'.repeat(512)],
  ['truncated', '{"schemaVersion":1,"count":'],
  ['empty', ''],
]) {
  test(`${name} primary is quarantined and recovered from the last-known-good generation`, async (t) => {
    const { directory, filePath, stateFile } = await fixture(t);
    await stateFile.write({ schemaVersion: 1, count: 11 });
    await fs.writeFile(filePath, corrupt, 'utf8');

    const restarted = new JsonStateFile(filePath, { schemaVersion: 1, count: 0 });
    assert.deepEqual(await restarted.read(), { schemaVersion: 1, count: 11 });
    assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), { schemaVersion: 1, count: 11 });
    const quarantined = (await fs.readdir(directory)).filter((entry) => entry.startsWith('state.json.corrupt-'));
    assert.equal(quarantined.length, 1);
  });
}

test('missing primary is restored from backup rather than reset to initial state', async (t) => {
  const { filePath, stateFile } = await fixture(t);
  await stateFile.write({ schemaVersion: 1, count: 19 });
  await fs.rm(filePath);

  const restarted = new JsonStateFile(filePath, { schemaVersion: 1, count: 0 });
  assert.deepEqual(await restarted.read(), { schemaVersion: 1, count: 19 });
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), { schemaVersion: 1, count: 19 });
});

test('an orphaned interrupted-write temp file cannot replace a valid generation', async (t) => {
  const { directory, filePath, stateFile } = await fixture(t);
  await stateFile.write({ schemaVersion: 1, count: 23 });
  await fs.writeFile(path.join(directory, 'state.json.interrupted.tmp'), '\0'.repeat(200), 'utf8');

  const restarted = new JsonStateFile(filePath, { schemaVersion: 1, count: 0 });
  assert.deepEqual(await restarted.read(), { schemaVersion: 1, count: 23 });
});

test('corruption without any valid generation fails closed and preserves quarantine evidence', async (t) => {
  const { directory, filePath } = await fixture(t);
  await fs.writeFile(filePath, '\0'.repeat(100), 'utf8');
  await fs.writeFile(`${filePath}.bak`, '{"broken":', 'utf8');
  const stateFile = new JsonStateFile(filePath, { schemaVersion: 1, count: 0 });

  await assert.rejects(() => stateFile.read(), StateFileCorruptionError);
  const entries = await fs.readdir(directory);
  assert.ok(entries.some((entry) => entry.startsWith('state.json.bak.corrupt-')));
  assert.ok(entries.includes('state.json'));
});

test('concurrent writes serialize complete generations without mixed or truncated JSON', async (t) => {
  const { filePath, stateFile } = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, count) => stateFile.write({ schemaVersion: 1, count })));

  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), { schemaVersion: 1, count: 19 });
  assert.deepEqual(JSON.parse(await fs.readFile(`${filePath}.bak`, 'utf8')), { schemaVersion: 1, count: 19 });
});

test('first successful read establishes a backup for pre-hardening state files', async (t) => {
  const { filePath, stateFile } = await fixture(t);
  await fs.writeFile(filePath, '{"schemaVersion":1,"count":31}\n', 'utf8');

  assert.deepEqual(await stateFile.read(), { schemaVersion: 1, count: 31 });
  assert.deepEqual(JSON.parse(await fs.readFile(`${filePath}.bak`, 'utf8')), { schemaVersion: 1, count: 31 });
});
