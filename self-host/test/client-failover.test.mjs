import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEndpointPolicy,
  DEFAULT_TUBEPULSE_API_URL,
  FAILOVER_RETRYABLE_STATUSES,
  fetchWithEndpointFailover,
  normalizeApiBaseUrl,
} from '../../src/utils/apiEndpointPolicy.mjs';

function ok(body = '{}') {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('missing fallback preserves the exact historical endpoint and one request', async () => {
  const policy = createEndpointPolicy({ primaryUrl: '   ', fallbackUrl: '' });
  const calls = [];
  const response = await fetchWithEndpointFailover({
    policy,
    path: '/feed',
    init: { headers: { Authorization: 'Bearer device' } },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return ok(); },
  });
  assert.equal(response.status, 200);
  assert.equal(policy.primaryUrl, DEFAULT_TUBEPULSE_API_URL);
  assert.deepEqual(calls.map((entry) => entry.url), [`${DEFAULT_TUBEPULSE_API_URL}/feed`]);
  assert.equal(calls[0].init.headers.has('X-TubePulse-Failover'), false);
});

test('normalizes trailing slashes and suppresses a same-URL fallback', () => {
  assert.equal(normalizeApiBaseUrl(' https://example.com/api/// '), 'https://example.com/api');
  const policy = createEndpointPolicy({
    primaryUrl: 'https://example.com/',
    fallbackUrl: 'https://example.com////',
  });
  assert.equal(policy.fallbackUrl, '');
  assert.equal(policy.targets().length, 1);
});

test('HTTP 429 retries fallback once, marks it, and stays sticky', async () => {
  const policy = createEndpointPolicy({ primaryUrl: 'https://primary.test', fallbackUrl: 'https://fallback.test/' });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, marker: init.headers.get('X-TubePulse-Failover') });
    return url.startsWith('https://primary') ? new Response('limited', { status: 429 }) : ok();
  };
  assert.equal((await fetchWithEndpointFailover({ policy, path: '/feed', fetchImpl })).status, 200);
  assert.deepEqual(calls, [
    { url: 'https://primary.test/feed', marker: null },
    { url: 'https://fallback.test/feed', marker: '1' },
  ]);
  assert.equal(policy.isFallbackSticky, true);
  calls.length = 0;
  await fetchWithEndpointFailover({ policy, path: '/feed', fetchImpl });
  assert.deepEqual(calls, [{ url: 'https://fallback.test/feed', marker: '1' }]);
  policy.reset();
  assert.equal(policy.isFallbackSticky, false);
});

for (const status of [502, 503, 504]) {
  test(`HTTP ${status} is retryable`, async () => {
    const policy = createEndpointPolicy({ primaryUrl: 'https://primary.test', fallbackUrl: 'https://fallback.test' });
    let calls = 0;
    const result = await fetchWithEndpointFailover({
      policy,
      path: '/',
      fetchImpl: async () => (++calls === 1 ? new Response('', { status }) : ok()),
    });
    assert.equal(result.status, 200);
    assert.equal(calls, 2);
  });
}

test('network failure retries fallback but only once', async () => {
  const policy = createEndpointPolicy({ primaryUrl: 'https://primary.test', fallbackUrl: 'https://fallback.test' });
  let calls = 0;
  const result = await fetchWithEndpointFailover({
    policy,
    path: '/',
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw new TypeError('offline');
      return ok();
    },
  });
  assert.equal(result.status, 200);
  assert.equal(calls, 2);

  await assert.rejects(
    fetchWithEndpointFailover({
      policy: createEndpointPolicy({ primaryUrl: 'https://p.test', fallbackUrl: 'https://f.test' }),
      path: '/',
      fetchImpl: async () => { throw new TypeError('offline'); },
    }),
    /offline/,
  );
});

for (const status of [400, 401]) {
  test(`HTTP ${status} does not fail over`, async () => {
    const policy = createEndpointPolicy({ primaryUrl: 'https://primary.test', fallbackUrl: 'https://fallback.test' });
    let calls = 0;
    const result = await fetchWithEndpointFailover({
      policy,
      path: '/',
      fetchImpl: async () => { calls++; return new Response('', { status }); },
    });
    assert.equal(result.status, status);
    assert.equal(calls, 1);
  });
}

test('retry status allowlist is intentionally narrow', () => {
  assert.deepEqual(FAILOVER_RETRYABLE_STATUSES, [429, 502, 503, 504]);
});
