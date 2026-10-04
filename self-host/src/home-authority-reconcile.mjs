import {
  authorityManifest,
  installAuthoritySnapshot,
  isAuthorityCanonicalKey,
} from './home-authority.mjs';

function canonicalBaseline(records) {
  return Object.fromEntries(records.map(({ key, hash, expiration }) => [key, {
    hash,
    ...(Number.isFinite(expiration) ? { expiration } : {}),
  }]));
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

    await client.activateCanonical({ ...manifest, leaseId: canonical.leaseId });
    try {
      await gate.reconcile({ manifestHash: manifest.hash, recordCount: manifest.recordCount });
    } catch (error) {
      await client.markStale('home-activation-failed').catch(() => {});
      throw error;
    }

    return {
      ok: true,
      recordCount: manifest.recordCount,
      canonicalReset: true,
      imported: pull.imported,
      updated: pull.updated,
      deleted: pull.deleted,
      unchanged: pull.unchanged,
    };
  } catch (error) {
    if (canonical?.leaseId) await client.releaseReconciliation(canonical.leaseId).catch(() => {});
    throw error;
  }
}

export async function ensureHomeAuthorityCurrent({ local, client, gate, syncStateFile, now = Date.now }) {
  const [localStatus, remoteStatus] = await Promise.all([gate.status(), client.status()]);
  const localCurrent = localStatus.replication?.status === 'current';
  const remoteCurrent = remoteStatus.replication?.status === 'current';
  if (localCurrent && remoteCurrent) {
    return { reconciled: false, localStatus, remoteStatus };
  }
  const result = await reconcileHomeAuthority({ local, client, gate, syncStateFile, now });
  return { reconciled: true, localStatus, remoteStatus, result };
}
