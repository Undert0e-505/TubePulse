#!/usr/bin/env node
import path from 'node:path';
import { loadDotEnv } from './config.mjs';
import { AuthorityClient } from './authority-client.mjs';
import {
  createHomeAuthorityStateFile,
  exportAuthoritySnapshot,
  HomeAuthorityGate,
  isAuthorityCanonicalKey,
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

async function status(config) {
  const client = new AuthorityClient({
    baseUrl: config.authority.apiUrl,
    secret: config.authority.secret,
    timeoutMs: config.authority.timeoutMs,
  });
  const remote = await client.status();
  console.log(JSON.stringify({
    ok: remote?.ok === true,
    replication: remote?.replication || null,
    lease: remote?.lease || null,
    transaction: remote?.transaction || null,
    pendingBackupKeys: Number(remote?.pendingBackupKeys || 0),
    backend: remote?.backend || null,
    quota: remote?.quota || null,
  }));
}

async function drainPending(config) {
  const client = new AuthorityClient({
    baseUrl: config.authority.apiUrl,
    secret: config.authority.secret,
    timeoutMs: config.authority.timeoutMs,
  });
  const before = await client.status();
  if (Number(before?.pendingBackupKeys || 0) > 0) await client.flushAllPending();
  const after = await client.status();
  if (Number(after?.pendingBackupKeys || 0) !== 0 || after?.transaction || after?.lease) {
    throw new Error('Canonical pending queue did not reach an idle state');
  }
  console.log(JSON.stringify({
    ok: true,
    pendingBefore: Number(before?.pendingBackupKeys || 0),
    pendingAfter: Number(after?.pendingBackupKeys || 0),
    backend: after?.backend?.selected || null,
    replication: after?.replication?.status || null,
  }));
}

async function migrateD1(config) {
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
    const localStatus = await gate.status();
    if (localStatus.replication?.status !== 'current') throw new Error('Home authority must be current before D1 migration');
    if (localStatus.transaction) throw new Error('Home authority has an incomplete local transaction');
    const snapshot = await exportAuthoritySnapshot(local, { exclude: (name) => !isAuthorityCanonicalKey(name) });
    // The gate manifest records the last full reconciliation and is not
    // rewritten for each successfully journaled canonical mutation. While
    // Home is quiesced, the current local keyspace is the authoritative
    // snapshot; D1 activation still requires an exact staged-manifest match.
    const leaseId = `backend-${crypto.randomUUID()}`;
    await client.beginBackendMigration({
      leaseId,
      manifestHash: snapshot.manifestHash,
      recordCount: snapshot.recordCount,
    });
    for (let offset = 0; offset < snapshot.records.length; offset += 40) {
      await client.appendBackendMigration({
        leaseId,
        offset,
        records: snapshot.records.slice(offset, offset + 40),
      });
    }
    const activated = await client.commitBackendMigration({ leaseId });
    await gate.reconcile({ manifestHash: snapshot.manifestHash, recordCount: snapshot.recordCount });
    console.log(JSON.stringify({
      ok: true,
      backend: activated.backend,
      backendGeneration: activated.backendGeneration,
      recordCount: snapshot.recordCount,
      totalBytes: snapshot.totalBytes,
      manifestVerified: activated.manifestHash === snapshot.manifestHash,
    }));
  } finally {
    await runtime.close().catch(() => {});
    await lease.release().catch(() => {});
  }
}

async function main() {
  const [command = 'run'] = process.argv.slice(2);
  const config = readHomeSchedulerConfig();
  if (command === 'status') return await status(config);
  if (command === 'drain-pending') return await drainPending(config);
  if (command === 'reconcile') return await reconcile(config);
  if (command === 'migrate-d1') return await migrateD1(config);
  if (command !== 'run') throw new Error('Usage: node src/home-authority-cli.mjs run|status|drain-pending|reconcile|migrate-d1');
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
