import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DurableNotificationIntentStore,
  ProductionNotificationCoordinator,
} from '../src/home-scheduler-notifications.mjs';

const barrierConfig = {
  gatewayConvergenceRequired: true,
  gatewayAdminUrl: 'http://host.docker.internal:8789/_tubepulse/admin/gateway/reconcile',
  gatewayAdminToken: 'admin-token',
  gatewayReconcileUrl: 'https://api.example.test/_tubepulse/gateway/reconcile',
  apiBaseUrl: 'https://api.example.test',
  timeoutMs: 1_000,
  retryCount: 2,
  retryBackoffMs: 1,
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function intent(overrides = {}) {
  return {
    kind: 'video',
    deviceId: 'synthetic-device',
    channelId: 'UC-synthetic',
    projectId: 'synthetic-project',
    fcmToken: 'synthetic-fcm',
    contentIds: ['video-new'],
    requireUnwatched: true,
    payload: { title: 'New video', data: { videoId: 'video-new' }, tag: 'video-video-new' },
    ...overrides,
  };
}

test('notification intent summary exposes only aggregate backlog and outcome counts', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-notification-summary-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new DurableNotificationIntentStore(directory);
  const [sending, failed, pending] = await store.stage([
    intent({ contentIds: ['video-sending'] }),
    intent({ contentIds: ['video-failed'] }),
    intent({ contentIds: ['video-pending'] }),
  ]);
  await store.claim(sending.id);
  await store.claim(failed.id);
  await store.sent(failed.id, { sent: false, deadToken: false });
  const summary = await store.summary();
  assert.deepEqual(summary, {
    pending: 1, sending: 1, sent: 0, resolved: 1,
    callbackPending: 1, failed: 1, deadToken: 0, suppressed: 0,
  });
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /synthetic-device|UC-synthetic|synthetic-fcm|video-/);
  assert.equal(pending.record.status, 'pending');
});

test('canonical reconciliation and production feed visibility precede exactly one FCM send', async () => {
  const events = [];
  const fetchImpl = async (url) => {
    if (url === barrierConfig.gatewayAdminUrl) {
      events.push('gateway-pull');
      return jsonResponse({
        ok: true,
        result: { status: 'ok', conflicts: 0, pendingLocal: 0 },
        receipt: { timestamp: 1, requestId: 'request', fingerprint: 'f'.repeat(64), signature: 's' },
      });
    }
    if (url === barrierConfig.gatewayReconcileUrl) {
      events.push('gateway-reconcile');
      return jsonResponse({ ok: true, state: 'current' });
    }
    if (url === `${barrierConfig.apiBaseUrl}/feed`) {
      events.push('production-feed');
      return jsonResponse({
        channels: [{
          channelId: 'UC-synthetic',
          videos: [{ videoId: 'video-new', unwatched: true }],
          posts: [],
        }],
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  let callbacks = 0;
  const notification = intent({ onResult: async () => { events.push('callback'); callbacks++; } });
  const coordinator = new ProductionNotificationCoordinator(barrierConfig, {
    fetchImpl,
    tokenProvider: async () => { events.push('token'); return 'access-token'; },
    sender: async () => { events.push('fcm'); return { sent: true, deadToken: false }; },
    sleep: async () => {},
  });
  const result = await coordinator.flush([notification, notification], {});
  assert.deepEqual(events, ['gateway-pull', 'gateway-reconcile', 'production-feed', 'token', 'fcm', 'callback']);
  assert.equal(result.sent, 1);
  assert.equal(result.deduplicated, 1);
  assert.equal(callbacks, 1);
});

test('canonical production API visibility can gate FCM without a canary gateway', async () => {
  const events = [];
  const coordinator = new ProductionNotificationCoordinator({
    ...barrierConfig,
    gatewayConvergenceRequired: false,
    gatewayAdminUrl: null,
    gatewayAdminToken: null,
    gatewayReconcileUrl: null,
  }, {
    fetchImpl: async (url) => {
      assert.equal(url, `${barrierConfig.apiBaseUrl}/feed`);
      events.push('production-feed');
      return jsonResponse({
        channels: [{
          channelId: 'UC-synthetic',
          videos: [{ videoId: 'video-new', unwatched: true }],
          posts: [],
        }],
      });
    },
    tokenProvider: async () => { events.push('token'); return 'access-token'; },
    sender: async () => { events.push('fcm'); return { sent: true, deadToken: false }; },
  });
  const result = await coordinator.flush([intent()], {});
  assert.deepEqual(events, ['production-feed', 'token', 'fcm']);
  assert.equal(result.sent, 1);
  assert.equal(result.convergenceAttempts, 0);
});

test('missing production feed visibility suppresses FCM after bounded retries', async () => {
  let feedReads = 0;
  let sends = 0;
  const coordinator = new ProductionNotificationCoordinator(barrierConfig, {
    fetchImpl: async (url) => {
      if (url === barrierConfig.gatewayAdminUrl) {
        return jsonResponse({
          ok: true,
          result: { status: 'ok', conflicts: 0, pendingLocal: 0 },
          receipt: { timestamp: 1, requestId: 'request', fingerprint: 'f'.repeat(64), signature: 's' },
        });
      }
      if (url === barrierConfig.gatewayReconcileUrl) return jsonResponse({ ok: true, state: 'current' });
      feedReads++;
      return jsonResponse({ channels: [{ channelId: 'UC-synthetic', videos: [], posts: [] }] });
    },
    tokenProvider: async () => 'access-token',
    sender: async () => { sends++; return { sent: true, deadToken: false }; },
    sleep: async () => {},
  });
  let callbacks = 0;
  const result = await coordinator.flush([intent({ onResult: async () => { callbacks++; } })], {});
  assert.equal(feedReads, 3);
  assert.equal(sends, 0);
  assert.equal(callbacks, 0);
  assert.equal(result.suppressed, 1);
  assert.equal(result.reason, 'feed-not-visible');
});

test('an invisible stale nag cannot block a separately visible new-video notification', async () => {
  const sentKinds = [];
  let videoCallbacks = 0;
  let nagCallbacks = 0;
  const coordinator = new ProductionNotificationCoordinator({
    ...barrierConfig,
    gatewayConvergenceRequired: false,
  }, {
    fetchImpl: async () => jsonResponse({
      channels: [{
        channelId: 'UC-synthetic',
        videos: [{ videoId: 'video-new', unwatched: true }],
        posts: [],
      }],
    }),
    tokenProvider: async () => 'access-token',
    sender: async (_token, _project, _fcm, payload) => {
      sentKinds.push(payload.data?.type || 'video');
      return { sent: true, deadToken: false };
    },
    sleep: async () => {},
  });
  const video = intent({ onResult: async () => { videoCallbacks++; } });
  const staleNag = intent({
    kind: 'nag',
    contentIds: ['video-aged-out'],
    dedupeVersion: '0:0',
    payload: { data: { type: 'nag' }, tag: 'tubepulse-nag-UC-synthetic' },
    onResult: async () => { nagCallbacks++; },
  });

  const first = await coordinator.flush([video, staleNag], {});
  assert.deepEqual(sentKinds, ['video']);
  assert.equal(first.sent, 1);
  assert.equal(first.suppressed, 1);
  assert.equal(first.barrier, 'partial');
  assert.equal(first.reason, 'feed-not-visible');
  assert.equal(first.visibilityBlocked, 1);
  assert.equal(videoCallbacks, 1);
  assert.equal(nagCallbacks, 0);

  await coordinator.flush([video, staleNag], {});
  assert.deepEqual(sentKinds, ['video'], 'the already-sent video intent must not be replayed');
  assert.equal(videoCallbacks, 1);
  assert.equal(nagCallbacks, 0);
});

test('a persisted visible video intent is retried once after restart and restores its callback state', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-pending-intent-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new DurableNotificationIntentStore(directory);
  await store.stage([intent()]);
  const values = new Map([
    ['device:synthetic-device:state:UC-synthetic', JSON.stringify({
      unwatched: ['video-new'], lastNagAt: null, nagCount: 0,
    })],
  ]);
  const kv = {
    get: async (name, type) => {
      const value = values.get(name);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    put: async (name, value) => { values.set(name, value); },
    delete: async (name) => { values.delete(name); },
    list: async () => ({ keys: [], list_complete: true }),
  };
  let sends = 0;
  const coordinator = new ProductionNotificationCoordinator({
    ...barrierConfig,
    gatewayConvergenceRequired: false,
  }, {
    intentStore: new DurableNotificationIntentStore(directory),
    fetchImpl: async () => jsonResponse({
      channels: [{
        channelId: 'UC-synthetic',
        videos: [{ videoId: 'video-new', unwatched: true }],
        posts: [],
      }],
    }),
    tokenProvider: async () => 'access-token',
    sender: async () => { sends++; return { sent: true, deadToken: false }; },
  });
  const workerEnv = { TUBEPULSE_KV: kv };
  const first = await coordinator.flush([], workerEnv);
  assert.equal(first.sent, 1);
  assert.equal(sends, 1);
  assert.equal(JSON.parse(values.get('device:synthetic-device:state:UC-synthetic')).lastNagAt > 0, true);

  const second = await coordinator.flush([], workerEnv);
  assert.equal(second.sent, 0);
  assert.equal(sends, 1, 'a persisted intent must not be sent again after its durable claim');
});

test('gateway reconciliation failure suppresses FCM before any feed request', async () => {
  let feedReads = 0;
  let sends = 0;
  const coordinator = new ProductionNotificationCoordinator(barrierConfig, {
    fetchImpl: async (url) => {
      if (url === barrierConfig.gatewayAdminUrl) return jsonResponse({ error: 'busy' }, 409);
      feedReads++;
      return jsonResponse({ channels: [] });
    },
    tokenProvider: async () => 'access-token',
    sender: async () => { sends++; return { sent: true, deadToken: false }; },
    sleep: async () => {},
  });
  const result = await coordinator.flush([intent()], {});
  assert.equal(feedReads, 0);
  assert.equal(sends, 0);
  assert.equal(result.suppressed, 1);
  assert.equal(result.reason, 'gateway-not-current');
});

test('active authority mode refuses FCM when public feed fell back to Cloudflare', async () => {
  let sends = 0;
  const coordinator = new ProductionNotificationCoordinator({
    ...barrierConfig,
    gatewayConvergenceRequired: false,
    requireHomeAuthorityRoute: true,
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      channels: [{ channelId: 'UC-synthetic', videos: [{ videoId: 'video-new', unwatched: true }], posts: [] }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-TubePulse-Authority-Route': 'cloudflare' },
    }),
    tokenProvider: async () => 'token',
    sender: async () => { sends++; return { sent: true, deadToken: false }; },
    sleep: async () => {},
  });
  const result = await coordinator.flush([intent()], {});
  assert.equal(sends, 0);
  assert.equal(result.reason, 'feed-not-visible');
  assert.equal(result.suppressed, 1);
});

test('durable sending claim prevents duplicate FCM and recovers callback watermarks for every notification kind', async (t) => {
  for (const [kind, overrides] of [
    ['video', {}],
    ['community-post', { contentIds: ['post:activity'], payload: { data: { type: 'post', notificationTag: 'post-activity' }, tag: 'post-activity' } }],
    ['nag', { dedupeVersion: '0:0', payload: { data: { type: 'batch' }, tag: 'tubepulse-nag-UC-synthetic' } }],
    ['prewarn', { dedupeVersion: 'prewarn:30', payload: { data: { type: 'prewarn', prewarnMinutes: '30' }, tag: 'video-video-new' } }],
  ]) {
    await t.test(kind, async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-intent-'));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const store = new DurableNotificationIntentStore(directory);
      const original = intent({ kind, ...overrides });
      const [staged] = await store.stage([original]);
      await store.claim(staged.id); // simulate crash after claim / ambiguous send

      let sends = 0;
      let callbacks = 0;
      const restarted = new ProductionNotificationCoordinator({
        ...barrierConfig, gatewayConvergenceRequired: false,
      }, {
        intentStore: new DurableNotificationIntentStore(directory),
        fetchImpl: async () => { throw new Error('visibility is unnecessary for an already claimed intent'); },
        tokenProvider: async () => 'token',
        sender: async () => { sends++; return { sent: true, deadToken: false }; },
      });
      const result = await restarted.flush([intent({
        kind, ...overrides, onResult: async (delivery) => {
          assert.equal(delivery.recovered, true);
          callbacks++;
        },
      })], {});
      assert.equal(sends, 0, 'an ambiguous external call must never be replayed');
      assert.equal(callbacks, 1, 'the deterministic watermark callback self-heals once');
      assert.equal(result.recovered, 1);
      await restarted.flush([intent({ kind, ...overrides, onResult: async () => { callbacks++; } })], {});
      assert.equal(sends, 0);
      assert.equal(callbacks, 1);
    });
  }
});

test('nag and prewarn dedupe versions distinguish legitimate future notifications', async () => {
  const events = [];
  const coordinator = new ProductionNotificationCoordinator({
    ...barrierConfig, gatewayConvergenceRequired: false,
  }, {
    fetchImpl: async () => jsonResponse({
      channels: [{ channelId: 'UC-synthetic', videos: [{ videoId: 'video-new', unwatched: true }], posts: [] }],
    }),
    tokenProvider: async () => 'token',
    sender: async (_token, _project, _fcm, payload) => {
      events.push(payload.data?.prewarnMinutes || payload.tag);
      return { sent: true, deadToken: false };
    },
  });
  await coordinator.flush([intent({ kind: 'nag', dedupeVersion: '0:0', payload: { tag: 'nag' } })], {});
  await coordinator.flush([intent({ kind: 'nag', dedupeVersion: '1:1', payload: { tag: 'nag' } })], {});
  await coordinator.flush([intent({ kind: 'prewarn', dedupeVersion: 'prewarn:30', payload: { data: { prewarnMinutes: '30' }, tag: 'video' } })], {});
  await coordinator.flush([intent({ kind: 'prewarn', dedupeVersion: 'prewarn:10', payload: { data: { prewarnMinutes: '10' }, tag: 'video' } })], {});
  assert.deepEqual(events, ['nag', 'nag', '30', '10']);
});
