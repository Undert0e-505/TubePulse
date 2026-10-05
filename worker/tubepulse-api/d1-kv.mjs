const MAX_KEY_BYTES = 512;
export const D1_MAX_VALUE_BYTES = 1_900_000;

function bytes(value = '') {
  return new TextEncoder().encode(String(value));
}

function enabledBackend(env) {
  return String(env?.TUBEPULSE_CANONICAL_BACKEND || 'kv').trim().toLowerCase();
}

export function canonicalBackendIdentity(env) {
  const backend = enabledBackend(env);
  if (backend === 'kv') return { backend: 'kv', generation: 'kv-legacy-v1' };
  if (backend !== 'd1') throw new Error('invalid-canonical-backend');
  const generation = String(env?.TUBEPULSE_CANONICAL_BACKEND_GENERATION || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(generation)) throw new Error('invalid-canonical-generation');
  if (!env?.TUBEPULSE_D1 || typeof env.TUBEPULSE_D1.prepare !== 'function') {
    throw new Error('missing-canonical-d1-binding');
  }
  return { backend, generation };
}

function encodeCursor(value) {
  const binary = [...bytes(value)].map((value) => String.fromCharCode(value)).join('');
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(value) {
  if (!value) return '';
  try {
    const normalized = String(value).replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    throw new Error('invalid-d1-list-cursor');
  }
}

function normalizeKey(key) {
  const name = String(key || '');
  if (!name || bytes(name).byteLength > MAX_KEY_BYTES) throw new Error('invalid-d1-key');
  return name;
}

function expirationFromOptions(options = {}, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (options.expiration !== undefined) {
    const expiration = Number(options.expiration);
    if (!Number.isFinite(expiration) || expiration <= 0) throw new Error('invalid-d1-expiration');
    return Math.floor(expiration);
  }
  if (options.expirationTtl !== undefined) {
    const ttl = Number(options.expirationTtl);
    if (!Number.isFinite(ttl) || ttl < 60) throw new Error('invalid-d1-expiration-ttl');
    return nowSeconds + Math.floor(ttl);
  }
  return null;
}

function normalizeValue(value) {
  if (typeof value !== 'string') throw new Error('canonical-d1-values-must-be-strings');
  if (bytes(value).byteLength > D1_MAX_VALUE_BYTES) throw new Error('canonical-d1-value-too-large');
  return value;
}

function valueForType(value, type) {
  if (value === null || value === undefined) return null;
  const normalized = typeof type === 'object' ? type?.type : type;
  if (normalized === 'json') {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (normalized === 'arrayBuffer') return bytes(value).buffer;
  return value;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', bytes(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

function primary(db) {
  // Direct D1 bindings use the primary unless read replication is explicitly
  // enabled through Sessions. Keep the helper narrow so tests can supply a
  // binding without withSession().
  return db;
}

export class D1KvNamespace {
  constructor(database, generation, { now = Date.now } = {}) {
    if (!database || typeof database.prepare !== 'function') throw new Error('invalid-d1-binding');
    if (!/^[a-zA-Z0-9._-]{3,80}$/.test(String(generation || ''))) throw new Error('invalid-d1-generation');
    this.database = database;
    this.generation = generation;
    this.now = now;
  }

  async active() {
    const row = await primary(this.database).prepare(
      'SELECT active_generation FROM canonical_backend WHERE singleton = 1',
    ).first();
    return row?.active_generation === this.generation;
  }

  async assertActive() {
    if (!(await this.active())) throw new Error('canonical-d1-generation-inactive');
  }

  async getWithMetadata(key, type = 'text') {
    const name = normalizeKey(key);
    await this.assertActive();
    const row = await primary(this.database).prepare(
      `SELECT value, metadata FROM canonical_records
       WHERE generation = ? AND key = ? AND (expiration IS NULL OR expiration > ?)`,
    ).bind(this.generation, name, Math.floor(this.now() / 1000)).first();
    if (!row) return { value: null, metadata: null };
    let metadata = null;
    if (row.metadata != null) {
      try { metadata = JSON.parse(row.metadata); } catch { metadata = null; }
    }
    return { value: valueForType(row.value, type), metadata };
  }

  async get(key, type = 'text') {
    return (await this.getWithMetadata(key, type)).value;
  }

  async put(key, value, options = {}) {
    const name = normalizeKey(key);
    const text = normalizeValue(value);
    const expiration = expirationFromOptions(options, Math.floor(this.now() / 1000));
    const metadata = options.metadata === undefined ? null : JSON.stringify(options.metadata);
    await this.assertActive();
    const hash = await sha256(text);
    await primary(this.database).prepare(
      `INSERT INTO canonical_records
         (generation, key, value, expiration, metadata, content_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(generation, key) DO UPDATE SET
         value = excluded.value, expiration = excluded.expiration,
         metadata = excluded.metadata, content_hash = excluded.content_hash,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(this.generation, name, text, expiration, metadata, hash).run();
  }

  async delete(key) {
    const name = normalizeKey(key);
    await this.assertActive();
    await primary(this.database).prepare(
      'DELETE FROM canonical_records WHERE generation = ? AND key = ?',
    ).bind(this.generation, name).run();
  }

  async list(options = {}) {
    await this.assertActive();
    const limit = Math.max(1, Math.min(1000, Number(options.limit || 1000)));
    const prefix = String(options.prefix || '');
    const after = decodeCursor(options.cursor);
    const now = Math.floor(this.now() / 1000);
    const statement = prefix
      ? primary(this.database).prepare(
        `SELECT key, expiration, metadata FROM canonical_records
         WHERE generation = ? AND key > ? AND key >= ? AND key < ?
           AND (expiration IS NULL OR expiration > ?)
         ORDER BY key LIMIT ?`,
      ).bind(this.generation, after, prefix, `${prefix}\uffff`, now, limit + 1)
      : primary(this.database).prepare(
        `SELECT key, expiration, metadata FROM canonical_records
         WHERE generation = ? AND key > ? AND (expiration IS NULL OR expiration > ?)
         ORDER BY key LIMIT ?`,
      ).bind(this.generation, after, now, limit + 1);
    const payload = await statement.all();
    const rows = payload?.results || [];
    const visible = rows.slice(0, limit);
    const keys = visible.map((row) => {
      let metadata;
      try { metadata = row.metadata == null ? undefined : JSON.parse(row.metadata); } catch { metadata = undefined; }
      return {
        name: row.key,
        ...(row.expiration !== null && row.expiration !== undefined
          && Number.isFinite(Number(row.expiration)) ? { expiration: Number(row.expiration) } : {}),
        ...(metadata === undefined ? {} : { metadata }),
      };
    });
    const complete = rows.length <= limit;
    return {
      keys,
      list_complete: complete,
      ...(complete || !visible.length ? {} : { cursor: encodeCursor(visible.at(-1).key) }),
    };
  }

  async snapshotRecords() {
    await this.assertActive();
    const now = Math.floor(this.now() / 1000);
    const payload = await primary(this.database).prepare(
      `SELECT key, value, expiration FROM canonical_records
       WHERE generation = ? AND (expiration IS NULL OR expiration > ?)
       ORDER BY key`,
    ).bind(this.generation, now).all();
    return (payload?.results || [])
      .map(({ key, value, expiration }) => ({
        key,
        value,
        ...(expiration !== null && expiration !== undefined
          && Number.isFinite(Number(expiration)) ? { expiration: Number(expiration) } : {}),
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async stageRecords(records) {
    const statements = [];
    for (const record of records) {
      const key = normalizeKey(record.key);
      const value = normalizeValue(record.value);
      if (!/^[a-f0-9]{64}$/.test(String(record.hash || '')) || await sha256(value) !== record.hash) {
        throw new Error('invalid-d1-stage-record-hash');
      }
      const expiration = record.expiration === undefined ? null : expirationFromOptions({ expiration: record.expiration });
      statements.push(primary(this.database).prepare(
        `INSERT INTO canonical_records
           (generation, key, value, expiration, metadata, content_hash, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(generation, key) DO UPDATE SET
           value = excluded.value, expiration = excluded.expiration,
           metadata = NULL, content_hash = excluded.content_hash,
           updated_at = CURRENT_TIMESTAMP`,
      ).bind(this.generation, key, value, expiration, record.hash));
    }
    if (statements.length) await primary(this.database).batch(statements);
  }

  async clearStagedGeneration() {
    await primary(this.database).prepare(
      'DELETE FROM canonical_records WHERE generation = ?',
    ).bind(this.generation).run();
  }

  async stagedManifest() {
    const payload = await primary(this.database).prepare(
      'SELECT key, content_hash AS hash FROM canonical_records WHERE generation = ? ORDER BY key',
    ).bind(this.generation).all();
    // Home's established manifest contract sorts keys with localeCompare().
    // SQLite ORDER BY uses binary collation, which differs for mixed-case
    // channel IDs. Reapply the contract order before hashing so an exact D1
    // seed does not fail verification solely because of collation.
    const records = (payload?.results || [])
      .sort((left, right) => left.key.localeCompare(right.key));
    return {
      records,
      recordCount: records.length,
      manifestHash: await sha256(records.map(({ key, hash }) => `${key}\0${hash}\n`).join('')),
    };
  }

  async activate({ manifestHash, recordCount }) {
    await primary(this.database).prepare(
      `INSERT INTO canonical_backend
         (singleton, active_generation, manifest_hash, record_count, activated_at)
       VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(singleton) DO UPDATE SET
         active_generation = excluded.active_generation,
         manifest_hash = excluded.manifest_hash,
         record_count = excluded.record_count,
         activated_at = CURRENT_TIMESTAMP`,
    ).bind(this.generation, manifestHash, recordCount).run();
  }

  async applyConditionalBatch(deltas) {
    await this.assertActive();
    if (!deltas.length) return { logicalWrites: 0, estimatedRowsWritten: 0 };
    const token = crypto.randomUUID();
    const now = Math.floor(this.now() / 1000);
    const payload = JSON.stringify(deltas.map((delta, index) => {
      const key = normalizeKey(delta.key);
      if (delta.operation === 'put') normalizeValue(delta.value);
      return {
        sequence: index,
        operation: delta.operation,
        key,
        value: delta.operation === 'put' ? delta.value : null,
        expiration: delta.operation === 'put' ? expirationFromOptions(delta.options || {}, now) : null,
        metadata: delta.operation === 'put' && delta.options?.metadata !== undefined
          ? JSON.stringify(delta.options.metadata)
          : null,
        baseHash: delta.baseHash,
        nextHash: delta.nextHash,
      };
    }));
    // D1 Free permits only 50 queries per Worker invocation. Expressing the
    // complete logical delta set as one bound JSON value keeps every commit at
    // four queries regardless of key count while D1 batch() keeps it atomic.
    // A failed guard CHECK rolls back all mutations in the batch.
    const statements = [
      primary(this.database).prepare(
        `INSERT INTO canonical_write_guard(token, sequence, ok)
         SELECT ?, CAST(json_extract(delta.value, '$.sequence') AS INTEGER), CASE
           WHEN json_extract(delta.value, '$.baseHash') IS NULL THEN CASE WHEN EXISTS(
             SELECT 1 FROM canonical_records
             WHERE generation = ?
               AND key = json_extract(delta.value, '$.key')
               AND (expiration IS NULL OR expiration > ?)
           ) AND NOT EXISTS(
             SELECT 1 FROM canonical_records
             WHERE generation = ?
               AND key = json_extract(delta.value, '$.key')
               AND content_hash = json_extract(delta.value, '$.nextHash')
               AND (expiration IS NULL OR expiration > ?)
           ) THEN 0 ELSE 1 END
           ELSE CASE WHEN EXISTS(
             SELECT 1 FROM canonical_records
             WHERE generation = ?
               AND key = json_extract(delta.value, '$.key')
               AND content_hash IN (
                 json_extract(delta.value, '$.baseHash'),
                 json_extract(delta.value, '$.nextHash')
               )
               AND (expiration IS NULL OR expiration > ?)
           ) THEN 1 ELSE 0 END
         END
         FROM json_each(?) AS delta`,
      ).bind(token, this.generation, now, this.generation, now, this.generation, now, payload),
      primary(this.database).prepare(
        `DELETE FROM canonical_records
         WHERE generation = ? AND key IN (
           SELECT json_extract(value, '$.key') FROM json_each(?)
           WHERE json_extract(value, '$.operation') = 'delete'
         )`,
      ).bind(this.generation, payload),
      primary(this.database).prepare(
        `INSERT INTO canonical_records
           (generation, key, value, expiration, metadata, content_hash, updated_at)
         SELECT ?,
           json_extract(delta.value, '$.key'),
           json_extract(delta.value, '$.value'),
           json_extract(delta.value, '$.expiration'),
           json_extract(delta.value, '$.metadata'),
           json_extract(delta.value, '$.nextHash'),
           CURRENT_TIMESTAMP
         FROM json_each(?) AS delta
         WHERE json_extract(delta.value, '$.operation') = 'put'
         ON CONFLICT(generation, key) DO UPDATE SET
           value = excluded.value, expiration = excluded.expiration,
           metadata = excluded.metadata, content_hash = excluded.content_hash,
           updated_at = CURRENT_TIMESTAMP`,
      ).bind(this.generation, payload),
      primary(this.database).prepare(
        'DELETE FROM canonical_write_guard WHERE token = ?',
      ).bind(token),
    ];
    await primary(this.database).batch(statements);
    // One canonical row plus one guard insert and one guard delete per key.
    // The estimate deliberately charges the final guard cleanup per key even
    // though it is one SQL statement, keeping budget enforcement conservative.
    return { logicalWrites: deltas.length, estimatedRowsWritten: deltas.length * 3 };
  }
}

export function canonicalNamespace(env) {
  const identity = canonicalBackendIdentity(env);
  if (identity.backend === 'kv') {
    if (!env?.TUBEPULSE_KV) throw new Error('missing-canonical-kv-binding');
    return env.TUBEPULSE_KV;
  }
  return new D1KvNamespace(env.TUBEPULSE_D1, identity.generation);
}

export function withCanonicalNamespace(env) {
  return { ...env, TUBEPULSE_KV: canonicalNamespace(env) };
}

export const d1KvTestHelpers = Object.freeze({
  decodeCursor,
  encodeCursor,
  expirationFromOptions,
  normalizeValue,
  sha256,
});
