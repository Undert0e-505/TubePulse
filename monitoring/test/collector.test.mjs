import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCollector, intervalFor } from '../src/collector.mjs';

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('collector writes once per interval, survives a partial failure, and retains last good data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tubepulse-collector-'));
  try {
    const tokenFile = path.join(root, 'token.txt');
    fs.writeFileSync(tokenFile, 'test-token');
    let failHost = false;
    const fetchImpl = async (url) => {
      if (String(url).includes('host.test')) return failHost ? jsonResponse({}, 503) : jsonResponse({ privacy: 'aggregate-only', host: { ready: true } });
      return jsonResponse({ data: { viewer: { accounts: [{
        workerWindow: [], workerDay: [], d1Window: [], d1Day: [], d1Storage: [],
        doInvocationsWindow: [], doInvocationsDay: [], doPeriodicWindow: [], doPeriodicDay: [], doStorage: [],
      }] } } });
    };
    const config = {
      port: 9464, hostStatusUrl: 'http://host.test/monitoring', accountId: 'a'.repeat(32),
      d1DatabaseId: '11111111-2222-3333-4444-555555555555', workerScript: 'tubepulse-api', tokenFile,
      snapshotDir: path.join(root, 'snapshots'), stateFile: path.join(root, 'collector', 'state.json'),
      cadenceMs: 300_000, analyticsDelayMs: 600_000, retentionDays: 1095,
      limits: { d1RowsWritten: 100000, d1RowsRead: 5000000, workerRequests: 100000 },
    };
    const firstTime = Date.parse('2026-10-06T11:06:00Z');
    const collector = createCollector({ config, fetchImpl, now: () => firstTime });
    const first = await collector.collect(firstTime);
    assert.equal(first.snapshot.collection.success, true);
    assert.equal((await collector.collect(firstTime + 1_000)).skipped, true);

    failHost = true;
    const secondTime = firstTime + 300_000;
    const second = await collector.collect(secondTime);
    assert.equal(second.snapshot.collection.success, false);
    assert.equal(second.snapshot.collection.hostSuccess, false);
    assert.equal(second.snapshot.host.host.ready, true);
    assert.equal(collector.state.errorsTotal, 1);
    assert.match(collector.metrics(), /tubepulse_collector_host_collection_success 0/);
    const lines = fs.readFileSync(path.join(root, 'snapshots', '2026-10-06.jsonl'), 'utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, 2);

    const restarted = createCollector({ config, fetchImpl, now: () => secondTime });
    assert.equal(restarted.state.lastIntervalStart, second.snapshot.intervalStart);
    assert.equal((await restarted.collect(secondTime + 1_000)).skipped, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('intervals are aligned and non-overlapping', () => {
  assert.deepEqual(intervalFor(Date.parse('2026-10-06T11:06:12Z')), {
    startMs: Date.parse('2026-10-06T11:00:00Z'), endMs: Date.parse('2026-10-06T11:05:00Z'),
  });
});
