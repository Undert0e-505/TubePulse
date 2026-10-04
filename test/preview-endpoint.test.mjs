import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TUBEPULSE_API_URL } from '../src/utils/apiEndpointPolicy.mjs';
import {
  PREVIEW_ORIGIN_STORAGE_KEY,
  createRuntimeEndpointResolver,
  normalizePreviewOrigin,
  testTubePulseHomeOrigin,
} from '../src/utils/previewEndpoint.mjs';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    calls: [],
    async getItem(key) { this.calls.push(['get', key]); return values.get(key) ?? null; },
    async setItem(key, value) { this.calls.push(['set', key, value]); values.set(key, value); },
    async removeItem(key) { this.calls.push(['remove', key]); values.delete(key); },
  };
}

test('preview URL validation normalizes safe HTTP LAN and HTTPS origins', () => {
  assert.equal(normalizePreviewOrigin('  http://192.168.7.216:8788/  '), 'http://192.168.7.216:8788');
  assert.equal(normalizePreviewOrigin('https://home.example.net/api///'), 'https://home.example.net/api');
  assert.throws(() => normalizePreviewOrigin('ftp://192.168.1.2'), /http:\/\/ or https:\/\//);
  assert.throws(() => normalizePreviewOrigin('http://example.net'), /Use HTTPS/);
  assert.throws(() => normalizePreviewOrigin('https://user:pass@example.net'), /credentials/);
  assert.throws(() => normalizePreviewOrigin('https://example.net/?token=x'), /query string/);
  assert.throws(() => normalizePreviewOrigin('https://example.net/#secret'), /fragment/);
});

test('preview selection persists and is restored by a fresh resolver', async () => {
  const storage = memoryStorage();
  const first = createRuntimeEndpointResolver({ preview: true, storage });
  assert.equal(await first.getPreviewOrigin(), null);
  assert.equal(await first.setPreviewOrigin('http://10.0.0.8:8788/'), 'http://10.0.0.8:8788');

  const second = createRuntimeEndpointResolver({ preview: true, storage });
  assert.equal(await second.getPreviewOrigin(), 'http://10.0.0.8:8788');
  assert.equal(storage.calls.some(([operation, key]) => operation === 'set' && key === PREVIEW_ORIGIN_STORAGE_KEY), true);
});

test('preview has no production fallback and switches endpoints immediately', async () => {
  const storage = memoryStorage();
  const resolver = createRuntimeEndpointResolver({
    preview: true,
    storage,
    productionPrimaryUrl: DEFAULT_TUBEPULSE_API_URL,
    productionFallbackUrl: 'https://standby.example.net',
  });
  await assert.rejects(() => resolver.endpointPolicy(), { code: 'PREVIEW_ENDPOINT_NOT_CONFIGURED' });

  await resolver.setPreviewOrigin('http://192.168.1.20:8788');
  assert.deepEqual((await resolver.endpointPolicy()).targets(), [
    { baseUrl: 'http://192.168.1.20:8788', fallback: false },
  ]);
  await resolver.setPreviewOrigin('https://tubepulse-home.example.net');
  assert.deepEqual((await resolver.endpointPolicy()).targets(), [
    { baseUrl: 'https://tubepulse-home.example.net', fallback: false },
  ]);
});

test('production retains its fixed endpoint/failover policy and never reads preview storage', async () => {
  const storage = {
    async getItem() { throw new Error('production must not read preview storage'); },
    async setItem() { throw new Error('production must not write preview storage'); },
  };
  const resolver = createRuntimeEndpointResolver({
    preview: false,
    storage,
    productionPrimaryUrl: '',
    productionFallbackUrl: 'https://standby.example.net/',
  });
  assert.equal(await resolver.getPreviewOrigin(), null);
  assert.deepEqual((await resolver.endpointPolicy()).targets(), [
    { baseUrl: DEFAULT_TUBEPULSE_API_URL, fallback: false },
    { baseUrl: 'https://standby.example.net', fallback: true },
  ]);
  await assert.rejects(() => resolver.setPreviewOrigin('https://home.example.net'), /unavailable/);
});

test('health probe uses only GET / and validates the TubePulse API identity', async () => {
  const calls = [];
  const success = await testTubePulseHomeOrigin('http://192.168.1.20:8788', {
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return {
        ok: true,
        status: 200,
        async json() { return { status: 'ok', worker: 'tubepulse-api', version: '3.0.0' }; },
      };
    },
  });
  assert.deepEqual(success, { ok: true, origin: 'http://192.168.1.20:8788', version: '3.0.0' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'http://192.168.1.20:8788/');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal('body' in calls[0][1], false);

  const incompatible = await testTubePulseHomeOrigin('https://example.net', {
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { status: 'ok' }; } }),
    retryDelaysMs: [],
  });
  assert.equal(incompatible.ok, false);
  assert.match(incompatible.error, /not a compatible TubePulse Home/);
});

test('health probe retries when the first LAN response body is transiently unreadable', async () => {
  const calls = [];
  const delays = [];
  const result = await testTubePulseHomeOrigin('http://192.168.7.216:8788', {
    fetchImpl: async () => {
      calls.push('fetch');
      if (calls.length === 1) {
        return {
          ok: true,
          status: 200,
          async json() { throw new TypeError('Network response body was lost'); },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() { return { status: 'ok', worker: 'tubepulse-api', version: '3.0.0' }; },
      };
    },
    retryDelaysMs: [25],
    sleep: async (ms) => { delays.push(ms); },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [25]);
});

test('health probe does not hide a non-retryable HTTP error', async () => {
  let calls = 0;
  const result = await testTubePulseHomeOrigin('http://192.168.7.216:8788', {
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 404 };
    },
    retryDelaysMs: [1],
    sleep: async () => {},
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 404/);
  assert.equal(calls, 1);
});
