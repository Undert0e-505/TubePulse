import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyNagLedgerAdvances,
  mergeNagLedgers,
  modelPackedNagLedger,
  nagCursorForChannel,
  nagLedgerLimits,
  pruneNagLedgerChannels,
  readNagLedger,
} from './tubepulse-cron/nag-ledger.mjs';

class MemoryKv {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values).map(([name, value]) => [
      name, typeof value === 'string' ? value : JSON.stringify(value),
    ]));
    this.writes = [];
  }

  async get(name, type = 'text') {
    const value = this.values.get(name);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }

  async put(name, value) {
    this.values.set(name, String(value));
    this.writes.push(name);
  }

  async delete(name) { this.values.delete(name); }
}

function state(unwatched, lastNagAt, nagCount = 0) {
  return { unwatched, lastNagAt, nagCount };
}

test('lazy migration imports every current unseen legacy cursor and applies a multi-channel cycle once', async () => {
  const kv = new MemoryKv({
    'device:install:channels': ['B', 'A', 'seen'],
    'device:install:state:A': state(['a'], 1000, 4),
    'device:install:state:B': state(['b'], 2000, 7),
    'device:install:state:seen': state([], 3000, 9),
  });
  const missing = await readNagLedger(kv, 'install');
  assert.deepEqual(nagCursorForChannel(missing, 'A', state(['a'], 1000, 4)), { lastNagAt: 1000, nagCount: 4 });

  const result = await applyNagLedgerAdvances(kv, 'install', [
    { channelId: 'A', lastNagAt: 5000, incrementNagCount: true },
    { channelId: 'B', lastNagAt: 5000, incrementNagCount: true },
  ]);
  assert.deepEqual(result, { changed: true, channels: 2 });
  assert.equal(kv.writes.filter((name) => name === 'device:install:nag-ledger').length, 1);
  assert.deepEqual(JSON.parse(kv.values.get('device:install:nag-ledger')), {
    schemaVersion: 1,
    channels: {
      A: { lastNagAt: 5000, nagCount: 5 },
      B: { lastNagAt: 5000, nagCount: 8 },
    },
  });
});

test('packed cursors are independent per installation and retrying the same raster is idempotent', async () => {
  const kv = new MemoryKv({
    'device:one:channels': ['A'], 'device:one:state:A': state(['a'], null),
    'device:two:channels': ['A'], 'device:two:state:A': state(['a'], null),
  });
  await applyNagLedgerAdvances(kv, 'one', [{ channelId: 'A', lastNagAt: 5000, incrementNagCount: true }]);
  await applyNagLedgerAdvances(kv, 'two', [{ channelId: 'A', lastNagAt: 5000, incrementNagCount: true }]);
  await applyNagLedgerAdvances(kv, 'one', [{ channelId: 'A', lastNagAt: 5000, incrementNagCount: true }]);
  assert.equal(kv.writes.filter((name) => name.endsWith(':nag-ledger')).length, 2);
  assert.equal((await readNagLedger(kv, 'one')).channels.A.nagCount, 1);
  assert.equal((await readNagLedger(kv, 'two')).channels.A.nagCount, 1);
});

test('pruning removes seen and unsubscribed channels without manufacturing a ledger', async () => {
  const kv = new MemoryKv({
    'device:install:nag-ledger': {
      schemaVersion: 1,
      channels: { A: { lastNagAt: 1, nagCount: 1 }, B: { lastNagAt: 2, nagCount: 2 } },
    },
  });
  assert.equal(await pruneNagLedgerChannels(kv, 'install', ['B']), true);
  assert.deepEqual((await readNagLedger(kv, 'install')).channels, { A: { lastNagAt: 1, nagCount: 1 } });
  assert.equal(await pruneNagLedgerChannels(kv, 'missing', ['A']), false);
});

test('installation identity migration merges packed cursors with the new identity taking precedence', async () => {
  const kv = new MemoryKv({
    'device:old:nag-ledger': { schemaVersion: 1, channels: {
      A: { lastNagAt: 1, nagCount: 1 }, B: { lastNagAt: 2, nagCount: 2 },
    } },
    'device:new:nag-ledger': { schemaVersion: 1, channels: { B: { lastNagAt: 3, nagCount: 3 } } },
  });
  assert.equal(await mergeNagLedgers(kv, 'old', 'new'), true);
  assert.deepEqual((await readNagLedger(kv, 'new')).channels, {
    A: { lastNagAt: 1, nagCount: 1 }, B: { lastNagAt: 3, nagCount: 3 },
  });
});

test('corrupt, oversized and over-wide ledgers fail closed', async () => {
  const corrupt = new MemoryKv({ 'device:bad:nag-ledger': '{' });
  await assert.rejects(readNagLedger(corrupt, 'bad'), /invalid JSON/);
  const oversized = new MemoryKv({ 'device:big:nag-ledger': 'x'.repeat(nagLedgerLimits.maxValueBytes + 1) });
  await assert.rejects(readNagLedger(oversized, 'big'), /oversized/);
  const channels = Object.fromEntries(Array.from({ length: nagLedgerLimits.maxChannels + 1 }, (_, index) => [
    `C${index}`, { lastNagAt: index + 1, nagCount: 0 },
  ]));
  const wide = new MemoryKv({ 'device:wide:nag-ledger': { schemaVersion: 1, channels } });
  await assert.rejects(readNagLedger(wide, 'wide'), /too many channels/);
});

test('capacity model reports the conservative observed-fleet ceiling', () => {
  assert.deepEqual(modelPackedNagLedger({ logicalMutations: 12_090, installations: 27 }), {
    logicalBefore: 12_090,
    logicalAfterCeiling: 7_776,
    logicalSavedFloor: 4_314,
    d1RowsBefore: 36_270,
    d1RowsAfterCeiling: 23_328,
    d1RowsSavedFloor: 12_942,
  });
});
