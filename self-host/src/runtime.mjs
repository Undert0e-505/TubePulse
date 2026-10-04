import fs from 'node:fs/promises';
import path from 'node:path';
import { Log, LogLevel, Miniflare } from 'miniflare';

const WORKERS = Object.freeze([
  { name: 'api', directory: 'tubepulse-api', scheduled: false },
  { name: 'rss-0', directory: 'tubepulse-rss-0', scheduled: true, bindings: { RSS_SHARD_INDEX: '0', RSS_MAX_SHARDS: '3' } },
  { name: 'rss-1', directory: 'tubepulse-rss-1', scheduled: true, bindings: { RSS_SHARD_INDEX: '1', RSS_MAX_SHARDS: '3' } },
  { name: 'rss-2', directory: 'tubepulse-rss-2', scheduled: true, bindings: { RSS_SHARD_INDEX: '2', RSS_MAX_SHARDS: '3' } },
  { name: 'posts', directory: 'tubepulse-posts', scheduled: true },
  { name: 'aux', directory: 'tubepulse-aux', scheduled: true },
]);

export class TubePulseRuntime {
  constructor(config) {
    this.config = config;
    this.miniflare = null;
    this.fetchers = new Map();
  }

  async start() {
    if (this.miniflare) return this;
    await fs.mkdir(this.config.dataDir, { recursive: true });
    const namespaceId = 'tubepulse-self-host-local';
    const workerRoot = path.join(this.config.repoRoot, 'worker');
    const workers = WORKERS.map((worker) => {
      const modulePaths = [path.join(workerRoot, worker.directory, 'index.js')];
      if (worker.name === 'api') {
        modulePaths.push(path.join(workerRoot, 'tubepulse-api', 'gateway.mjs'));
        modulePaths.push(path.join(workerRoot, 'tubepulse-api', 'authority.mjs'));
      }
      if (worker.scheduled) modulePaths.push(path.join(workerRoot, 'tubepulse-cron', 'shared.mjs'));
      if (worker.name === 'posts') modulePaths.push(path.join(workerRoot, 'tubepulse-posts', 'community-posts.mjs'));
      return {
        name: worker.name,
        // Define the small module graph explicitly. This preserves imports from
        // the existing source while giving workerd a common root, avoiding an
        // entrypoint-local sandbox that would reject ../tubepulse-cron imports.
        modulesRoot: workerRoot,
        modules: modulePaths.map((modulePath) => ({ type: 'ESModule', path: modulePath })),
        compatibilityDate: '2025-04-01',
        kvNamespaces: { TUBEPULSE_KV: namespaceId },
        bindings: { ...this.config.workerBindings, ...(worker.bindings || {}) },
      };
    });
    this.miniflare = new Miniflare({
      workers,
      host: '127.0.0.1',
      port: 0,
      kvPersist: path.join(this.config.dataDir, 'kv'),
      log: new Log(this.config.quiet ? LogLevel.NONE : LogLevel.INFO),
    });
    await this.miniflare.ready;
    for (const worker of WORKERS.filter((entry) => entry.scheduled)) {
      this.fetchers.set(worker.name, await this.miniflare.getWorker(worker.name));
    }
    return this;
  }

  async dispatchFetch(input, init) {
    if (!this.miniflare) throw new Error('Runtime has not started');
    return await this.miniflare.dispatchFetch(input, init);
  }

  async dispatchScheduled(name, scheduledTime, cron) {
    const fetcher = this.fetchers.get(name);
    if (!fetcher) throw new Error(`Unknown scheduled worker: ${name}`);
    const result = await fetcher.scheduled({ scheduledTime, cron });
    if (result?.outcome && result.outcome !== 'ok') {
      throw new Error(`${name} returned workerd outcome ${result.outcome}`);
    }
    return result;
  }

  async getLocalNamespace() {
    if (!this.miniflare) throw new Error('Runtime has not started');
    return await this.miniflare.getKVNamespace('TUBEPULSE_KV', 'api');
  }

  async close() {
    this.fetchers.clear();
    if (this.miniflare) await this.miniflare.dispose();
    this.miniflare = null;
  }
}

export const SCHEDULED_WORKERS = WORKERS.filter((worker) => worker.scheduled).map((worker) => worker.name);
