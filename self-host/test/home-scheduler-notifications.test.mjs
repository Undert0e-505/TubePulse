import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DurableNotificationIntentStore,
  ProductionNotificationCoordinator,
  notificationCoordinatorTestHelpers,
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
  let now = 100_000;
  const store = new DurableNotificationIntentStore(directory, { now: () => now });
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
    transientExpired: 0, overduePending: 0, oldestPendingAgeSeconds: 0,
    fcmAcceptedTotal: 0, fcmFailedTotal: 1,
    permanentInvalidTokenResponsesTotal: 0, uniqueDeadTokenCleanupsTotal: 0,
    invalidTokenMonitoringCutoverAt: '1970-01-01T00:01:40.000Z', invalidTokenEvents: [],
  });
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /synthetic-device|UC-synthetic|synthetic-fcm|video-/);
  assert.equal(pending.record.status, 'pending');

  now += 60_001;
  const overdue = await store.summary();
  assert.equal(overdue.pending, 1);
  assert.equal(overdue.overduePending, 1);
  assert.equal(overdue.oldestPendingAgeSeconds, 60.001);
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

test('durable notification intents preserve the local-render capability through FCM send', async () => {
  let sentArguments;
  const coordinator = new ProductionNotificationCoordinator({
    ...barrierConfig,
    gatewayConvergenceRequired: false,
    gatewayAdminUrl: null,
    gatewayAdminToken: null,
    gatewayReconcileUrl: null,
  }, {
    fetchImpl: async () => jsonResponse({
      channels: [{
        channelId: 'UC-synthetic',
        videos: [{ videoId: 'video-new', unwatched: true }],
        posts: [],
      }],
    }),
    tokenProvider: async () => 'access-token',
    sender: async (...args) => {
      sentArguments = args;
      return { sent: true, deadToken: false };
    },
  });

  const result = await coordinator.flush([intent({ notificationCapability: 'local-v1' })], {});
  assert.equal(result.sent, 1);
  assert.equal(sentArguments[4], 'local-v1');
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

test('nags bypass durable storage and an invisible attempt can be reconsidered later', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-transient-nag-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new DurableNotificationIntentStore(directory);
  const nag = intent({
    kind: 'nag',
    dedupeVersion: '0:0',
    payload: { data: { type: 'nag' }, tag: 'tubepulse-nag-UC-synthetic' },
  });
  assert.deepEqual(await store.stage([nag]), []);
  assert.equal((await store.summary()).pending, 0);

  let visible = false;
  let sends = 0;
  let callbacks = 0;
  const coordinator = new ProductionNotificationCoordinator({
    ...barrierConfig, gatewayConvergenceRequired: false,
  }, {
    intentStore: store,
    fetchImpl: async () => jsonResponse({
      channels: [{
        channelId: 'UC-synthetic',
        videos: visible ? [{ videoId: 'video-new', unwatched: true }] : [],
        posts: [],
      }],
    }),
    tokenProvider: async () => 'token',
    sender: async () => { sends++; return { sent: true, deadToken: false }; },
    sleep: async () => {},
  });

  const first = await coordinator.flush([{ ...nag, onResult: async () => { callbacks++; } }], {});
  assert.equal(first.sent, 0);
  assert.equal(first.reason, 'feed-not-visible');
  assert.equal(sends, 0);
  assert.equal(callbacks, 0);
  assert.equal((await store.summary()).pending, 0);

  visible = true;
  const second = await coordinator.flush([{ ...nag, onResult: async () => { callbacks++; } }], {});
  assert.equal(second.sent, 1);
  assert.equal(sends, 1);
  assert.equal(callbacks, 1);
  assert.equal((await store.summary()).pending, 0);
});

test('FCM outcome totals cover every coordinator path and survive idle cycles and restart', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-notification-totals-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new DurableNotificationIntentStore(directory);
  const coordinator = new ProductionNotificationCoordinator({
    ...barrierConfig, gatewayConvergenceRequired: false,
  }, {
    intentStore: store,
    fetchImpl: async () => jsonResponse({
      channels: [{
        channelId: 'UC-synthetic',
        videos: [
          { videoId: 'video-new', unwatched: true },
          { videoId: 'video-second', unwatched: true },
          { videoId: 'video-live', unwatched: true },
        ],
        posts: [{ activityId: 'activity', unwatched: true }],
      }],
    }),
    tokenProvider: async () => 'token',
    sender: async (_token, _project, _fcm, payload) => ({
      sent: payload.data?.type !== 'post',
      deadToken: false,
    }),
  });
  const intents = [
    intent({ payload: { title: 'Upload', data: { type: 'video' }, tag: 'upload' } }),
    intent({
      contentIds: ['video-new', 'video-second'], dedupeVersion: 'batch',
      payload: { title: 'Bundle', data: { type: 'batch' }, tag: 'bundle' },
    }),
    intent({
      kind: 'community-post', contentIds: ['post:activity'], dedupeVersion: 'post',
      payload: { title: 'Post', data: { type: 'post' }, tag: 'post' },
    }),
    intent({
      kind: 'prewarn', contentIds: ['video-live'], dedupeVersion: 'prewarn:30',
      payload: { title: 'Upcoming', data: { type: 'prewarn', prewarnMinutes: '30' }, tag: 'prewarn' },
    }),
    intent({
      contentIds: ['video-live'], dedupeVersion: 'live-now',
      payload: { title: 'Live now', data: { type: 'video', live: 'true' }, tag: 'live-now' },
    }),
    intent({
      kind: 'nag', dedupeVersion: 'nag:1',
      payload: { title: 'Reminder', data: { type: 'nag' }, tag: 'nag' },
    }),
  ];

  const delivery = await coordinator.flush(intents, {});
  assert.equal(delivery.sent, 5);
  assert.equal(delivery.failed, 1);
  assert.deepEqual(
    (({ fcmAcceptedTotal, fcmFailedTotal }) => ({ fcmAcceptedTotal, fcmFailedTotal }))(await store.summary()),
    { fcmAcceptedTotal: 5, fcmFailedTotal: 1 },
  );

  const idle = await coordinator.flush([], {});
  assert.equal(idle.sent, 0);
  assert.equal(idle.failed, 0);
  const restarted = new DurableNotificationIntentStore(directory);
  assert.deepEqual(
    (({ fcmAcceptedTotal, fcmFailedTotal }) => ({ fcmAcceptedTotal, fcmFailedTotal }))(await restarted.summary()),
    { fcmAcceptedTotal: 5, fcmFailedTotal: 1 },
  );
});

test('durable outcome counting is idempotent and callback recovery does not count again', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-notification-idempotent-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new DurableNotificationIntentStore(directory);
  const [entry] = await store.stage([intent()]);
  await store.claim(entry.id);
  await store.sent(entry.id, { sent: true, deadToken: false });
  await store.sent(entry.id, { sent: true, deadToken: false });
  assert.equal((await store.summary()).fcmAcceptedTotal, 1);

  const restarted = new ProductionNotificationCoordinator({
    ...barrierConfig, gatewayConvergenceRequired: false,
  }, {
    intentStore: new DurableNotificationIntentStore(directory),
    fetchImpl: async () => { throw new Error('no visibility check is needed for recovery'); },
    tokenProvider: async () => { throw new Error('no token is needed for recovery'); },
    sender: async () => { throw new Error('FCM must not be called during recovery'); },
  });
  const recovered = await restarted.flush([intent({ onResult: async () => {} })], {});
  assert.equal(recovered.recovered, 1);
  const summary = await restarted.intentStore.summary();
  assert.equal(summary.fcmAcceptedTotal, 1);
  assert.equal(summary.fcmFailedTotal, 0);
});

test('dead-token cleanup callback recovers after failure without recounting the FCM outcome', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-dead-token-callback-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let sends = 0;
  const createCoordinator = () => new ProductionNotificationCoordinator({
    ...barrierConfig, gatewayConvergenceRequired: false,
  }, {
    intentStore: new DurableNotificationIntentStore(directory),
    fetchImpl: async () => jsonResponse({
      channels: [{ channelId: 'UC-synthetic', videos: [{ videoId: 'video-new', unwatched: true }], posts: [] }],
    }),
    tokenProvider: async () => 'token',
    sender: async () => {
      sends++;
      return { sent: false, deadToken: true, permanentInvalidTokenClass: 'unregistered' };
    },
  });

  const first = createCoordinator();
  const failedCallback = await first.flush([intent({
    onResult: async () => { throw new Error('synthetic cleanup interruption'); },
  })], {});
  assert.equal(failedCallback.callbackFailures, 1);
  assert.equal(sends, 1);
  let summary = await first.intentStore.summary();
  assert.equal(summary.callbackPending, 1);
  assert.equal(summary.permanentInvalidTokenResponsesTotal, 1);
  assert.equal(summary.uniqueDeadTokenCleanupsTotal, 1);

  let recoveredDelivery = null;
  const restarted = createCoordinator();
  const recovered = await restarted.flush([intent({
    onResult: async (delivery) => { recoveredDelivery = delivery; },
  })], {});
  assert.equal(recovered.recovered, 1);
  assert.equal(sends, 1, 'callback recovery must never make a second FCM attempt');
  assert.deepEqual(recoveredDelivery, { sent: false, deadToken: true, recovered: true });
  summary = await restarted.intentStore.summary();
  assert.equal(summary.callbackPending, 0);
  assert.equal(summary.permanentInvalidTokenResponsesTotal, 1);
  assert.equal(summary.uniqueDeadTokenCleanupsTotal, 1);
});

test('permanent invalid-token responses count raw attempts and unique token lifecycles durably', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-invalid-token-totals-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-10-10T18:01:00Z');
  const store = new DurableNotificationIntentStore(directory, { now: () => now });
  const permanent = {
    sent: false,
    deadToken: true,
    permanentInvalidTokenClass: 'unregistered',
  };
  const staged = await store.stage([
    intent({ contentIds: ['video-one'] }),
    intent({ contentIds: ['video-two'] }),
  ]);
  for (const entry of staged) {
    await store.claim(entry.id);
    await store.sent(entry.id, permanent);
  }
  // Re-applying a durable result is callback/restart recovery, not another
  // FCM attempt, so neither raw nor unique totals may move.
  await store.sent(staged[0].id, permanent);

  let summary = await store.summary();
  assert.equal(summary.fcmFailedTotal, 2);
  assert.equal(summary.permanentInvalidTokenResponsesTotal, 2);
  assert.equal(summary.uniqueDeadTokenCleanupsTotal, 1);
  assert.deepEqual(summary.invalidTokenEvents, [{
    bucket: '2026-10-10T18:00:00.000Z',
    permanentResponses: 2,
    uniqueCleanups: 1,
  }]);
  assert.equal(summary.invalidTokenMonitoringCutoverAt, '2026-10-10T18:01:00.000Z');
  assert.doesNotMatch(JSON.stringify(summary), /synthetic-fcm|[a-f0-9]{64}/);

  // Restart plus another transient intent for the same token is another raw
  // FCM response but still the same cleaned token lifecycle.
  now = Date.parse('2026-10-10T18:06:00Z');
  const restarted = new DurableNotificationIntentStore(directory, { now: () => now });
  await restarted.recordTransientOutcome(permanent, intent({ kind: 'nag' }));
  summary = await restarted.summary();
  assert.equal(summary.permanentInvalidTokenResponsesTotal, 3);
  assert.equal(summary.uniqueDeadTokenCleanupsTotal, 1);

  // A replacement registration token is a new lifecycle even on the same
  // device and can later generate its own unique cleanup event.
  await restarted.recordTransientOutcome(
    { ...permanent, permanentInvalidTokenClass: 'http-404' },
    intent({ kind: 'nag', fcmToken: 'replacement-fcm' }),
  );
  summary = await restarted.summary();
  assert.equal(summary.permanentInvalidTokenResponsesTotal, 4);
  assert.equal(summary.uniqueDeadTokenCleanupsTotal, 2);
  assert.deepEqual(summary.invalidTokenEvents.at(-1), {
    bucket: '2026-10-10T18:05:00.000Z',
    permanentResponses: 2,
    uniqueCleanups: 1,
  });
});

test('invalid-token metrics exclude ordinary failures and age graph buckets without losing totals', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-invalid-token-aging-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-10-10T10:01:00Z');
  const store = new DurableNotificationIntentStore(directory, { now: () => now });
  await store.recordTransientOutcome({ sent: false, deadToken: false }, intent({ kind: 'nag' }));
  await store.recordTransientOutcome({ sent: false, deadToken: true }, intent({ kind: 'nag' }));
  await store.recordTransientOutcome({
    sent: false, deadToken: true, permanentInvalidTokenClass: 'permission-denied',
  }, intent({ kind: 'nag' }));
  let summary = await store.summary();
  assert.equal(summary.fcmFailedTotal, 3);
  assert.equal(summary.permanentInvalidTokenResponsesTotal, 0);
  assert.equal(summary.uniqueDeadTokenCleanupsTotal, 0);

  await store.recordTransientOutcome({
    sent: false, deadToken: true, permanentInvalidTokenClass: 'not-registered',
  }, intent({ kind: 'nag' }));
  assert.equal((await store.summary()).invalidTokenEvents.length, 1);
  now += 49 * 60 * 60 * 1000;
  await store.recordTransientOutcome({ sent: true, deadToken: false }, intent({ kind: 'nag' }));
  summary = await store.summary();
  assert.equal(summary.invalidTokenEvents.length, 0);
  assert.equal(summary.permanentInvalidTokenResponsesTotal, 1);
  assert.equal(summary.uniqueDeadTokenCleanupsTotal, 1);
});

test('malformed invalid-token observability state cannot block delivery accounting or cleanup callback work', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-invalid-token-best-effort-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new DurableNotificationIntentStore(directory, { now: () => Date.parse('2026-10-10T18:01:00Z') });
  await store.stateFile.write({
    schemaVersion: 3,
    records: {},
    deliveryMetrics: { fcmAcceptedTotal: 0, fcmFailedTotal: 0 },
    invalidTokenMetrics: 'malformed-observability-only-state',
  });
  await assert.doesNotReject(store.recordTransientOutcome({
    sent: false, deadToken: true, permanentInvalidTokenClass: 'unregistered',
  }, intent({ kind: 'nag' })));
  const summary = await store.summary();
  assert.equal(summary.fcmFailedTotal, 1, 'authoritative FCM outcome accounting remains available');
  assert.equal(summary.permanentInvalidTokenResponsesTotal, 1, 'malformed optional monitoring is repaired safely');
  assert.equal(summary.uniqueDeadTokenCleanupsTotal, 1);
});

test('a transient nag on the fallback route is discarded without a durable record', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-route-nag-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new DurableNotificationIntentStore(directory);
  let sends = 0;
  let callbacks = 0;
  const coordinator = new ProductionNotificationCoordinator({
    ...barrierConfig,
    gatewayConvergenceRequired: false,
    requireHomeAuthorityRoute: true,
  }, {
    intentStore: store,
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
  const result = await coordinator.flush([intent({
    kind: 'nag', dedupeVersion: '0:0',
    payload: { data: { type: 'nag' }, tag: 'tubepulse-nag-UC-synthetic' },
    onResult: async () => { callbacks++; },
  })], {});
  assert.equal(result.reason, 'feed-not-visible');
  assert.equal(sends, 0);
  assert.equal(callbacks, 0);
  assert.equal((await store.summary()).pending, 0);
});

test('legacy pending nags expire without FCM or watermark callbacks', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-legacy-nag-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new DurableNotificationIntentStore(directory, { now: () => 1234 });
  const legacy = intent({
    kind: 'nag',
    dedupeVersion: '0:0',
    payload: { data: { type: 'nag' }, tag: 'tubepulse-nag-UC-synthetic' },
  });
  const id = notificationCoordinatorTestHelpers.intentKey(legacy);
  await store.stateFile.write({
    schemaVersion: 1,
    records: {
      [id]: {
        id,
        status: 'pending',
        intent: { ...legacy, onResult: undefined },
        createdAt: 1,
        updatedAt: 1,
        callbackApplied: false,
      },
    },
  });
  let fetches = 0;
  let sends = 0;
  const coordinator = new ProductionNotificationCoordinator(barrierConfig, {
    intentStore: store,
    fetchImpl: async () => { fetches++; throw new Error('not expected'); },
    sender: async () => { sends++; return { sent: true, deadToken: false }; },
  });
  const result = await coordinator.flush([], {});
  assert.equal(result.barrier, 'not-needed');
  assert.equal(result.transientExpired, 1);
  assert.equal(fetches, 0);
  assert.equal(sends, 0);
  const state = await store.stateFile.read();
  assert.equal(state.records[id].status, 'resolved');
  assert.equal(state.records[id].delivery, 'expired');
  assert.equal(state.records[id].suppressionReason, 'transient-nag-expired');
  assert.equal(state.records[id].callbackApplied, true);
  const summary = await store.summary();
  assert.equal(summary.transientExpired, 1);
  assert.equal(summary.fcmAcceptedTotal, 0, 'legacy history is not reconstructed as a false counter spike');
  assert.equal(summary.fcmFailedTotal, 0);
});

test('an already-claimed legacy nag remains immutable and is never replayed', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-claimed-nag-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new DurableNotificationIntentStore(directory);
  const legacy = intent({
    kind: 'nag', dedupeVersion: '0:0',
    payload: { data: { type: 'nag' }, tag: 'tubepulse-nag-UC-synthetic' },
  });
  const id = notificationCoordinatorTestHelpers.intentKey(legacy);
  await store.stateFile.write({
    schemaVersion: 1,
    records: {
      [id]: {
        id, status: 'sending', intent: legacy, createdAt: 1, updatedAt: 1,
        claimedAt: 1, callbackApplied: false,
      },
    },
  });
  let sends = 0;
  let callbacks = 0;
  const coordinator = new ProductionNotificationCoordinator({
    ...barrierConfig, gatewayConvergenceRequired: false,
  }, {
    intentStore: store,
    fetchImpl: async () => { throw new Error('not expected'); },
    sender: async () => { sends++; return { sent: true, deadToken: false }; },
  });
  const result = await coordinator.flush([{
    ...legacy,
    onResult: async (delivery) => {
      assert.equal(delivery.recovered, true);
      callbacks++;
    },
  }], {});
  assert.equal(result.recovered, 1);
  assert.equal(sends, 0);
  assert.equal(callbacks, 1);
  const state = await store.stateFile.read();
  assert.equal(state.records[id].status, 'sending');
  assert.equal(state.records[id].callbackApplied, true);
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
