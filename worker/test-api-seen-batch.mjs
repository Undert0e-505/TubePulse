import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './tubepulse-api/index.js';

class MemoryKv {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]));
    this.writes = 0;
  }
  async get(key, type) {
    const raw = this.values.get(key) ?? null;
    return type === 'json' && raw !== null ? JSON.parse(raw) : raw;
  }
  async put(key, value) { this.writes++; this.values.set(key, String(value)); }
  async delete(key) { this.writes++; this.values.delete(key); }
}

function seenRequest(body) {
  return new Request('https://api.test/seen', {
    method: 'POST',
    headers: { Authorization: 'Bearer device-1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('batch seen removes only exact snapshot IDs and updates nag index once', async () => {
  const kv = new MemoryKv({
    'device:device-1:state:A': { unwatched: ['old-a', 'new-a'], nagCount: 4, lastNagAt: 123 },
    'device:device-1:state:B': { unwatched: ['old-b'], nagCount: 2, lastNagAt: 456 },
    'nag:active': ['device-1|A', 'device-1|B', 'other|C'],
  });
  const response = await worker.fetch(seenRequest({ channels: [
    { channelId: 'A', contentIds: ['old-a'] },
    { channelId: 'B', contentIds: ['old-b'] },
  ] }), { TUBEPULSE_KV: kv }, { waitUntil() {} });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    channels: [{ channelId: 'A', unwatchedCount: 1 }, { channelId: 'B', unwatchedCount: 0 }],
  });
  assert.deepEqual(await kv.get('device:device-1:state:A', 'json'), {
    unwatched: ['new-a'], nagCount: 4, lastNagAt: 123,
  });
  assert.deepEqual(await kv.get('device:device-1:state:B', 'json'), {
    unwatched: [], nagCount: 0, lastNagAt: null,
  });
  assert.deepEqual(await kv.get('nag:active', 'json'), ['device-1|A', 'other|C']);
});

test('legacy single-channel contract remains compatible and idempotent', async () => {
  const kv = new MemoryKv({
    'device:device-1:state:A': { unwatched: ['v1', 'v2'], nagCount: 1, lastNagAt: 10 },
    'nag:active': ['device-1|A'],
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await worker.fetch(seenRequest({ channelId: 'A', videoIds: ['v1'] }),
      { TUBEPULSE_KV: kv }, { waitUntil() {} });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, unwatchedCount: 1 });
  }
  assert.deepEqual((await kv.get('device:device-1:state:A', 'json')).unwatched, ['v2']);
});
