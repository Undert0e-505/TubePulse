import fs from 'node:fs/promises';
import path from 'node:path';

export class JsonStateFile {
  constructor(filePath, initialValue) {
    this.filePath = filePath;
    this.initialValue = initialValue;
  }

  async read() {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return structuredClone(this.initialValue);
      throw new Error(`Unable to read state file ${this.filePath}: ${error.message}`);
    }
  }

  async write(value) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      await fs.rm(this.filePath, { force: true });
      await fs.rename(temporaryPath, this.filePath);
    }
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
