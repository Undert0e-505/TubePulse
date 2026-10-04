import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthorityClient, AuthorityClientError, authorityClientRoutes } from '../src/authority-client.mjs';

const SECRET = 'synthetic-authority-client-secret-more-than-32-characters';

test('authority client signs scoped requests without exposing its secret or accepting HTTP', async () => {
  const seen = [];
  const client = new AuthorityClient({
    baseUrl: 'https://api.example.test', secret: SECRET,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return Response.json({ ok: true, lease: {} });
    },
  });
  const acquired = await client.acquirePublication();
  assert.match(acquired.leaseId, /^home-/);
  assert.equal(seen[0].url, `https://api.example.test${authorityClientRoutes.acquire.path}`);
  assert.match(seen[0].init.headers['X-TubePulse-Authority-Signature'], /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(seen).includes(SECRET), false);
  assert.throws(() => new AuthorityClient({ baseUrl: 'http://api.example.test', secret: SECRET }), /HTTPS/);
});

test('reconciliation carries one leased identity through snapshot, activate, and release', async () => {
  const calls = [];
  const client = new AuthorityClient({
    baseUrl: 'https://api.example.test', secret: SECRET,
    fetchImpl: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : {};
      calls.push({ path: new URL(url).pathname, body });
      if (new URL(url).pathname.endsWith('/snapshot')) {
        return Response.json({ ok: true, leaseId: body.leaseId, manifestHash: 'a'.repeat(64), recordCount: 10 });
      }
      return Response.json({ ok: true });
    },
  });
  const snapshot = await client.snapshotCanonical({ includeValues: true });
  await client.activateCanonical({ hash: snapshot.manifestHash, recordCount: snapshot.recordCount, leaseId: snapshot.leaseId });
  assert.equal(calls[0].body.leaseId, calls[1].body.leaseId);
  assert.equal(calls[0].body.includeValues, true);
  assert.equal(calls[1].body.manifestHash, 'a'.repeat(64));
});

test('authority client classifies retryable coordinator failures without leaking response content', async () => {
  const client = new AuthorityClient({
    baseUrl: 'https://api.example.test', secret: SECRET,
    fetchImpl: async () => Response.json({ error: `do not echo ${SECRET}` }, { status: 503 }),
  });
  await assert.rejects(() => client.status(), (error) => {
    assert.ok(error instanceof AuthorityClientError);
    assert.equal(error.retryable, true);
    assert.equal(error.status, 503);
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
});
