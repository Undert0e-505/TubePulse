import crypto from 'node:crypto';
import path from 'node:path';
import {
  cleanupDeadDevice,
  getCachedFcmAccessToken,
  getKV,
  key,
  putKV,
  sendFCMPush,
} from '../../worker/tubepulse-cron/shared.mjs';
import { JsonStateFile } from './file-state.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  return await response.json().catch(() => null);
}

function intentKey(intent) {
  const input = JSON.stringify({
    kind: intent.kind,
    deviceId: intent.deviceId,
    channelId: intent.channelId,
    contentIds: [...(intent.contentIds || [])].sort(),
    tag: intent.payload?.tag || intent.payload?.data?.notificationTag || '',
    dedupeVersion: intent.dedupeVersion ?? null,
    prewarnMinutes: intent.payload?.data?.prewarnMinutes ?? null,
  });
  return crypto.createHash('sha256').update(input).digest('hex');
}

function serializableIntent(intent) {
  return {
    kind: intent.kind,
    deviceId: intent.deviceId,
    channelId: intent.channelId,
    projectId: intent.projectId,
    fcmToken: intent.fcmToken,
    notificationCapability: intent.notificationCapability || null,
    payload: intent.payload,
    contentIds: intent.contentIds,
    requireUnwatched: intent.requireUnwatched,
    dedupeVersion: intent.dedupeVersion ?? null,
  };
}

function isTransientIntent(intent) {
  return intent?.kind === 'nag';
}

// A newly staged intent is normal in-flight work, not a durable backlog.
// Monitoring samples five seconds into the scheduler cycle, so alert only
// after an intent has remained pending long enough to miss the normal send
// window. The raw pending count remains available for activity charts.
const DURABLE_BACKLOG_GRACE_MS = 60_000;

function expirePendingTransientRecords(state, now, reason = 'transient-nag-expired') {
  let expired = 0;
  for (const record of Object.values(state.records || {})) {
    if (record.status !== 'pending' || !isTransientIntent(record.intent)) continue;
    record.status = 'resolved';
    record.delivery = 'expired';
    record.suppressionReason = reason;
    record.completedAt = now;
    record.updatedAt = now;
    record.callbackApplied = true;
    expired++;
  }
  return expired;
}

export class DurableNotificationIntentStore {
  constructor(dataDir, { now = Date.now, maxRecords = 2000 } = {}) {
    this.stateFile = new JsonStateFile(path.join(dataDir, 'home-notification-intents.json'), {
      schemaVersion: 1,
      records: {},
    });
    this.now = now;
    this.maxRecords = maxRecords;
  }

  async stage(intents) {
    const state = await this.stateFile.read();
    state.records ||= {};
    const now = this.now();
    // Reminder notifications are regenerated from current canonical state on
    // every aux cycle. Pending records written by older versions are retained
    // for audit, but must never block or be replayed after this migration.
    expirePendingTransientRecords(state, now);
    const staged = [];
    for (const intent of uniqueIntents(intents)) {
      const id = intentKey(intent);
      const existing = state.records[id];
      if (isTransientIntent(intent)) {
        // Preserve an already-claimed legacy record as at-most-once evidence
        // so its callback can recover, but never create or refresh a nag.
        if (existing && ['sending', 'sent'].includes(existing.status)) {
          staged.push({ id, record: existing, intent });
        }
        continue;
      }
      if (!existing) {
        state.records[id] = {
          id,
          status: 'pending',
          intent: serializableIntent(intent),
          createdAt: now,
          updatedAt: now,
          callbackApplied: false,
        };
      } else if (existing.status === 'pending') {
        // Refresh expiring FCM credentials/payload only while no send has
        // started. A sending/sent record is immutable proof against replay.
        existing.intent = serializableIntent(intent);
        existing.updatedAt = now;
      }
      staged.push({ id, record: state.records[id], intent });
    }
    const records = Object.values(state.records);
    if (records.length > this.maxRecords) {
      const removable = records
        .filter((record) => ['sent', 'resolved'].includes(record.status) && record.callbackApplied)
        .sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
      for (const record of removable.slice(0, records.length - this.maxRecords)) delete state.records[record.id];
    }
    await this.stateFile.write(state);
    return staged;
  }

  async pending() {
    const state = await this.stateFile.read();
    return Object.values(state.records || {})
      .filter((record) => record.status === 'pending' && record.intent)
      .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
      .map((record) => ({ id: record.id, intent: structuredClone(record.intent) }));
  }

  async summary() {
    const state = await this.stateFile.read();
    const now = this.now();
    const summary = {
      pending: 0, sending: 0, sent: 0, resolved: 0,
      callbackPending: 0, failed: 0, deadToken: 0, suppressed: 0,
      transientExpired: 0, overduePending: 0, oldestPendingAgeSeconds: 0,
    };
    for (const record of Object.values(state.records || {})) {
      if (Object.hasOwn(summary, record.status)) summary[record.status]++;
      if (record.status === 'pending') {
        const ageMs = Math.max(0, now - Number(record.createdAt || now));
        summary.oldestPendingAgeSeconds = Math.max(summary.oldestPendingAgeSeconds, ageMs / 1000);
        if (ageMs >= DURABLE_BACKLOG_GRACE_MS) summary.overduePending++;
      }
      if (!record.callbackApplied && ['sending', 'sent'].includes(record.status)) summary.callbackPending++;
      if (record.delivery === 'indeterminate') summary.failed++;
      if (record.delivery === 'dead-token') summary.deadToken++;
      if (record.delivery === 'suppressed') summary.suppressed++;
      if (record.delivery === 'expired' && record.suppressionReason === 'transient-nag-expired') {
        summary.transientExpired++;
      }
    }
    return summary;
  }

  async update(id, updater) {
    const state = await this.stateFile.read();
    const record = state.records?.[id];
    if (!record) throw new Error('Notification intent record is missing');
    updater(record);
    record.updatedAt = this.now();
    await this.stateFile.write(state);
    return record;
  }

  async claim(id) {
    return await this.update(id, (record) => {
      if (record.status !== 'pending') throw new Error('Notification intent is not pending');
      // Persist before entering the ambiguous external FCM call. A restart
      // treats `sending` as logically delivered and never calls FCM again.
      record.status = 'sending';
      record.claimedAt = this.now();
    });
  }

  async sent(id, result) {
    return await this.update(id, (record) => {
      record.status = result?.sent ? 'sent' : 'resolved';
      record.delivery = result?.sent ? 'sent' : result?.deadToken ? 'dead-token' : 'indeterminate';
      record.completedAt = this.now();
    });
  }

  async callbackApplied(id) {
    return await this.update(id, (record) => { record.callbackApplied = true; });
  }

  async expirePendingKind(kind, reason = 'transient-nag-expired') {
    if (kind !== 'nag') return 0;
    const state = await this.stateFile.read();
    state.records ||= {};
    const expired = expirePendingTransientRecords(state, this.now(), reason);
    if (expired > 0) await this.stateFile.write(state);
    return expired;
  }

  async suppress(intents, reason) {
    const staged = await this.stage(intents.filter((intent) => !isTransientIntent(intent)));
    for (const { id } of staged) {
      await this.update(id, (record) => {
        if (record.status !== 'pending') return;
        record.status = 'resolved';
        record.delivery = 'suppressed';
        record.suppressionReason = String(reason || 'suppressed').slice(0, 80);
        record.completedAt = this.now();
        record.callbackApplied = true;
      });
    }
    return staged.length;
  }
}

class MemoryNotificationIntentStore extends DurableNotificationIntentStore {
  constructor() {
    super('.', {});
    this.state = { schemaVersion: 1, records: {} };
    this.stateFile = {
      read: async () => structuredClone(this.state),
      write: async (value) => { this.state = structuredClone(value); },
    };
  }
}

function uniqueIntents(intents) {
  const result = new Map();
  for (const intent of intents) {
    const key = intentKey(intent);
    if (!result.has(key)) result.set(key, intent);
  }
  return [...result.values()];
}

function channelContainsIntent(channel, intent) {
  if (!channel || channel.channelId !== intent.channelId) return false;
  const videos = new Map((channel.videos || []).map((video) => [video.videoId, video]));
  const posts = new Map((channel.posts || []).map((post) => [`post:${post.activityId}`, post]));
  return (intent.contentIds || []).every((contentId) => {
    const entry = String(contentId).startsWith('post:') ? posts.get(contentId) : videos.get(contentId);
    if (!entry) return false;
    return intent.requireUnwatched === false || entry.unwatched === true;
  });
}

export class ProductionNotificationCoordinator {
  constructor(config, {
    fetchImpl = globalThis.fetch,
    tokenProvider = getCachedFcmAccessToken,
    sender = sendFCMPush,
    sleep = delay,
    intentStore = new MemoryNotificationIntentStore(),
  } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.tokenProvider = tokenProvider;
    this.sender = sender;
    this.sleep = sleep;
    this.intentStore = intentStore;
  }

  async stage(intents) { return await this.intentStore.stage(intents); }

  async applyRecoveredResult(intent, delivery, workerEnv) {
    const kv = workerEnv?.TUBEPULSE_KV;
    if (!kv || (!delivery?.sent && !delivery?.deadToken)) return;
    if (delivery.deadToken) {
      await cleanupDeadDevice(intent.deviceId, workerEnv, 'fcm_unregistered');
      if (intent.kind !== 'prewarn') return;
    }
    if (intent.kind === 'prewarn') {
      const videoId = intent.contentIds?.[0];
      const prewarnMinutes = Number(intent.payload?.data?.prewarnMinutes);
      if (videoId && Number.isFinite(prewarnMinutes)) {
        await putKV(kv, key.prewarnSent(videoId, intent.deviceId), prewarnMinutes);
      }
      return;
    }
    if (!delivery.sent) return;
    const stateKey = key.deviceState(intent.deviceId, intent.channelId);
    const apply = async () => {
      const current = await getKV(kv, stateKey) || { unwatched: [], lastNagAt: null, nagCount: 0 };
      await putKV(kv, stateKey, {
        ...current,
        lastNagAt: Date.now(),
        ...(intent.kind === 'nag' ? { nagCount: Number(current.nagCount || 0) + 1 } : {}),
      });
    };
    if (typeof workerEnv.TUBEPULSE_KV_MUTATION_LOCK === 'function') {
      await workerEnv.TUBEPULSE_KV_MUTATION_LOCK(stateKey, apply);
    } else {
      await apply();
    }
  }

  async suppress(intents, reason) {
    const unique = uniqueIntents(intents);
    const transient = unique.filter(isTransientIntent);
    const durable = unique.filter((intent) => !isTransientIntent(intent));
    const transientExpired = await this.intentStore.expirePendingKind?.('nag', 'transient-nag-expired') || 0;
    const durableSuppressed = await this.intentStore.suppress(durable, reason);
    const suppressed = durableSuppressed + transient.length;
    return {
      queued: intents.length,
      deduplicated: intents.length - unique.length,
      sent: 0,
      failed: 0,
      suppressed,
      transientExpired,
      barrier: 'suppressed',
      reason,
    };
  }

  async postJson(url, body, headers = {}) {
    const response = await fetchWithTimeout(this.fetchImpl, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, this.config.timeoutMs);
    return { response, payload: await readJson(response) };
  }

  async convergeGateway() {
    if (!this.config.gatewayConvergenceRequired) {
      return { ok: true, attempts: 0, skipped: true };
    }
    let lastStatus = null;
    for (let attempt = 0; attempt <= this.config.retryCount; attempt++) {
      try {
        const admin = await this.postJson(this.config.gatewayAdminUrl, undefined, {
          Authorization: `Bearer ${this.config.gatewayAdminToken}`,
        });
        lastStatus = admin.response.status;
        const pull = admin.payload?.result;
        if (!admin.response.ok || admin.payload?.ok !== true || !admin.payload?.receipt
          || pull?.status !== 'ok' || Number(pull?.conflicts || 0) !== 0
          || Number(pull?.pendingLocal || 0) !== 0) {
          throw new Error('gateway-pull-not-current');
        }
        const reconcile = await this.postJson(this.config.gatewayReconcileUrl, admin.payload.receipt);
        lastStatus = reconcile.response.status;
        if (!reconcile.response.ok || reconcile.payload?.ok !== true || reconcile.payload?.state !== 'current') {
          throw new Error('gateway-reconcile-not-current');
        }
        return { ok: true, attempts: attempt + 1 };
      } catch (error) {
        if (attempt >= this.config.retryCount) {
          return {
            ok: false,
            attempts: attempt + 1,
            reason: error?.name === 'AbortError' ? 'gateway-timeout' : 'gateway-not-current',
            httpStatus: lastStatus,
          };
        }
        await this.sleep(this.config.retryBackoffMs * (2 ** attempt));
      }
    }
    return { ok: false, attempts: 0, reason: 'gateway-not-current', httpStatus: lastStatus };
  }

  async verifyProductionFeeds(intents) {
    const unresolved = new Map(uniqueIntents(intents).map((intent) => [intentKey(intent), intent]));
    const visibleIntentIds = new Set();

    for (let attempt = 0; attempt <= this.config.retryCount; attempt++) {
      const byDevice = new Map();
      for (const intent of unresolved.values()) {
        if (!byDevice.has(intent.deviceId)) byDevice.set(intent.deviceId, []);
        byDevice.get(intent.deviceId).push(intent);
      }
      for (const [deviceId, deviceIntents] of byDevice) {
        try {
          const response = await fetchWithTimeout(this.fetchImpl, `${this.config.apiBaseUrl}/feed`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${deviceId}` },
          }, this.config.timeoutMs);
          const payload = await readJson(response);
          const homeRoute = response.headers.get('X-TubePulse-Authority-Route');
          if (!response.ok || !Array.isArray(payload?.channels)
            || (this.config.requireHomeAuthorityRoute && homeRoute !== 'home')) {
            continue;
          }
          const channels = new Map(payload.channels.map((channel) => [channel.channelId, channel]));
          for (const intent of deviceIntents) {
            if (!channelContainsIntent(channels.get(intent.channelId), intent)) continue;
            const id = intentKey(intent);
            visibleIntentIds.add(id);
            unresolved.delete(id);
          }
        } catch { /* retry only the intents that have not yet been proven visible */ }
      }
      if (unresolved.size === 0) {
        return {
          ok: true,
          attempts: attempt + 1,
          deviceCount: new Set(intents.map((intent) => intent.deviceId)).size,
          visibleIntentIds: [...visibleIntentIds],
          invisibleCount: 0,
        };
      }
      if (attempt < this.config.retryCount) await this.sleep(this.config.retryBackoffMs * (2 ** attempt));
    }
    return {
      ok: false,
      attempts: this.config.retryCount + 1,
      deviceCount: new Set(intents.map((intent) => intent.deviceId)).size,
      visibleIntentIds: [...visibleIntentIds],
      invisibleCount: unresolved.size,
      reason: 'feed-not-visible',
    };
  }

  async flush(intents, workerEnv) {
    const transientExpired = await this.intentStore.expirePendingKind?.('nag', 'transient-nag-expired') || 0;
    const liveIntents = uniqueIntents(intents);
    const liveById = new Map(liveIntents.map((intent) => [intentKey(intent), intent]));
    const persistedPending = await this.intentStore.pending();
    for (const { id, intent } of persistedPending) {
      if (liveById.has(id)) continue;
      liveById.set(id, {
        ...intent,
        onResult: async (delivery) => await this.applyRecoveredResult(intent, delivery, workerEnv),
      });
    }
    const queued = [...liveById.values()];
    const deduplicated = intents.length - liveIntents.length;
    if (queued.length === 0) {
      return {
        queued: 0, deduplicated, sent: 0, failed: 0, suppressed: 0,
        transientExpired, barrier: 'not-needed',
      };
    }

    const staged = await this.intentStore.stage(queued);
    const stagedIds = new Set(staged.map(({ id }) => id));
    // Nags deliberately bypass durable storage. They still travel through the
    // same authority-route and public-feed visibility barrier in this cycle.
    for (const intent of queued.filter(isTransientIntent)) {
      const id = intentKey(intent);
      if (!stagedIds.has(id)) {
        staged.push({ id, intent, record: { status: 'pending' }, transient: true });
      }
    }
    let recovered = 0;
    let callbackFailures = 0;
    const pending = [];
    for (const entry of staged) {
      if (entry.record.status === 'pending') {
        pending.push(entry);
        continue;
      }
      // `sending` is deliberately treated as an at-most-once delivery after
      // restart: the FCM call may have escaped before the process stopped.
      // Apply the deterministic local watermark through the freshly-created
      // callback, but never call FCM again.
      if (!entry.record.callbackApplied && ['sending', 'sent'].includes(entry.record.status)) {
        try {
          await entry.intent.onResult?.({ sent: true, deadToken: false, recovered: true });
          await this.intentStore.callbackApplied(entry.id);
        } catch { callbackFailures++; }
      }
      recovered++;
    }
    if (pending.length === 0) {
      return {
        queued: queued.length, deduplicated, recovered, sent: 0, failed: 0,
        suppressed: recovered, transientExpired, barrier: 'already-claimed', callbackFailures,
      };
    }

    const pendingIntents = pending.map(({ intent }) => intent);
    const convergence = await this.convergeGateway();
    if (!convergence.ok) {
      return {
        queued: queued.length, deduplicated, recovered, sent: 0, failed: 0, suppressed: pending.length,
        transientExpired, barrier: 'failed', reason: convergence.reason, convergenceAttempts: convergence.attempts,
      };
    }
    const visibility = await this.verifyProductionFeeds(pendingIntents);
    const visibleIntentIds = new Set(visibility.visibleIntentIds || []);
    const deliverable = pending.filter(({ id }) => visibleIntentIds.has(id));
    const blockedCount = pending.length - deliverable.length;
    if (deliverable.length === 0) {
      return {
        queued: queued.length, deduplicated, recovered, sent: 0, failed: 0, suppressed: pending.length,
        transientExpired, barrier: 'failed', reason: visibility.reason, convergenceAttempts: convergence.attempts,
        visibilityAttempts: visibility.attempts,
      };
    }

    let accessToken;
    try {
      accessToken = await this.tokenProvider({ ...workerEnv, TUBEPULSE_NOTIFICATION_MODE: 'active' });
    } catch {
      return {
        queued: queued.length, deduplicated, recovered, sent: 0, failed: 0, suppressed: pending.length,
        transientExpired, barrier: blockedCount > 0 ? 'partial' : 'passed', reason: 'fcm-token-unavailable', convergenceAttempts: convergence.attempts,
        visibilityAttempts: visibility.attempts,
      };
    }

    let sent = 0;
    let failed = 0;
    for (const entry of deliverable) {
      const intent = entry.intent;
      let result;
      try {
        if (!entry.transient) await this.intentStore.claim(entry.id);
        result = await this.sender(
          accessToken,
          intent.projectId,
          intent.fcmToken,
          intent.payload,
          intent.notificationCapability || null,
        );
      } catch {
        result = { sent: false, deadToken: false };
      }
      if (!entry.transient) {
        await this.intentStore.sent(entry.id, result || { sent: false, deadToken: false });
      }
      if (result?.sent) sent++;
      else failed++;
      try {
        await intent.onResult?.(result || { sent: false, deadToken: false });
        if (!entry.transient) await this.intentStore.callbackApplied(entry.id);
      } catch {
        callbackFailures++;
      }
    }
    return {
      queued: queued.length,
      deduplicated,
      recovered,
      transientExpired,
      sent,
      failed,
      suppressed: recovered + blockedCount,
      barrier: blockedCount > 0 ? 'partial' : 'passed',
      ...(blockedCount > 0 ? { reason: visibility.reason, visibilityBlocked: blockedCount } : {}),
      callbackFailures, convergenceAttempts: convergence.attempts, visibilityAttempts: visibility.attempts,
    };
  }
}

export const notificationCoordinatorTestHelpers = {
  channelContainsIntent,
  intentKey,
  uniqueIntents,
  serializableIntent,
};
