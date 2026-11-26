import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStateFile } from '../src/file-state.mjs';
import { createLocalKvIntegrityStateFile, scanLocalAuthorityIntegrity } from '../src/local-kv-integrity.mjs';
import { verifyAndRecoverHomeAuthority } from '../src/home-authority-reconcile.mjs';
import { contentHash } from '../src/kv-adapters.mjs';

class MemoryAdapter {
  constructor(records = {}) { this.records = new Map(Object.entries(records)); this.missing = new Set(); this.puts = 0; }
  async listKeys() { return [...new Set([...this.records.keys(), ...this.missing])].map((name) => ({ name })); }
  async get(key) { return this.records.get(key) ?? null; }
  async put(key, value) { this.puts++; this.records.set(key, value); }
  async delete(key) { this.records.delete(key); }
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-integrity-'));
  t.after(async () => await fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function snapshot(records) {
  const canonical = Object.entries(records).map(([key, value]) => ({ key, value, hash: contentHash(value) }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return { leaseId: 'reconcile-test-lease', records: canonical, recordCount: canonical.length,
    manifestHash: contentHash(canonical.map(({ key, hash }) => `${key}\0${hash}\n`).join('')) };
}

for (const [name, value, field] of [
  ['NUL-filled', '\0'.repeat(50), 'nulValues'],
  ['truncated', '{"unwatched":[', 'invalidJsonValues'],
  ['malformed', 'not-json', 'invalidJsonValues'],
]) {
  test(`${name} value fails despite a cached-current manifest`, async (t) => {
    const dataDir = await fixture(t);
    const expected = snapshot({ 'device:test:state:channel': '{"unwatched":[]}' });
    const result = await scanLocalAuthorityIntegrity(
      new MemoryAdapter({ 'device:test:state:channel': value }),
      { dataDir, expectedManifest: expected },
    );
    assert.equal(result.status, 'failed');
    assert.ok(result[field] > 0);
    assert.equal(result.manifestMatches, false);
  });
}

test('valid JSON with a different hash fails signed manifest comparison', async (t) => {
  const dataDir = await fixture(t);
  const result = await scanLocalAuthorityIntegrity(
    new MemoryAdapter({ 'device:test:settings': '{"nagMinutes":15}' }),
    { dataDir, expectedManifest: snapshot({ 'device:test:settings': '{"nagMinutes":5}' }) },
  );
  assert.equal(result.invalidJsonValues, 0);
  assert.equal(result.manifestMatches, false);
  assert.equal(result.status, 'failed');
});

test('listed value missing from blob storage fails closed', async (t) => {
  const dataDir = await fixture(t);
  const adapter = new MemoryAdapter();
  adapter.missing.add('device:test:profile');
  const result = await scanLocalAuthorityIntegrity(adapter, {
    dataDir, expectedManifest: snapshot({ 'device:test:profile': '{"appVersion":"4.5.0"}' }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.missingValues, 1);
});

test('physical NUL blob fails even when logical records match canonical', async (t) => {
  const dataDir = await fixture(t);
  const blobDir = path.join(dataDir, 'kv', 'tubepulse-self-host-local', 'blobs');
  await fs.mkdir(blobDir, { recursive: true });
  await fs.writeFile(path.join(blobDir, 'corrupt'), Buffer.alloc(128));
  const records = { 'device:test:profile': '{"appVersion":"4.5.0"}' };
  const result = await scanLocalAuthorityIntegrity(new MemoryAdapter(records), {
    dataDir, expectedManifest: snapshot(records),
  });
  assert.equal(result.manifestMatches, true);
  assert.equal(result.nulBlobs, 1);
  assert.equal(result.status, 'failed');
});

test('exact D1 repair preserves settings, subscriptions, unseen state, and pending intent', async (t) => {
  const dataDir = await fixture(t);
  const expected = {
    'device:test:profile': '{"appVersion":"4.5.0","fcmToken":"token"}',
    'device:test:settings': '{"nagMinutes":5,"notificationMode":"relentless"}',
    'device:test:channels': '["channel-a"]',
    'device:test:state:channel-a': '{"unwatched":["video-a"],"lastNagAt":100}',
    'channel:channel-a:subscribers': '["test"]',
  };
  const canonical = snapshot(expected);
  const adapter = new MemoryAdapter({ ...expected, 'device:test:state:channel-a': '\0'.repeat(80) });
  const intent = '{"schemaVersion":1,"records":{"intent":{"status":"pending"}}}\n';
  await fs.writeFile(path.join(dataDir, 'home-notification-intents.json'), intent);
  const activated = [];
  const gate = { stale: [], reconciled: [], async markStale(reason) { this.stale.push(reason); },
    async reconcile(value) { this.reconciled.push(value); } };
  const client = { async status() { return { ok: true, replication: { status: 'current' }, pendingBackupKeys: 0 }; },
    async snapshotCanonical() { return canonical; }, async activateCanonical(value) { activated.push(value); },
    async releaseReconciliation() {}, async markStale() {} };
  const integrityStateFile = createLocalKvIntegrityStateFile(dataDir);
  const result = await verifyAndRecoverHomeAuthority({
    local: adapter, client, gate,
    syncStateFile: new JsonStateFile(path.join(dataDir, 'sync.json'), { schemaVersion: 1 }),
    integrityStateFile, dataDir,
  });
  assert.equal(result.repaired, true);
  assert.equal(result.updated, 1);
  assert.deepEqual(Object.fromEntries(adapter.records), expected);
  assert.equal(await fs.readFile(path.join(dataDir, 'home-notification-intents.json'), 'utf8'), intent);
  assert.deepEqual(gate.stale, ['local-integrity-failed']);
  assert.equal(gate.reconciled.length, 1);
  assert.equal(activated.length, 1);
  const integrity = await integrityStateFile.read();
  assert.equal(integrity.totalFailures, 1);
  assert.equal(integrity.totalRecoveries, 1);
  assert.equal(integrity.lastScan.status, 'passed');
});

test('remote unavailability fails closed without altering local data', async (t) => {
  const dataDir = await fixture(t);
  const corrupt = '\0'.repeat(20);
  const adapter = new MemoryAdapter({ 'device:test:profile': corrupt });
  await assert.rejects(() => verifyAndRecoverHomeAuthority({
    local: adapter,
    client: { async status() { return { ok: false, pendingBackupKeys: 0 }; },
      async snapshotCanonical() { throw new Error('remote unavailable'); } },
    gate: {}, syncStateFile: new JsonStateFile(path.join(dataDir, 'sync.json'), {}),
    integrityStateFile: createLocalKvIntegrityStateFile(dataDir), dataDir,
  }), /remote unavailable/);
  assert.equal(adapter.puts, 0);
  assert.equal(await adapter.get('device:test:profile'), corrupt);
});
