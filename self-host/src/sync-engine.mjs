import { isSyncExcluded } from './exclusions.mjs';
import {
  CloudflareKvError,
  recordFromValue,
  recordSummary,
  snapshotAdapter,
  summariesEqual,
} from './kv-adapters.mjs';

function parsedProfile(value) {
  try {
    const profile = JSON.parse(value);
    if (!profile || Array.isArray(profile) || typeof profile !== 'object') return null;
    if (!Number.isFinite(Number(profile.lastSeenAt))) return null;
    return profile;
  } catch {
    return null;
  }
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

/**
 * A Cloudflare-first /register is replayed against Home. Both handlers may
 * refresh lastSeenAt independently, which creates different hashes even
 * though every durable profile field is identical. In gateway mirror mode it
 * is safe to select the canonical Cloudflare record only for that exact
 * shape. Any other difference remains a normal two-sided conflict.
 */
export function resolveCanonicalProfilePullConflict({ key, local, remote }) {
  if (!/^device:.+:profile$/.test(key) || !local?.value || !remote?.value) return null;
  const localProfile = parsedProfile(local.value);
  const remoteProfile = parsedProfile(remote.value);
  if (!localProfile || !remoteProfile) return null;
  delete localProfile.lastSeenAt;
  delete remoteProfile.lastSeenAt;
  return stableJson(localProfile) === stableJson(remoteProfile) ? 'remote' : null;
}

function parsedChannelMeta(value) {
  try {
    const meta = JSON.parse(value);
    if (!meta || Array.isArray(meta) || typeof meta !== 'object') return null;
    if (!Object.hasOwn(meta, 'addedAt')) return null;
    if (typeof meta.addedAt !== 'number' || !Number.isSafeInteger(meta.addedAt)) return null;
    if (meta.addedAt < 0 || !Number.isFinite(new Date(meta.addedAt).getTime())) return null;
    return meta;
  } catch {
    return null;
  }
}

/**
 * A first subscription can create the same previously absent channel metadata
 * independently in the canonical Worker and its signed Home replay. Both use
 * Date.now() for addedAt, so that one bookkeeping field can differ even when
 * the durable metadata is otherwise byte-for-schema equivalent. Select the
 * canonical Cloudflare record only for that exact channel metadata shape.
 */
export function resolveCanonicalChannelMetaPullConflict({ key, local, remote }) {
  if (!/^channel:[^:]+:meta$/.test(key) || !local?.value || !remote?.value) return null;
  const localMeta = parsedChannelMeta(local.value);
  const remoteMeta = parsedChannelMeta(remote.value);
  if (!localMeta || !remoteMeta) return null;
  delete localMeta.addedAt;
  delete remoteMeta.addedAt;
  return stableJson(localMeta) === stableJson(remoteMeta) ? 'remote' : null;
}

export function resolveCanonicalGatewayPullConflict(context) {
  return resolveCanonicalProfilePullConflict(context)
    || resolveCanonicalChannelMetaPullConflict(context);
}

function nowIso() {
  return new Date().toISOString();
}

function baselineRecord(state, key) {
  return state.baseline[key] ?? null;
}

function setBaseline(state, key, record) {
  if (record) state.baseline[key] = recordSummary(record);
  else delete state.baseline[key];
}

function setConflict(state, key, operation, baseline, local, remote) {
  state.conflicts[key] = {
    detectedAt: nowIso(),
    operation,
    baseline: baseline ? { ...baseline } : null,
    local: recordSummary(local),
    remote: recordSummary(remote),
  };
}

function clearConflict(state, key) {
  delete state.conflicts[key];
}

function unionKeys(...iterables) {
  const result = new Set();
  for (const iterable of iterables) for (const key of iterable) result.add(key);
  return [...result].sort();
}

async function putRecord(adapter, key, record) {
  await adapter.put(key, record.value, { expiration: record.expiration });
}

async function runLimited(items, limit, fn) {
  let index = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current]);
    }
  }));
  return results;
}

export class SyncEngine {
  constructor({
    local,
    remote,
    stateFile,
    concurrency = 4,
    exclude = isSyncExcluded,
    writeEnabled = false,
    resolvePullConflict = null,
  }) {
    this.local = local;
    this.remote = remote;
    this.stateFile = stateFile;
    this.concurrency = concurrency;
    this.exclude = exclude;
    this.writeEnabled = writeEnabled;
    this.resolvePullConflict = resolvePullConflict;
    this.running = null;
  }

  async status() {
    const state = await this.stateFile.read();
    const lastPush = state.lastPush
      ? {
          ...state.lastPush,
          failureCount: state.lastPush.failures?.length || 0,
          failures: undefined,
        }
      : null;
    return {
      lastPull: state.lastPull,
      lastPush,
      conflictCount: Object.keys(state.conflicts || {}).length,
      pendingCount: state.lastPush?.pending ?? state.lastPull?.pendingLocal ?? 0,
    };
  }

  async withLock(operation, fn) {
    if (this.running) throw new Error(`A sync operation is already running (${this.running})`);
    this.running = operation;
    try {
      return await fn();
    } finally {
      this.running = null;
    }
  }

  async pull() {
    return await this.withLock('pull', async () => {
      const state = await this.stateFile.read();
      state.baseline ||= {};
      state.conflicts ||= {};
      const [localSnapshot, remoteSnapshot] = await Promise.all([
        snapshotAdapter(this.local, { concurrency: this.concurrency, exclude: this.exclude }),
        snapshotAdapter(this.remote, { concurrency: this.concurrency, exclude: this.exclude }),
      ]);
      const summary = {
        at: nowIso(),
        imported: 0,
        updated: 0,
        deleted: 0,
        unchanged: 0,
        pendingLocal: 0,
        conflicts: 0,
        resolved: 0,
        excluded: localSnapshot.excluded + remoteSnapshot.excluded,
        status: 'ok',
      };
      const keys = unionKeys(
        Object.keys(state.baseline),
        localSnapshot.records.keys(),
        remoteSnapshot.records.keys(),
      ).filter((key) => !this.exclude(key));

      for (const key of keys) {
        const baseline = baselineRecord(state, key);
        const local = localSnapshot.records.get(key) ?? null;
        const remote = remoteSnapshot.records.get(key) ?? null;

        if (!baseline) {
          if (remote && !local) {
            await putRecord(this.local, key, remote);
            setBaseline(state, key, remote);
            clearConflict(state, key);
            summary.imported++;
          } else if (remote && local && summariesEqual(local, remote)) {
            setBaseline(state, key, remote);
            clearConflict(state, key);
            summary.unchanged++;
          } else if (remote && local) {
            const resolution = this.resolvePullConflict
              ? await this.resolvePullConflict({ key, baseline, local, remote })
              : null;
            if (resolution === 'remote') {
              await putRecord(this.local, key, remote);
              setBaseline(state, key, remote);
              clearConflict(state, key);
              summary.updated++;
              summary.resolved++;
            } else {
              setConflict(state, key, 'pull', baseline, local, remote);
              summary.conflicts++;
            }
          } else if (local) {
            summary.pendingLocal++;
          }
          continue;
        }

        const localChanged = !summariesEqual(local, baseline);
        const remoteChanged = !summariesEqual(remote, baseline);
        if (!localChanged && !remoteChanged) {
          clearConflict(state, key);
          summary.unchanged++;
        } else if (remoteChanged && !localChanged) {
          if (remote) {
            await putRecord(this.local, key, remote);
            summary.updated++;
          } else {
            await this.local.delete(key);
            summary.deleted++;
          }
          setBaseline(state, key, remote);
          clearConflict(state, key);
        } else if (!remoteChanged && localChanged) {
          summary.pendingLocal++;
        } else if (summariesEqual(local, remote)) {
          setBaseline(state, key, remote);
          clearConflict(state, key);
          summary.unchanged++;
        } else {
          const resolution = this.resolvePullConflict
            ? await this.resolvePullConflict({ key, baseline, local, remote })
            : null;
          if (resolution === 'remote') {
            if (remote) await putRecord(this.local, key, remote);
            else await this.local.delete(key);
            setBaseline(state, key, remote);
            clearConflict(state, key);
            summary.updated++;
            summary.resolved++;
          } else {
            setConflict(state, key, 'pull', baseline, local, remote);
            summary.conflicts++;
          }
        }
      }

      if (summary.conflicts > 0) summary.status = 'conflict';
      else if (summary.pendingLocal > 0) summary.status = 'pending';
      state.lastPull = summary;
      await this.stateFile.write(state);
      return summary;
    });
  }

  async push({ apply = false } = {}) {
    return await this.withLock('push', async () => {
      if (apply && !this.writeEnabled) {
        throw new Error('Cloudflare writes are disabled; set TUBEPULSE_CLOUDFLARE_WRITE_ENABLED=true to apply');
      }
      const state = await this.stateFile.read();
      state.baseline ||= {};
      state.conflicts ||= {};
      const localSnapshot = await snapshotAdapter(this.local, {
        concurrency: this.concurrency,
        exclude: this.exclude,
      });
      const keys = unionKeys(Object.keys(state.baseline), localSnapshot.records.keys())
        .filter((key) => !this.exclude(key));
      const dirty = keys.filter((key) => {
        const local = localSnapshot.records.get(key) ?? null;
        return !summariesEqual(local, baselineRecord(state, key));
      });
      // List once so current remote expiration is part of the same three-way
      // comparison as content. Reading `/values/:key` alone does not return TTL.
      const remoteMetadata = new Map(
        (dirty.length > 0 ? await this.remote.listKeys() : [])
          .filter((entry) => !this.exclude(entry.name))
          .map((entry) => [entry.name, entry]),
      );
      const summary = {
        at: nowIso(),
        dryRun: !apply,
        plannedPuts: 0,
        plannedDeletes: 0,
        appliedPuts: 0,
        appliedDeletes: 0,
        alreadySynchronized: 0,
        conflicts: 0,
        pending: 0,
        failures: [],
        excluded: localSnapshot.excluded,
        status: 'ok',
      };

      const checks = await runLimited(dirty, this.concurrency, async (key) => {
        const local = localSnapshot.records.get(key) ?? null;
        const baseline = baselineRecord(state, key);
        const remoteValue = await this.remote.get(key);
        const remote = recordFromValue(remoteValue, remoteMetadata.get(key)?.expiration);
        return { key, local, baseline, remote };
      });

      const plans = [];
      for (const check of checks) {
        const { key, local, baseline, remote } = check;
        if (summariesEqual(remote, baseline)) {
          const operation = local ? 'put' : 'delete';
          plans.push({ ...check, operation });
          if (local) summary.plannedPuts++;
          else summary.plannedDeletes++;
          if (!apply) summary.pending++;
          clearConflict(state, key);
        } else if (summariesEqual(remote, local)) {
          setBaseline(state, key, local);
          clearConflict(state, key);
          summary.alreadySynchronized++;
        } else {
          setConflict(state, key, 'push', baseline, local, remote);
          summary.conflicts++;
          summary.pending++;
        }
      }

      if (apply) {
        const results = await runLimited(plans, this.concurrency, async (plan) => {
          try {
            if (plan.operation === 'put') await putRecord(this.remote, plan.key, plan.local);
            else await this.remote.delete(plan.key);
            return { plan, ok: true };
          } catch (error) {
            return { plan, ok: false, error };
          }
        });
        for (const result of results) {
          if (result.ok) {
            setBaseline(state, result.plan.key, result.plan.local);
            clearConflict(state, result.plan.key);
            if (result.plan.operation === 'put') summary.appliedPuts++;
            else summary.appliedDeletes++;
          } else {
            summary.pending++;
            summary.failures.push({
              key: result.plan.key,
              retryable: result.error instanceof CloudflareKvError ? result.error.retryable : false,
              status: result.error?.status,
              message: result.error?.message || 'Unknown synchronization failure',
            });
          }
        }
      }

      if (summary.failures.length > 0) summary.status = 'partial';
      else if (summary.conflicts > 0) summary.status = 'conflict';
      state.lastPush = summary;
      await this.stateFile.write(state);
      return summary;
    });
  }
}
