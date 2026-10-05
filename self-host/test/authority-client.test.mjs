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

test('RSS probe client uses the dedicated signed read-only route', async () => {
  const calls = [];
  const client = new AuthorityClient({
    baseUrl: 'https://api.example.test', secret: SECRET,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true, outcome: 'success', probes: [] });
    },
  });
  const channelId = 'UC0000000000000000000000';
  const result = await client.probeRss(channelId);
  assert.equal(result.outcome, 'success');
  assert.equal(new URL(calls[0].url).pathname, authorityClientRoutes.rssProbe.path);
  assert.equal(calls[0].init.headers['X-TubePulse-Authority-Operation'], 'authority-rss-probe');
  assert.deepEqual(JSON.parse(calls[0].init.body), { activeChannelId: channelId });
  assert.equal(JSON.stringify(calls).includes(SECRET), false);
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

test('publication acquisition retries a transient coordinator lease conflict', async () => {
  let calls = 0;
  const waits = [];
  const client = new AuthorityClient({
    baseUrl: 'https://api.example.test', secret: SECRET,
    sleep: async (ms) => { waits.push(ms); },
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return Response.json({ error: 'Authority lease busy' }, { status: 409 });
      return Response.json({ ok: true });
    },
  });
  const acquired = await client.acquirePublication();
  assert.match(acquired.leaseId, /^home-/);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [50]);
});

test('pending drain uses an API lease, flushes all pending, and releases it', async () => {
  const calls = [];
  let acquireAttempts = 0;
  const client = new AuthorityClient({
    baseUrl: 'https://api.example.test', secret: SECRET,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ path: new URL(url).pathname, body });
      if (new URL(url).pathname.endsWith('/acquire') && acquireAttempts++ === 0) {
        return Response.json({ error: 'Authority lease busy' }, { status: 409 });
      }
      return Response.json({ ok: true, pendingBackupKeys: 0 });
    },
  });
  await client.flushAllPending();
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.kind, 'api');
  assert.equal(calls[0].body.flushAllPending, true);
  assert.equal(calls[1].body.leaseId, calls[0].body.leaseId);
  assert.equal(calls[2].body.leaseId, calls[0].body.leaseId);
});

test('snapshot retries a transient active API lease with the same reconciliation identity', async () => {
  const bodies = [];
  const client = new AuthorityClient({
    baseUrl: 'https://api.example.test', secret: SECRET, sleep: async () => {},
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (bodies.length === 1) return Response.json({ error: 'Authority lease busy' }, { status: 409 });
      return Response.json({ ok: true, manifestHash: 'a'.repeat(64), recordCount: 0 });
    },
  });
  const result = await client.snapshotCanonical({ includeValues: true });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].leaseId, bodies[1].leaseId);
  assert.equal(result.leaseId, bodies[0].leaseId);
});
