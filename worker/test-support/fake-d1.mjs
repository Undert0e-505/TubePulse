function cloneRecords(records) {
  return new Map([...records].map(([key, value]) => [key, { ...value }]));
}

class FakeStatement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql.replace(/\s+/g, ' ').trim();
    this.bindings = bindings;
  }
  bind(...bindings) { return new FakeStatement(this.database, this.sql, bindings); }
  async first() { return await this.database.execute(this.sql, this.bindings, 'first'); }
  async all() { return { results: await this.database.execute(this.sql, this.bindings, 'all') }; }
  async run() { return await this.database.execute(this.sql, this.bindings, 'run'); }
}

export class FakeD1 {
  constructor() {
    this.backend = null;
    this.records = new Map();
    this.guards = new Map();
    this.lastBatchStatementCount = 0;
    this.statementCount = 0;
  }
  prepare(sql) { return new FakeStatement(this, sql); }
  async batch(statements) {
    this.lastBatchStatementCount = statements.length;
    const snapshot = {
      backend: this.backend ? { ...this.backend } : null,
      records: cloneRecords(this.records),
      guards: new Map(this.guards),
    };
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      return result;
    } catch (error) {
      this.backend = snapshot.backend;
      this.records = snapshot.records;
      this.guards = snapshot.guards;
      throw error;
    }
  }
  id(generation, key) { return `${generation}\0${key}`; }
  visible(record, now) { return record && (record.expiration == null || record.expiration > now); }
  async execute(sql, args, mode) {
    this.statementCount++;
    if (sql.startsWith('SELECT active_generation FROM canonical_backend')) {
      return this.backend ? { active_generation: this.backend.active_generation } : null;
    }
    if (sql.startsWith('SELECT value, metadata FROM canonical_records')) {
      const [generation, key, now] = args;
      const record = this.records.get(this.id(generation, key));
      return this.visible(record, now) ? { value: record.value, metadata: record.metadata } : null;
    }
    if (sql.startsWith('SELECT key, expiration, metadata FROM canonical_records')) {
      const withPrefix = sql.includes('key >= ?');
      const generation = args[0];
      const after = args[1];
      const prefix = withPrefix ? args[2] : '';
      const now = withPrefix ? args[4] : args[2];
      const limit = withPrefix ? args[5] : args[3];
      return [...this.records.values()]
        .filter((record) => record.generation === generation && record.key > after
          && record.key.startsWith(prefix) && this.visible(record, now))
        .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
        .slice(0, limit)
        .map(({ key, expiration, metadata }) => ({ key, expiration, metadata }));
    }
    if (sql.startsWith('SELECT key, value, expiration FROM canonical_records')) {
      const [generation, now] = args;
      return [...this.records.values()]
        .filter((record) => record.generation === generation && this.visible(record, now))
        .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
        .map(({ key, value, expiration }) => ({ key, value, expiration }));
    }
    if (sql.startsWith('SELECT key, content_hash AS hash FROM canonical_records')) {
      const [generation] = args;
      return [...this.records.values()]
        .filter((record) => record.generation === generation)
        .sort((left, right) => left.key.localeCompare(right.key))
        .map(({ key, content_hash }) => ({ key, hash: content_hash }));
    }
    if (sql.startsWith('INSERT INTO canonical_records') && sql.includes('FROM json_each(?) AS delta')) {
      const [generation, payload] = args;
      let changed = 0;
      for (const delta of JSON.parse(payload)) {
        if (delta.operation !== 'put') continue;
        this.records.set(this.id(generation, delta.key), {
          generation, key: delta.key, value: delta.value,
          expiration: delta.expiration, metadata: delta.metadata,
          content_hash: delta.nextHash,
        });
        changed++;
      }
      return { success: true, meta: { changes: changed } };
    }
    if (sql.startsWith('INSERT INTO canonical_records')) {
      const staged = args.length === 5;
      const [generation, key, value, expiration] = args;
      const metadata = staged ? null : args[4];
      const contentHash = staged ? args[4] : args[5];
      this.records.set(this.id(generation, key), {
        generation, key, value, expiration, metadata, content_hash: contentHash,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.startsWith('DELETE FROM canonical_records') && sql.includes('FROM json_each(?)')) {
      const [generation, payload] = args;
      let changed = 0;
      for (const delta of JSON.parse(payload)) {
        if (delta.operation === 'delete' && this.records.delete(this.id(generation, delta.key))) changed++;
      }
      return { success: true, meta: { changes: changed } };
    }
    if (sql.startsWith('DELETE FROM canonical_records WHERE generation = ? AND key = ?')) {
      const changed = this.records.delete(this.id(args[0], args[1])) ? 1 : 0;
      return { success: true, meta: { changes: changed } };
    }
    if (sql.startsWith('DELETE FROM canonical_records WHERE generation = ?')) {
      let changed = 0;
      for (const [id, record] of this.records) {
        if (record.generation === args[0]) { this.records.delete(id); changed++; }
      }
      return { success: true, meta: { changes: changed } };
    }
    if (sql.startsWith('INSERT INTO canonical_backend')) {
      this.backend = {
        active_generation: args[0], manifest_hash: args[1], record_count: args[2],
      };
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.startsWith('INSERT INTO canonical_write_guard')) {
      const [token, generation, now, , , , , payload] = args;
      let changed = 0;
      for (const delta of JSON.parse(payload)) {
        const record = this.records.get(this.id(generation, delta.key));
        const currentHash = this.visible(record, now) ? record.content_hash : null;
        const ok = delta.baseHash === null
          ? currentHash === null || currentHash === delta.nextHash
          : currentHash === delta.baseHash || currentHash === delta.nextHash;
        if (!ok) throw new Error('CHECK constraint failed: canonical_write_guard.ok');
        this.guards.set(`${token}:${delta.sequence}`, 1);
        changed++;
      }
      return { success: true, meta: { changes: changed } };
    }
    if (sql.startsWith('DELETE FROM canonical_write_guard')) {
      let changed = 0;
      for (const key of [...this.guards.keys()]) {
        if (key.startsWith(`${args[0]}:`)) { this.guards.delete(key); changed++; }
      }
      return { success: true, meta: { changes: changed } };
    }
    throw new Error(`Unsupported fake D1 SQL (${mode}): ${sql}`);
  }
}
