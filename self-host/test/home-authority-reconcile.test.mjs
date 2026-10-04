import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureHomeAuthorityCurrent } from '../src/home-authority-reconcile.mjs';
import { JsonStateFile } from '../src/file-state.mjs';
import { contentHash } from '../src/kv-adapters.mjs';

class MemoryAdapter {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); }
  async listKeys() { return [...this.values.keys()].sort().map((name) => ({ name })); }
  async get(name) { return this.values.has(name) ? this.values.get(name) : null; }
  async put(name, value) { this.values.set(name, String(value)); }
  async delete(name) { this.values.delete(name); }
}

function snapshot(entries) {
  const records = Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => ({
    key,
    value,
    hash: contentHash(value),
  }));
  return {
    records,
    recordCount: records.length,
    manifestHash: contentHash(records.map(({ key, hash }) => `${key}\0${hash}\n`).join('')),
    leaseId: 'reconcile-test-lease',
  };
}

test('stale Home authority is replaced from the exact canonical snapshot and reactivated', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-reconcile-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const local = new MemoryAdapter({ old: 'stale', 'handle:local': 'preserved' });
  const canonical = snapshot({ alpha: 'one', beta: 'two' });
  const client = {
    activated: null,
    async status() { return { replication: { status: 'stale' } }; },
    async snapshotCanonical() { return canonical; },
    async activateCanonical(manifest) { this.activated = manifest; },
    async releaseReconciliation() {},
    async markStale() {},
  };
  const gate = {
    reconciled: null,
    async status() { return { replication: { status: 'stale' } }; },
    async reconcile(manifest) { this.reconciled = manifest; },
  };
  const syncStateFile = new JsonStateFile(path.join(dataDir, 'sync.json'), {});
  const result = await ensureHomeAuthorityCurrent({
    local, client, gate, syncStateFile, now: () => Date.UTC(2026, 9, 4, 20, 30),
  });
  assert.equal(result.reconciled, true);
  assert.equal(local.values.has('old'), false);
  assert.equal(local.values.get('alpha'), 'one');
  assert.equal(local.values.get('beta'), 'two');
  assert.equal(local.values.get('handle:local'), 'preserved');
  assert.equal(client.activated.leaseId, canonical.leaseId);
  assert.deepEqual(gate.reconciled, { manifestHash: canonical.manifestHash, recordCount: 2 });
  const sync = await syncStateFile.read();
  assert.equal(sync.lastPull.canonicalReset, true);
  assert.equal(Object.keys(sync.baseline).length, 2);
});

test('current local and remote authorities do not perform an expensive snapshot pull', async () => {
  let snapshots = 0;
  const result = await ensureHomeAuthorityCurrent({
    local: new MemoryAdapter(),
    client: {
      async status() { return { replication: { status: 'current' } }; },
      async snapshotCanonical() { snapshots++; },
    },
    gate: { async status() { return { replication: { status: 'current' } }; } },
    syncStateFile: { async write() {} },
  });
  assert.equal(result.reconciled, false);
  assert.equal(snapshots, 0);
});
