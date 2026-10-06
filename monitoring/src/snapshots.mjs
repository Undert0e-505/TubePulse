import fs from 'node:fs';
import path from 'node:path';

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function atomicWrite(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, value, { encoding: 'utf8', mode: 0o600 });
  // Windows rejects fsync on a read-only descriptor; r+ is portable and the
  // file remains closed before the atomic replacement.
  const descriptor = fs.openSync(temporary, 'r+');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
}

export function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWrite(filePath, `${JSON.stringify(value)}\n`);
}

function snapshotFile(snapshotDir, intervalStart) {
  return path.join(snapshotDir, `${String(intervalStart).slice(0, 10)}.jsonl`);
}

export function appendSnapshotOnce(snapshotDir, snapshot) {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(String(snapshot?.intervalStart || ''))) {
    throw new Error('Snapshot intervalStart must be an ISO timestamp');
  }
  fs.mkdirSync(snapshotDir, { recursive: true });
  const filePath = snapshotFile(snapshotDir, snapshot.intervalStart);
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    if (existing.some((line) => {
      try { return JSON.parse(line).intervalStart === snapshot.intervalStart; } catch { return false; }
    })) return { appended: false, filePath };
  }
  const descriptor = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(descriptor, `${JSON.stringify(snapshot)}\n`, null, 'utf8');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  return { appended: true, filePath };
}

export function pruneSnapshots(snapshotDir, { retentionDays = 1095, nowMs = Date.now() } = {}) {
  if (!fs.existsSync(snapshotDir)) return 0;
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(snapshotDir)) {
    if (!DAY_FILE.test(name)) continue;
    const day = Date.parse(`${name.slice(0, 10)}T00:00:00.000Z`);
    if (Number.isFinite(day) && day < cutoff) {
      fs.unlinkSync(path.join(snapshotDir, name));
      removed++;
    }
  }
  return removed;
}
