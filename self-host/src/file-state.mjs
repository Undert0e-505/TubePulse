import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const REPLACE_CONFLICT_CODES = new Set(['EEXIST', 'EPERM', 'EACCES']);
const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set(['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM', 'EACCES']);

export class StateFileCorruptionError extends Error {
  constructor(filePath, cause) {
    super(`Unable to recover state file ${filePath}: ${cause?.message || 'no valid generation is available'}`);
    this.name = 'StateFileCorruptionError';
    this.filePath = filePath;
    this.cause = cause;
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Windows and some container filesystems do not expose directory fsync.
    // The file generations themselves are still flushed before rename.
    if (!DIRECTORY_SYNC_UNSUPPORTED_CODES.has(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeFlushedFile(filePath, contents) {
  const handle = await fs.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicReplace(source, target) {
  try {
    await fs.rename(source, target);
    return;
  } catch (error) {
    if (!REPLACE_CONFLICT_CODES.has(error?.code) || !await pathExists(target)) throw error;
  }

  // Windows can refuse rename-over-existing. Move the old generation aside
  // rather than deleting it, so an interruption always leaves at least one
  // recoverable generation on disk.
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

function describeParseError(error) {
  const message = String(error?.message || error || 'invalid JSON').replace(/[\u0000-\u001f\u007f]/g, '?');
  return message.slice(0, 180);
}

export class JsonStateFile {
  constructor(filePath, initialValue) {
    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
    this.initialValue = initialValue;
    this.writeTail = Promise.resolve();
    this.backupEstablished = false;
    this.backupTail = null;
  }

  validate(value) {
    if (this.initialValue && typeof this.initialValue === 'object' && !Array.isArray(this.initialValue)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('state root must be a JSON object');
      }
    }
    return value;
  }

  parse(raw) {
    if (!String(raw).trim()) throw new Error('state file is empty');
    return this.validate(JSON.parse(raw));
  }

  async readGeneration(filePath) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return { exists: true, raw, value: this.parse(raw) };
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, error };
      return { exists: true, error };
    }
  }

  async quarantine(filePath) {
    if (!await pathExists(filePath)) return null;
    const quarantined = `${filePath}.corrupt-${new Date().toISOString().replace(/[-:.]/g, '')}-${crypto.randomUUID()}`;
    await fs.rename(filePath, quarantined);
    await syncDirectory(path.dirname(filePath));
    return quarantined;
  }

  async persistGeneration(target, serialized) {
    const directory = path.dirname(target);
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFlushedFile(temporary, serialized);
      await atomicReplace(temporary, target);
      await syncDirectory(directory);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async restoreBackup(backup) {
    const serialized = backup.raw.endsWith('\n') ? backup.raw : `${backup.raw}\n`;
    await this.persistGeneration(this.filePath, serialized);
    // Re-flush the recovered last-known-good generation before returning.
    await this.persistGeneration(this.backupPath, serialized);
    return structuredClone(backup.value);
  }

  async establishBackup(primary) {
    if (this.backupEstablished) return;
    this.backupTail ||= (async () => {
      const backup = await this.readGeneration(this.backupPath);
      if (backup.value === undefined) {
        if (backup.exists) await this.quarantine(this.backupPath);
        const serialized = primary.raw.endsWith('\n') ? primary.raw : `${primary.raw}\n`;
        await this.persistGeneration(this.backupPath, serialized);
      }
      this.backupEstablished = true;
    })();
    try {
      await this.backupTail;
    } finally {
      if (!this.backupEstablished) this.backupTail = null;
    }
  }

  async read() {
    await this.writeTail;
    const primary = await this.readGeneration(this.filePath);
    if (primary.value !== undefined) {
      await this.establishBackup(primary);
      return structuredClone(primary.value);
    }

    const backup = await this.readGeneration(this.backupPath);
    if (backup.value !== undefined) {
      if (primary.exists) {
        const quarantined = await this.quarantine(this.filePath);
        console.warn(`[TubePulse state] quarantined corrupt primary and recovered last-known-good state: ${quarantined}`);
      } else {
        console.warn(`[TubePulse state] primary state missing; recovered last-known-good state: ${this.filePath}`);
      }
      return await this.restoreBackup(backup);
    }

    if (!primary.exists && !backup.exists) return structuredClone(this.initialValue);

    if (backup.exists) {
      const quarantined = await this.quarantine(this.backupPath);
      console.warn(`[TubePulse state] quarantined corrupt backup: ${quarantined}`);
    }
    const cause = primary.error || backup.error || new Error('no valid generation is available');
    throw new StateFileCorruptionError(this.filePath, new Error(describeParseError(cause)));
  }

  async write(value) {
    const serialized = `${JSON.stringify(this.validate(value), null, 2)}\n`;
    // Validate serialization before replacing either durable generation.
    this.parse(serialized);
    const operation = async () => {
      await this.backupTail;
      await this.persistGeneration(this.filePath, serialized);
      // A write is not complete until both durable generations contain the
      // new state. Callers may perform external effects only after this
      // promise resolves (notably the at-most-once FCM claim path).
      await this.persistGeneration(this.backupPath, serialized);
      this.backupEstablished = true;
    };
    const pending = this.writeTail.then(operation, operation);
    this.writeTail = pending.catch(() => {});
    return await pending;
  }
}

export function createRuntimeStateFile(dataDir) {
  return new JsonStateFile(path.join(dataDir, 'runtime-state.json'), {
    schemaVersion: 1,
    mirrorRole: 'standby',
    roleChangedAt: null,
    roleChangeReason: null,
  });
}

export function createSyncStateFile(dataDir) {
  return new JsonStateFile(path.join(dataDir, 'sync-state.json'), {
    schemaVersion: 1,
    baseline: {},
    conflicts: {},
    lastPull: null,
    lastPush: null,
  });
}
