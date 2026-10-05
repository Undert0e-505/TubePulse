import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {
  enqueueSeenMutation,
  flushSeenMutationQueue,
  readSeenMutationQueue,
} from '../src/utils/seenPersistence.mjs';

class MemoryStorage {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); }
  async getItem(key) { return this.values.get(key) ?? null; }
  async setItem(key, value) { this.values.set(key, String(value)); }
}

test('offline failure retains the durable exact intent without rolling back optimistic state', async () => {
  const storage = new MemoryStorage();
  const optimistic = { unwatched: false };
  await enqueueSeenMutation({ storage, channelId: 'channel-a', contentIds: ['video-a'] });
  const result = await flushSeenMutationQueue({
    storage, deviceId: 'device', persist: async () => { throw new Error('offline'); }, now: () => 1000,
  });
  assert.equal(optimistic.unwatched, false);
  assert.equal(result.confirmed, 0);
  assert.deepEqual((await readSeenMutationQueue(storage)).intents[0].contentIds, ['video-a']);
});

test('queue survives reload and coalesces duplicate IDs per channel', async () => {
  const storage = new MemoryStorage();
  await enqueueSeenMutation({ storage, channelId: 'channel-a', contentIds: ['video-a', 'video-a'] });
  await enqueueSeenMutation({ storage, channelId: 'channel-a', contentIds: ['video-b'] });
  const reloaded = new MemoryStorage(Object.fromEntries(storage.values));
  const queue = await readSeenMutationQueue(reloaded);
  assert.equal(queue.intents.length, 1);
  assert.deepEqual(queue.intents[0].contentIds, ['video-a', 'video-b']);
});

test('successful retry removes only confirmed exact IDs', async () => {
  const storage = new MemoryStorage();
  await enqueueSeenMutation({ storage, channelId: 'channel-a', contentIds: ['video-a'] });
  const calls = [];
  const result = await flushSeenMutationQueue({
    storage, deviceId: 'device', force: true,
    persist: async (_device, channel, ids, clearAll) => {
      calls.push({ channel, ids, clearAll });
      return { ok: true };
    },
  });
  assert.equal(result.confirmed, 1);
  assert.deepEqual(calls, [{ channel: 'channel-a', ids: ['video-a'], clearAll: false }]);
  assert.equal((await readSeenMutationQueue(storage)).intents.length, 0);
});

test('failed retry is retained with bounded backoff', async () => {
  const storage = new MemoryStorage();
  await enqueueSeenMutation({ storage, channelId: 'channel-a', contentIds: ['video-a'], now: () => 1000 });
  await flushSeenMutationQueue({
    storage, deviceId: 'device', persist: async () => ({ ok: false }), now: () => 1000,
  });
  const [intent] = (await readSeenMutationQueue(storage)).intents;
  assert.equal(intent.attempts, 1);
  assert.equal(intent.nextAttemptAt, 16_000);
  const noSpam = await flushSeenMutationQueue({
    storage, deviceId: 'device', persist: async () => assert.fail('backoff must suppress retry'), now: () => 2000,
  });
  assert.equal(noSpam.attempted, 0);
});

test('delayed channel action is exact and cannot clear future content', async () => {
  const storage = new MemoryStorage();
  await enqueueSeenMutation({ storage, channelId: 'channel-a', contentIds: ['at-tap-video', 'post:at-tap-post'] });
  const sent = [];
  await flushSeenMutationQueue({
    storage, deviceId: 'device', force: true,
    persist: async (_device, _channel, ids, clearAll) => { sent.push({ ids, clearAll }); return { ok: true }; },
  });
  assert.deepEqual(sent, [{ ids: ['at-tap-video', 'post:at-tap-post'], clearAll: false }]);
  assert.equal(sent[0].ids.includes('future-video'), false);
});

test('concurrent enqueue during flush is not dropped when the snapshot succeeds', async () => {
  const storage = new MemoryStorage();
  await enqueueSeenMutation({ storage, channelId: 'channel-a', contentIds: ['video-a'] });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const flushing = flushSeenMutationQueue({
    storage, deviceId: 'device', force: true, maxIntents: 1,
    persist: async () => { started(); await blocked; return { ok: true }; },
  });
  await began;
  await enqueueSeenMutation({ storage, channelId: 'channel-a', contentIds: ['video-b'] });
  release();
  await flushing;
  assert.deepEqual((await readSeenMutationQueue(storage)).intents[0].contentIds, ['video-b']);
});

test('Home no longer renders a persistence banner or queues delayed clearAll', async () => {
  const source = await fs.readFile(new URL('../src/screens/HomeScreen.js', import.meta.url), 'utf8');
  assert.equal(source.includes('Seen status wasn’t saved'), false);
  assert.equal(source.includes('contentIds: allIds'), true);
  assert.equal(source.includes('markSeen(deviceId, channelId, [], true)'), false);
});

test('notification and widget tap paths enqueue exact IDs instead of fire-and-forget clearAll', async () => {
  const [app, widget] = await Promise.all([
    fs.readFile(new URL('../App.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/components/widgetTaskHandler.js', import.meta.url), 'utf8'),
  ]);
  assert.match(app, /enqueueSeenMutation\(\{[\s\S]*contentIds: exactSeenIds/);
  assert.equal(app.includes('markSeen(deviceId, data.channelId, plan.contentIds, plan.clearAll)'), false);
  assert.match(widget, /contentIds: \[\.\.\.videoIds, \.\.\.postIds\]/);
  assert.equal(widget.includes('markSeen(deviceId, channelId, [], true)'), false);
});
