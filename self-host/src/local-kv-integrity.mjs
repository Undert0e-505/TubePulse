import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JsonStateFile } from './file-state.mjs';
import { contentHash } from './kv-adapters.mjs';
import { isAuthorityCanonicalKey } from './home-authority.mjs';

const SCHEMA_VERSION = 1;
const DEFAULT_CONCURRENCY = 16;

function initialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    totalScans: 0,
    totalFailures: 0,
    totalRecoveries: 0,
    lastScan: null,
    lastFailure: null,
    lastRecovery: null,
  };
}

export function createLocalKvIntegrityStateFile(dataDir) {
  return new JsonStateFile(path.join(dataDir, 'home-kv-integrity.json'), initialState());
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

async function physicalBlobIntegrity(dataDir, concurrency) {
  const directory = path.join(dataDir, 'kv', 'tubepulse-self-host-local', 'blobs');
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return {
      blobCount: 0, blobBytes: 0, emptyBlobs: 0, nulBlobs: 0, invalidJsonBlobs: 0,
    };
    throw error;
  }
  const results = await mapLimit(names, concurrency, async (name) => {
    const value = await fs.readFile(path.join(directory, name));
    let validJson = true;
    try { JSON.parse(value.toString('utf8')); } catch { validJson = false; }
    return {
      bytes: value.length,
      empty: value.length === 0,
      nul: value.includes(0),
      validJson,
    };
  });
  return {
    blobCount: results.length,
    blobBytes: results.reduce((total, result) => total + result.bytes, 0),
    emptyBlobs: results.filter(({ empty }) => empty).length,
    nulBlobs: results.filter(({ nul }) => nul).length,
    invalidJsonBlobs: results.filter(({ validJson }) => !validJson).length,
  };
}

export async function scanLocalAuthorityIntegrity(adapter, {
  dataDir,
  expectedManifest = null,
  now = Date.now,
  concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  const startedAtMs = now();
  const listed = (await adapter.listKeys())
    .filter(({ name }) => isAuthorityCanonicalKey(name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const records = await mapLimit(listed, concurrency, async ({ name }) => {
    const value = await adapter.get(name);
    if (value === null || value === undefined) return { key: name, missing: true, hash: null };
    const text = String(value);
    let validJson = true;
    try { JSON.parse(text); } catch { validJson = false; }
    return {
      key: name,
      hash: contentHash(text),
      bytes: Buffer.byteLength(text),
      empty: text.length === 0,
      nul: text.includes('\0'),
      validJson,
    };
  });
  const physical = await physicalBlobIntegrity(dataDir, concurrency);
  const present = records.filter(({ missing }) => !missing);
  const manifestHash = contentHash(present.map(({ key, hash }) => `${key}\0${hash}\n`).join(''));
  const expectedCount = expectedManifest ? Number(expectedManifest.recordCount) : null;
  const expectedHash = expectedManifest ? String(expectedManifest.manifestHash || expectedManifest.hash || '') : null;
  const result = {
    status: 'passed',
    scannedAt: new Date(startedAtMs).toISOString(),
    durationMs: Math.max(0, now() - startedAtMs),
    recordCount: present.length,
    recordBytes: present.reduce((total, record) => total + Number(record.bytes || 0), 0),
    missingValues: records.filter(({ missing }) => missing).length,
    emptyValues: records.filter(({ empty }) => empty).length,
    nulValues: records.filter(({ nul }) => nul).length,
    invalidJsonValues: records.filter(({ validJson }) => validJson === false).length,
    manifestHash,
    expectedRecordCount: expectedCount,
    expectedManifestHash: expectedHash,
    manifestMatches: expectedManifest
      ? present.length === expectedCount && manifestHash === expectedHash
      : null,
    ...physical,
    physicalBlobSurplus: Math.max(0, physical.blobCount - present.length),
  };
  const invalid = result.missingValues + result.emptyValues + result.nulValues
    + result.invalidJsonValues + result.emptyBlobs + result.nulBlobs + result.invalidJsonBlobs;
  if (invalid > 0 || (expectedManifest && result.manifestMatches !== true)) result.status = 'failed';
  return result;
}

export async function recordLocalKvIntegrity(stateFile, scan, {
  recoveryAttempted = false,
  recoverySucceeded = false,
  forensicPath = null,
} = {}) {
  const state = await stateFile.read();
  state.schemaVersion = SCHEMA_VERSION;
  state.totalScans = Number(state.totalScans || 0) + 1;
  state.lastScan = { ...scan };
  if (scan.status !== 'passed') {
    state.totalFailures = Number(state.totalFailures || 0) + 1;
    state.lastFailure = { ...scan };
  }
  if (recoveryAttempted) {
    if (recoverySucceeded) state.totalRecoveries = Number(state.totalRecoveries || 0) + 1;
    state.lastRecovery = {
      attemptedAt: new Date().toISOString(),
      succeeded: recoverySucceeded,
      ...(forensicPath ? { forensicPath } : {}),
    };
  }
  await stateFile.write(state);
  return state;
}

async function listFiles(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

export async function preserveLocalKvForensics(dataDir, scan, { now = Date.now } = {}) {
  const timestamp = new Date(now()).toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  const destination = path.join(dataDir, 'incident-backups', `automatic-kv-integrity-${timestamp}`);
  await fs.mkdir(destination, { recursive: true });
  const sources = [
    'kv',
    'home-authority-state.json',
    'home-authority-state.json.bak',
    'home-scheduler-sync-state.json',
    'home-scheduler-sync-state.json.bak',
    'home-notification-intents.json',
    'home-notification-intents.json.bak',
    'startup-recovery-timeline.json',
  ];
  for (const name of sources) {
    const source = path.join(dataDir, name);
    try {
      await fs.cp(source, path.join(destination, name), { recursive: true, errorOnExist: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await fs.writeFile(path.join(destination, 'integrity-report.json'), `${JSON.stringify(scan, null, 2)}\n`, {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
  const files = await listFiles(destination);
  const manifest = [];
  for (const file of files.sort()) {
    const value = await fs.readFile(file);
    manifest.push({
      path: path.relative(destination, file).replaceAll('\\', '/'),
      bytes: value.length,
      sha256: crypto.createHash('sha256').update(value).digest('hex'),
    });
  }
  const manifestText = `${JSON.stringify({ schemaVersion: 1, files: manifest }, null, 2)}\n`;
  await fs.writeFile(path.join(destination, 'sha256-manifest.json'), manifestText, {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
  return { path: destination, fileCount: manifest.length, manifestHash: contentHash(manifestText) };
}

export function publicLocalKvIntegrity(state) {
  const scan = state?.lastScan || null;
  return {
    status: scan?.status || 'unknown',
    scannedAt: scan?.scannedAt || null,
    durationMs: Number(scan?.durationMs || 0),
    recordCount: Number(scan?.recordCount || 0),
    blobCount: Number(scan?.blobCount || 0),
    failures: Number(state?.totalFailures || 0),
    recoveries: Number(state?.totalRecoveries || 0),
    activeIssues: scan?.status === 'failed'
      ? Number(scan.missingValues || 0) + Number(scan.emptyValues || 0) + Number(scan.nulValues || 0)
        + Number(scan.invalidJsonValues || 0) + Number(scan.emptyBlobs || 0) + Number(scan.nulBlobs || 0)
        + Number(scan.invalidJsonBlobs || 0) + (scan.manifestMatches === false ? 1 : 0)
      : 0,
    lastRecoverySucceeded: state?.lastRecovery?.succeeded === true,
  };
}
