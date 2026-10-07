import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createSettingsWarmCache,
} from '../src/utils/settingsWarmCache.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test('preload reads persisted settings once and exposes the actual warm snapshot', async () => {
  let reads = 0;
  const cache = createSettingsWarmCache({
    readRaw: async () => {
      reads += 1;
      return JSON.stringify({ tapAction: 'channel', nagInterval: 30 });
    },
    writeRaw: async () => {},
    defaults: { tapAction: 'video', nagInterval: 15, dndEnabled: false },
  });

  assert.equal(cache.peek(), null);
  const [first, second] = await Promise.all([cache.preload(), cache.preload()]);
  assert.equal(reads, 1);
  assert.deepEqual(first, {
    tapAction: 'channel', nagInterval: 30, dndEnabled: false,
  });
  assert.deepEqual(second, first);
  assert.deepEqual(cache.peek(), first);
});

test('preload preserves first-install defaults and poll interval migration', async () => {
  const firstWrites = [];
  const firstInstall = createSettingsWarmCache({
    readRaw: async () => null,
    writeRaw: async (value) => { firstWrites.push(JSON.parse(value)); },
    defaults: { tapAction: 'video', nagInterval: 15 },
  });
  assert.deepEqual(await firstInstall.preload(), { tapAction: 'video', nagInterval: 15 });
  assert.deepEqual(firstWrites, [{ tapAction: 'video', nagInterval: 15 }]);

  const migrationWrites = [];
  const migration = createSettingsWarmCache({
    readRaw: async () => JSON.stringify({ tapAction: 'channel', pollInterval: 30 }),
    writeRaw: async (value) => { migrationWrites.push(JSON.parse(value)); },
    defaults: { tapAction: 'video', nagInterval: 15 },
  });
  const migrated = await migration.preload();
  assert.deepEqual(migrated, { tapAction: 'channel', nagInterval: 30 });
  assert.equal('pollInterval' in migrated, false);
  assert.deepEqual(migrationWrites, [{ tapAction: 'channel', nagInterval: 30 }]);
});

test('save updates the warm snapshot before persistence resolves', async () => {
  const write = deferred();
  const cache = createSettingsWarmCache({
    readRaw: async () => JSON.stringify({ tapAction: 'video' }),
    writeRaw: () => write.promise,
    defaults: { tapAction: 'video', nagInterval: 15 },
  });
  await cache.preload();

  const saving = cache.save({ tapAction: 'channel', nagInterval: 30 });
  assert.deepEqual(cache.peek(), { tapAction: 'channel', nagInterval: 30 });
  write.resolve();
  await saving;
});

test('a stale preload cannot overwrite a newer in-process save', async () => {
  const read = deferred();
  const writes = [];
  const cache = createSettingsWarmCache({
    readRaw: () => read.promise,
    writeRaw: async (value) => { writes.push(JSON.parse(value)); },
    defaults: { tapAction: 'video', nagInterval: 15 },
  });

  const loading = cache.preload();
  await cache.save({ tapAction: 'channel', nagInterval: 30 });
  read.resolve(JSON.stringify({ tapAction: 'video', nagInterval: 5 }));

  assert.deepEqual(await loading, { tapAction: 'channel', nagInterval: 30 });
  assert.deepEqual(cache.peek(), { tapAction: 'channel', nagInterval: 30 });
  assert.deepEqual(writes, [{ tapAction: 'channel', nagInterval: 30 }]);
});

test('cold settings become renderable while silence and update loaders remain delayed', async () => {
  const read = deferred();
  const silence = deferred();
  const update = deferred();
  let auxiliarySettled = false;
  Promise.all([silence.promise, update.promise]).then(() => { auxiliarySettled = true; });
  const cache = createSettingsWarmCache({
    readRaw: () => read.promise,
    writeRaw: async () => {},
    defaults: { tapAction: 'video', nagInterval: 15 },
  });

  const settingsOnly = cache.preload();
  read.resolve(JSON.stringify({ tapAction: 'channel', nagInterval: 30 }));
  assert.deepEqual(await settingsOnly, { tapAction: 'channel', nagInterval: 30 });
  assert.equal(auxiliarySettled, false);

  silence.resolve({ globalMuted: false, channels: {} });
  update.resolve(null);
  await Promise.resolve();
});

test('Settings controls never await silence or update auxiliary reads', () => {
  const source = readFileSync(new URL('../src/screens/SettingsScreen.js', import.meta.url), 'utf8');
  assert.match(source, /useState\(\(\) => peekSettings\(\)\)/);
  assert.match(source, /else getSettings\(\)\.then/);
  assert.doesNotMatch(source, /loadSettingsLocalBootstrap|ActivityIndicator/);
  assert.doesNotMatch(source, /Promise\.all/);
  assert.doesNotMatch(source, /readLocalNotificationSilence|silencePromise|warmedSilenceState/);
  assert.match(source, /refreshUpdateIfDue\(UPDATE_ARGS\)\.then/);
  assert.match(source, /warmedAvailableUpdate = null;\s*warmedUpdatePromise = Promise\.resolve\(null\);/);
});
