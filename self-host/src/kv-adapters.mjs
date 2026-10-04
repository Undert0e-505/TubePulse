import crypto from 'node:crypto';

export function contentHash(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function recordFromValue(value, expiration = undefined) {
  if (value === null || value === undefined) return null;
  return {
    value,
    hash: contentHash(value),
    ...(Number.isFinite(expiration) ? { expiration } : {}),
  };
}

export function recordSummary(record) {
  if (!record) return null;
  return {
    hash: record.hash,
    ...(Number.isFinite(record.expiration) ? { expiration: record.expiration } : {}),
  };
}

export function summariesEqual(left, right) {
  if (!left || !right) return left === right;
  return left.hash === right.hash && (left.expiration ?? null) === (right.expiration ?? null);
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function snapshotAdapter(adapter, { concurrency = 4, exclude = () => false } = {}) {
  const listed = await adapter.listKeys();
  const included = listed.filter((entry) => !exclude(entry.name));
  const records = await mapLimit(included, concurrency, async (entry) => {
    const value = await adapter.get(entry.name);
    return [entry.name, recordFromValue(value, entry.expiration)];
  });
  return {
    records: new Map(records.filter(([, record]) => record !== null)),
    excluded: listed.length - included.length,
  };
}

export class LocalKvAdapter {
  constructor(namespace) {
    this.namespace = namespace;
  }

  async listKeys() {
    const keys = [];
    let cursor;
    do {
      const page = await this.namespace.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
      keys.push(...page.keys.map(({ name, expiration }) => ({ name, expiration })));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return keys;
  }

  async get(key) {
    return await this.namespace.get(key, 'text');
  }

  async put(key, value, options = {}) {
    const expiration = options.expiration;
    const putOptions = Number.isFinite(expiration) && expiration > Math.floor(Date.now() / 1000)
      ? { expiration }
      : undefined;
    await this.namespace.put(key, value, putOptions);
  }

  async delete(key) {
    await this.namespace.delete(key);
  }
}

export class CloudflareKvError extends Error {
  constructor(message, { status, operation, retryable = false } = {}) {
    super(message);
    this.name = 'CloudflareKvError';
    this.status = status;
    this.operation = operation;
    this.retryable = retryable;
  }
}

function redact(text, secrets) {
  let result = String(text || '');
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
  return result.slice(0, 500);
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

export class CloudflareKvRestAdapter {
  constructor({ accountId, namespaceId, apiToken, fetchImpl = globalThis.fetch }) {
    if (!accountId || !namespaceId || !apiToken) throw new Error('Cloudflare KV adapter credentials are incomplete');
    this.accountId = accountId;
    this.namespaceId = namespaceId;
    this.apiToken = apiToken;
    this.fetchImpl = fetchImpl;
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}`;
  }

  async request(operation, relativePath, init = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${relativePath}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          ...(init.headers || {}),
        },
      });
    } catch (error) {
      throw new CloudflareKvError(`Cloudflare KV ${operation} network failure: ${redact(error.message, [this.apiToken])}`, {
        operation,
        retryable: true,
      });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new CloudflareKvError(
        `Cloudflare KV ${operation} failed with HTTP ${response.status}${body ? `: ${redact(body, [this.apiToken])}` : ''}`,
        { status: response.status, operation, retryable: isRetryableStatus(response.status) },
      );
    }
    return response;
  }

  async listKeys() {
    const keys = [];
    let cursor;
    do {
      const query = new URLSearchParams({ limit: '1000' });
      if (cursor) query.set('cursor', cursor);
      const response = await this.request('list', `/keys?${query}`);
      const payload = await response.json();
      if (!payload?.success || !Array.isArray(payload.result)) {
        throw new CloudflareKvError('Cloudflare KV list returned an invalid response', { operation: 'list' });
      }
      keys.push(...payload.result.map(({ name, expiration }) => ({ name, expiration })));
      cursor = payload.result_info?.cursor || undefined;
    } while (cursor);
    return keys;
  }

  async get(key) {
    const encoded = encodeURIComponent(key);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/values/${encoded}`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      });
    } catch (error) {
      throw new CloudflareKvError(`Cloudflare KV read network failure: ${redact(error.message, [this.apiToken])}`, {
        operation: 'read',
        retryable: true,
      });
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new CloudflareKvError(
        `Cloudflare KV read failed with HTTP ${response.status}${body ? `: ${redact(body, [this.apiToken])}` : ''}`,
        { status: response.status, operation: 'read', retryable: isRetryableStatus(response.status) },
      );
    }
    return await response.text();
  }

  async put(key, value, options = {}) {
    const query = new URLSearchParams();
    if (Number.isFinite(options.expiration)) query.set('expiration', String(options.expiration));
    const suffix = query.size ? `?${query}` : '';
    await this.request('write', `/values/${encodeURIComponent(key)}${suffix}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: value,
    });
  }

  async delete(key) {
    await this.request('delete', `/values/${encodeURIComponent(key)}`, { method: 'DELETE' });
  }
}
