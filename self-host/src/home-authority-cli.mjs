#!/usr/bin/env node
import path from 'node:path';
import { loadDotEnv } from './config.mjs';
import { AuthorityClient } from './authority-client.mjs';
import {
  createHomeAuthorityStateFile,
  HomeAuthorityGate,
} from './home-authority.mjs';
import { reconcileHomeAuthority } from './home-authority-reconcile.mjs';
import { readHomeSchedulerConfig } from './home-scheduler-config.mjs';
import { createHomeSchedulerSyncStateFile, FileLease } from './home-scheduler.mjs';
import { LocalKvAdapter } from './kv-adapters.mjs';
import { TubePulseRuntime } from './runtime.mjs';
import { createUnifiedHomeAuthorityService } from './home-authority-service.mjs';

const explicitEnvFile = process.env.TUBEPULSE_HOME_SCHEDULER_ENV_FILE;
loadDotEnv(explicitEnvFile ? path.resolve(explicitEnvFile) : path.resolve('.env.authority'));

async function reconcile(config) {
  const lease = new FileLease({ dataDir: config.dataDir, ttlMs: config.leaseTtlMs });
  await lease.acquire();
  const runtime = new TubePulseRuntime({
    dataDir: config.dataDir, repoRoot: config.repoRoot,
    workerBindings: config.workerBindings, quiet: config.quiet,
  });
  const client = new AuthorityClient({
    baseUrl: config.authority.apiUrl, secret: config.authority.secret, timeoutMs: config.authority.timeoutMs,
  });
  try {
    await runtime.start();
    const local = new LocalKvAdapter(await runtime.getLocalNamespace());
    const gate = new HomeAuthorityGate({
      adapter: local,
      stateFile: createHomeAuthorityStateFile(config.dataDir),
      leaseTtlMs: config.leaseTtlMs,
    });
    await gate.initialize();
    console.log(JSON.stringify(await reconcileHomeAuthority({
      local,
      client,
      gate,
      syncStateFile: createHomeSchedulerSyncStateFile(config.dataDir),
    })));
  } finally {
    await runtime.close().catch(() => {});
    await lease.release().catch(() => {});
  }
}

async function main() {
  const [command = 'run'] = process.argv.slice(2);
  const config = readHomeSchedulerConfig();
  if (command === 'reconcile') return await reconcile(config);
  if (command !== 'run') throw new Error('Usage: node src/home-authority-cli.mjs run|reconcile');
  const service = await createUnifiedHomeAuthorityService(config);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
  };
  process.once('SIGINT', () => close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => close().finally(() => process.exit(0)));
  console.log(JSON.stringify({
    message: 'TubePulse unified Home authority started',
    mode: config.mode,
    port: config.authority.port,
    periodicCanonicalPull: false,
  }));
}

main().catch((error) => {
  console.error(`TubePulse Home authority error: ${error.message}`);
  process.exitCode = 1;
});
