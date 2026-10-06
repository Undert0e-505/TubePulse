import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendSnapshotOnce, pruneSnapshots, readJson, writeJsonAtomic } from '../src/snapshots.mjs';

test('snapshot append is restart-safe and de-duplicates an interval', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tubepulse-monitoring-'));
  try {
    const snapshot = { intervalStart: '2026-10-06T11:00:00.000Z', safe: true };
    assert.equal(appendSnapshotOnce(root, snapshot).appended, true);
    assert.equal(appendSnapshotOnce(root, snapshot).appended, false);
    const lines = fs.readFileSync(path.join(root, '2026-10-06.jsonl'), 'utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    writeJsonAtomic(path.join(root, 'state', 'latest.json'), snapshot);
    assert.deepEqual(readJson(path.join(root, 'state', 'latest.json')), snapshot);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('snapshot retention removes only expired daily files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tubepulse-monitoring-'));
  try {
    fs.writeFileSync(path.join(root, '2020-01-01.jsonl'), '{}\n');
    fs.writeFileSync(path.join(root, '2026-10-06.jsonl'), '{}\n');
    fs.writeFileSync(path.join(root, 'README.txt'), 'keep');
    assert.equal(pruneSnapshots(root, { retentionDays: 365, nowMs: Date.parse('2026-10-06T12:00:00Z') }), 1);
    assert.equal(fs.existsSync(path.join(root, '2026-10-06.jsonl')), true);
    assert.equal(fs.existsSync(path.join(root, 'README.txt')), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
