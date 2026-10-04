import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudflareKvError, CloudflareKvRestAdapter } from '../src/kv-adapters.mjs';

const credentials = {
  accountId: 'account-id',
  namespaceId: 'namespace-id',
  apiToken: 'super-secret-token',
};

test('Cloudflare key listing follows cursors and keeps expiration metadata', async () => {
  const urls = [];
  const adapter = new CloudflareKvRestAdapter({
    ...credentials,
    fetchImpl: async (url, init) => {
      urls.push({ url, auth: init.headers.Authorization });
      const second = url.includes('cursor=next-page');
      return Response.json({
        success: true,
        result: second ? [{ name: 'b' }] : [{ name: 'a', expiration: 2_000_000_000 }],
        result_info: { cursor: second ? '' : 'next-page' },
      });
    },
  });
  assert.deepEqual(await adapter.listKeys(), [
    { name: 'a', expiration: 2_000_000_000 },
    { name: 'b', expiration: undefined },
  ]);
  assert.equal(urls.length, 2);
  assert.match(urls[1].url, /cursor=next-page/);
  assert.equal(urls[0].auth, 'Bearer super-secret-token');
});

test('Cloudflare reads treat 404 as absent and encode key paths', async () => {
  let requestedUrl;
  const adapter = new CloudflareKvRestAdapter({
    ...credentials,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return new Response('', { status: 404 });
    },
  });
  assert.equal(await adapter.get('channel:a/b:meta'), null);
  assert.match(requestedUrl, /channel%3Aa%2Fb%3Ameta$/);
});

test('HTTP 429 becomes a typed retryable error without leaking the token', async () => {
  const adapter = new CloudflareKvRestAdapter({
    ...credentials,
    fetchImpl: async () => new Response(`rate limited ${credentials.apiToken}`, { status: 429 }),
  });
  await assert.rejects(
    adapter.put('key', 'value'),
    (error) => {
      assert.ok(error instanceof CloudflareKvError);
      assert.equal(error.status, 429);
      assert.equal(error.retryable, true);
      assert.equal(error.message.includes(credentials.apiToken), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test('network failures are retryable and redact token-shaped error text', async () => {
  const adapter = new CloudflareKvRestAdapter({
    ...credentials,
    fetchImpl: async () => { throw new Error(`socket closed ${credentials.apiToken}`); },
  });
  await assert.rejects(
    adapter.delete('key'),
    (error) => error.retryable === true && !error.message.includes(credentials.apiToken),
  );
});
