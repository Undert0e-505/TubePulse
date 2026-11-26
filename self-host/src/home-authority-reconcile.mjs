import {
  authorityManifest,
  installAuthoritySnapshot,
  isAuthorityCanonicalKey,
} from './home-authority.mjs';
import {
  preserveLocalKvForensics,
  recordLocalKvIntegrity,
  scanLocalAuthorityIntegrity,
} from './local-kv-integrity.mjs';

function canonicalBaseline(records) {
  return Object.fromEntries(records.map(({ key, hash, expiration }) => [key, {
    hash,
    ...(Number.isFinite(expiration) ? { expiration } : {}),
  }]));
}

function affectedVideoChannels(pull) {
  const channelIds = new Set();
  for (const key of [
    ...(pull.importedKeys || []),
    ...(pull.updatedKeys || []),
    ...(pull.deletedKeys || []),
  ]) {
    const match = /^channel:([^:]+):(?:recent|known:videos)$/.exec(key);
    if (match) channelIds.add(match[1]);
  }
  return [...channelIds].sort();
}

async function writeCanonicalBaseline(syncStateFile, canonical, pull, now) {
  await syncStateFile.write({
    schemaVersion: 1,
    baseline: canonicalBaseline(canonical.records),
    conflicts: {},
    lastPull: {
      at: new Date(now()).toISOString(),
      status: 'ok',
      canonicalReset: true,
      imported: pull.imported,
      updated: pull.updated,
      deleted: pull.deleted,
      unchanged: pull.unchanged,
      conflicts: 0,
      pendingLocal: 0,
    },
    lastPush: null,
  });
}

export async function reconcileHomeAuthority({ local, client, gate, syncStateFile, now = Date.now }) {
  let canonical;
  try {
    canonical = await client.snapshotCanonical({ includeValues: true });
    const pull = await installAuthoritySnapshot(local, canonical);
    const manifest = await authorityManifest(local, { exclude: (name) => !isAuthorityCanonicalKey(name) });
    if (manifest.hash !== canonical.manifestHash || manifest.recordCount !== canonical.recordCount) {
      throw new Error('Home manifest does not match the leased canonical snapshot');
    }

    await writeCanonicalBaseline(syncStateFile, canonical, pull, now);

    await client.activateCanonical({ ...manifest, leaseId: canonical.leaseId });
    try {
      await gate.reconcile({ manifestHash: manifest.hash, recordCount: manifest.recordCount });
    } catch (error) {
      await client.markStale('home-activation-failed').catch(() => {});
      throw error;
    }

    const result = {
      ok: true,
      recordCount: manifest.recordCount,
      canonicalReset: true,
      imported: pull.imported,
      updated: pull.updated,
      deleted: pull.deleted,
      unchanged: pull.unchanged,
    };
    // Recovery routing needs exact internal channel identities, but the
    // operator CLI JSON must remain aggregate-only.
    Object.defineProperty(result, 'affectedChannelIds', {
      value: affectedVideoChannels(pull), enumerable: false,
    });
    return result;
  } catch (error) {
    if (canonical?.leaseId) await client.releaseReconciliation(canonical.leaseId).catch(() => {});
    throw error;
  }
}

export async function verifyAndRecoverHomeAuthority({
  local,
  client,
  gate,
  syncStateFile,
  integrityStateFile,
  dataDir,
  durableMirror = null,
  now = Date.now,
}) {
  let canonical;
  let forensic = null;
  let initialScan = null;
  let finalScan = null;
  let pull = { imported: 0, updated: 0, deleted: 0, unchanged: 0 };
  try {
    let remoteStatus = await client.status();
    if (Number(remoteStatus.pendingBackupKeys || 0) > 0) {
      await client.flushAllPending();
      remoteStatus = await client.status();
      if (Number(remoteStatus.pendingBackupKeys || 0) > 0) {
        throw new Error('Canonical backup queue did not drain before integrity verification');
      }
    }
    if (remoteStatus.transaction) throw new Error('Remote canonical transaction is pending');

    canonical = await client.snapshotCanonical({ includeValues: true, retryWindowMs: 30_000 });
    const expectedManifest = {
      manifestHash: canonical.manifestHash,
      recordCount: canonical.recordCount,
    };
    initialScan = await scanLocalAuthorityIntegrity(local, { dataDir, expectedManifest, now });
    if (initialScan.status !== 'passed') {
      await recordLocalKvIntegrity(integrityStateFile, initialScan);
      forensic = await preserveLocalKvForensics(dataDir, initialScan, { now });
      await gate.markStale('local-integrity-failed');
      pull = await installAuthoritySnapshot(local, canonical);
      finalScan = await scanLocalAuthorityIntegrity(local, { dataDir, expectedManifest, now });
      if (finalScan.status !== 'passed') {
        await recordLocalKvIntegrity(integrityStateFile, finalScan, {
          recoveryAttempted: true,
          recoverySucceeded: false,
          forensicPath: forensic.path,
        });
        throw new Error('Home integrity scan still fails after exact canonical repair');
      }
    } else {
      finalScan = initialScan;
      pull = {
        imported: 0,
        updated: 0,
        deleted: 0,
        unchanged: canonical.recordCount,
        importedKeys: [],
        updatedKeys: [],
        deletedKeys: [],
      };
    }

    await writeCanonicalBaseline(syncStateFile, canonical, pull, now);
    if (durableMirror) {
      await durableMirror.reconcile(canonical.records);
      const mirrorIntegrity = await durableMirror.validate(canonical.records);
      if (mirrorIntegrity.status !== 'passed') throw new Error('Durable local KV mirror verification failed');
      await durableMirror.cleanupOrphans();
    }
    await client.activateCanonical({ ...expectedManifest, leaseId: canonical.leaseId });
    canonical = null;
    try {
      await gate.reconcile({ manifestHash: finalScan.manifestHash, recordCount: finalScan.recordCount });
    } catch (error) {
      await client.markStale('home-integrity-activation-failed').catch(() => {});
      throw error;
    }
    await recordLocalKvIntegrity(integrityStateFile, finalScan, {
      recoveryAttempted: initialScan.status !== 'passed',
      recoverySucceeded: initialScan.status !== 'passed',
      forensicPath: forensic?.path || null,
    });
    const result = {
      ok: true,
      verified: true,
      repaired: initialScan.status !== 'passed',
      recordCount: finalScan.recordCount,
      blobCount: finalScan.blobCount,
      imported: pull.imported,
      updated: pull.updated,
      deleted: pull.deleted,
      unchanged: pull.unchanged,
      forensic: forensic ? {
        fileCount: forensic.fileCount,
        manifestHash: forensic.manifestHash,
      } : null,
    };
    Object.defineProperty(result, 'affectedChannelIds', {
      value: affectedVideoChannels(pull), enumerable: false,
    });
    return result;
  } catch (error) {
    if (canonical?.leaseId) await client.releaseReconciliation(canonical.leaseId).catch(() => {});
    if (initialScan && initialScan.status === 'passed' && !finalScan) {
      await recordLocalKvIntegrity(integrityStateFile, { ...initialScan, status: 'failed' }).catch(() => {});
    }
    throw error;
  }
}

export async function ensureHomeAuthorityCurrent({ local, client, gate, syncStateFile, now = Date.now }) {
  const [localStatus, initialRemoteStatus] = await Promise.all([gate.status(), client.status()]);
  let remoteStatus = initialRemoteStatus;
  const localCurrent = localStatus.replication?.status === 'current';
  const remoteCurrent = remoteStatus.replication?.status === 'current';
  if (localCurrent && remoteCurrent) {
    return { reconciled: false, localStatus, remoteStatus };
  }
  // A Home-primary API mutation can have a verified delta queued in the
  // coordinator when a scheduler publication loses a short lease race. A
  // reconciliation snapshot deliberately refuses to run over pending data,
  // so drain that exact journal through the coordinator before taking the
  // snapshot. This applies the verified delta; it never clears pending state.
  if (Number(remoteStatus.pendingBackupKeys || 0) > 0) {
    await client.flushAllPending();
    remoteStatus = await client.status();
    if (Number(remoteStatus.pendingBackupKeys || 0) > 0) {
      throw new Error('Canonical backup queue did not drain before reconciliation');
    }
  }
  const result = await reconcileHomeAuthority({ local, client, gate, syncStateFile, now });
  return { reconciled: true, localStatus, remoteStatus, result };
}
