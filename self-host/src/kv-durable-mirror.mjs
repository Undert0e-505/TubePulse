import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { contentHash } from './kv-adapters.mjs';

const REPLACE_CONFLICT_CODES = new Set(['EEXIST', 'EPERM', 'EACCES']);
const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set(['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM', 'EACCES']);

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
    return true;
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED_CODES.has(error?.code)) throw error;
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicReplace(source, target) {
  try { await fs.rename(source, target); return; } catch (error) {
    if (!REPLACE_CONFLICT_CODES.has(error?.code) || !await exists(target)) throw error;
  }
  const displaced = `${target}.${process.pid}.${crypto.randomUUID()}.swap`;
  await fs.rename(target, displaced);
  try {
    await fs.rename(source, target);
  } catch (error) {
    await fs.rename(displaced, target).catch(() => {});
    throw error;
  }
  await fs.rm(displaced, { force: true }).catch(() => {});
}

export async function writeAtomicJson(filePath, value, {
  interruptAfter = null,
  syncParent = true,
  syncDirectoryFn = syncDirectory,
} = {}) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const serialized = `${JSON.stringify(value)}\n`;
  JSON.parse(serialized);
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    if (interruptAfter === 'temp-write') throw new Error('simulated interruption after temp write');
    await handle.sync();
    if (interruptAfter === 'file-flush') throw new Error('simulated interruption after file flush');
    await handle.close();
    handle = null;
    await atomicReplace(temporary, filePath);
    if (interruptAfter === 'rename') throw new Error('simulated interruption after rename');
    if (syncParent) await syncDirectoryFn(directory);
    if (interruptAfter === 'directory-flush') throw new Error('simulated interruption after directory flush');
  } finally {
    await handle?.close().catch(() => {});
    if (interruptAfter === null) await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || typeof envelope.key !== 'string' || !envelope.key) {
    throw new Error('invalid durable KV mirror envelope');
  }
  if (envelope.operation === 'delete') return envelope;
  if (envelope.operation !== 'put' || typeof envelope.value !== 'string'
    || envelope.value.length === 0 || envelope.value.includes('\0')) {
    throw new Error('invalid durable KV mirror value');
  }
  if (contentHash(envelope.value) !== envelope.hash) throw new Error('durable KV mirror hash mismatch');
  return envelope;
}

async function mapLimit(items, limit, mapper) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await mapper(items[next++]);
  }));
}

export class DurableKvMirror {
  constructor(dataDir, {
    atomicWriter = writeAtomicJson,
    syncDirectoryFn = syncDirectory,
  } = {}) {
    this.directory = path.join(dataDir, 'kv-durable-mirror');
    this.writeTails = new Map();
    this.atomicWriter = atomicWriter;
    this.syncDirectory = syncDirectoryFn;
  }

  filePath(key) { return path.join(this.directory, `${contentHash(key)}.json`); }

  async read(key) {
    try {
      const envelope = validateEnvelope(JSON.parse(await fs.readFile(this.filePath(key), 'utf8')));
      if (envelope.key !== key) throw new Error('durable KV mirror key collision');
      return envelope;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(key, envelope, { syncParent = true } = {}) {
    const previous = this.writeTails.get(key) || Promise.resolve();
    const operation = previous.then(async () => await this.atomicWriter(
      this.filePath(key), validateEnvelope(envelope), {
        syncParent,
        syncDirectoryFn: this.syncDirectory,
      },
    ));
    const tail = operation.catch(() => {});
    this.writeTails.set(key, tail);
    try { await operation; } finally {
      if (this.writeTails.get(key) === tail) this.writeTails.delete(key);
    }
  }

  async put(key, value, options = {}, durability = {}) {
    const text = String(value);
    await this.write(key, {
      schemaVersion: 1, key, operation: 'put', value: text, hash: contentHash(text),
      ...(Number.isFinite(options.expiration) ? { expiration: options.expiration } : {}),
    }, durability);
  }

  async delete(key, durability = {}) {
    await this.write(key, { schemaVersion: 1, key, operation: 'delete', hash: null }, durability);
  }

  async reconcile(records, { concurrency = 16 } = {}) {
    await fs.mkdir(this.directory, { recursive: true });
    const expected = new Map(records.map((record) => [record.key, record]));
    await mapLimit(records, concurrency, async (record) => {
      const current = await this.read(record.key).catch(() => null);
      if (current?.operation === 'put' && current.hash === record.hash
        && (current.expiration ?? null) === (record.expiration ?? null)) return;
      await this.put(record.key, record.value, { expiration: record.expiration }, { syncParent: false });
    });
    for (const name of await fs.readdir(this.directory)) {
      if (!name.endsWith('.json')) continue;
      let envelope;
      try { envelope = validateEnvelope(JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8'))); } catch { continue; }
      if (!expected.has(envelope.key) && envelope.operation !== 'delete') {
        await this.delete(envelope.key, { syncParent: false });
      }
    }
    // Every individual file has already been flushed and atomically replaced.
    // One final directory flush makes the bulk snapshot's directory entries
    // durable without doing thousands of expensive directory fsyncs on the
    // Windows bind mount. An interruption still leaves only complete old/new
    // envelopes, and the next verified canonical bootstrap safely resumes.
    await this.syncDirectory(this.directory);
  }

  async validate(records) {
    let missing = 0;
    let mismatched = 0;
    for (const record of records) {
      const envelope = await this.read(record.key).catch(() => null);
      if (!envelope) missing++;
      else if (envelope.operation !== 'put' || envelope.hash !== record.hash) mismatched++;
    }
    return { status: missing === 0 && mismatched === 0 ? 'passed' : 'failed', missing, mismatched };
  }

  async cleanupOrphans() {
    let entries;
    try { entries = await fs.readdir(this.directory); } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
    let removed = 0;
    for (const name of entries.filter((entry) => entry.endsWith('.tmp') || entry.endsWith('.swap'))) {
      await fs.rm(path.join(this.directory, name), { force: true });
      removed++;
    }
    if (removed > 0) await this.syncDirectory(this.directory);
    return removed;
  }
}
