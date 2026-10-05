import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVE_LATCH,
  FIVE_MINUTE_POSTS_LATCH,
  UNIFIED_AUTHORITY_LATCH,
  readHomeSchedulerConfig,
} from '../src/home-scheduler-config.mjs';

const readEnv = {
  CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_KV_NAMESPACE_ID: 'namespace',
  CLOUDFLARE_API_TOKEN: 'read-token',
};

const notificationBarrierEnv = {
  TUBEPULSE_HOME_SCHEDULER_GATEWAY_CONVERGENCE_REQUIRED: 'true',
  TUBEPULSE_HOME_SCHEDULER_GATEWAY_ADMIN_TOKEN: 'gateway-admin-token',
  TUBEPULSE_HOME_SCHEDULER_GATEWAY_ADMIN_URL: 'http://host.docker.internal:8789/_tubepulse/admin/gateway/reconcile',
  TUBEPULSE_HOME_SCHEDULER_GATEWAY_RECONCILE_URL: 'https://api.example.test/_tubepulse/gateway/reconcile',
  TUBEPULSE_HOME_SCHEDULER_API_URL: 'https://api.example.test',
};

const authorityEnv = {
  TUBEPULSE_HOME_UNIFIED_AUTHORITY_ENABLED: 'true',
  TUBEPULSE_HOME_UNIFIED_AUTHORITY_LATCH: UNIFIED_AUTHORITY_LATCH,
  TUBEPULSE_HOME_AUTHORITY_API_URL: 'https://api.example.test',
  TUBEPULSE_HOME_AUTHORITY_SECRET: 'synthetic-authority-secret-with-more-than-32-characters',
};

test('Home scheduler defaults to fail-closed shadow mode', () => {
  const config = readHomeSchedulerConfig(readEnv, { quiet: true });
  assert.equal(config.mode, 'shadow');
  assert.equal(config.remoteWriteEnabled, false);
  assert.equal(config.notificationsEnabled, false);
  assert.equal(config.workerBindings.TUBEPULSE_NOTIFICATION_MODE, 'shadow');
  assert.equal(config.rssChannelTimeoutMs, 3_000);
  assert.equal(config.youtubeApiFallback.enabled, false);
});

test('YouTube API fallback is key-gated and can be explicitly disabled or capped', () => {
  const enabled = readHomeSchedulerConfig({
    ...readEnv,
    YOUTUBE_API_KEY: 'synthetic-key',
    TUBEPULSE_HOME_SCHEDULER_YOUTUBE_FALLBACK_DAILY_CAP: '321',
  });
  assert.equal(enabled.youtubeApiFallback.configured, true);
  assert.equal(enabled.youtubeApiFallback.enabled, true);
  assert.equal(enabled.youtubeApiFallback.dailyCap, 321);
  const disabled = readHomeSchedulerConfig({
    ...readEnv,
    YOUTUBE_API_KEY: 'synthetic-key',
    TUBEPULSE_HOME_SCHEDULER_YOUTUBE_API_FALLBACK_ENABLED: 'false',
  });
  assert.equal(disabled.youtubeApiFallback.configured, true);
  assert.equal(disabled.youtubeApiFallback.enabled, false);
});

test('RSS circuit tuning preserves exponential backoff and two-success anti-flap minimums', () => {
  assert.throws(() => readHomeSchedulerConfig({
    ...readEnv,
    TUBEPULSE_HOME_SCHEDULER_RSS_CIRCUIT_INITIAL_COOLDOWN_MINUTES: '30',
    TUBEPULSE_HOME_SCHEDULER_RSS_CIRCUIT_MAXIMUM_COOLDOWN_MINUTES: '15',
  }), /maximum cooldown/);
  assert.throws(() => readHomeSchedulerConfig({
    ...readEnv,
    TUBEPULSE_HOME_SCHEDULER_RSS_RECOVERY_SUCCESSES: '1',
  }), /at least two consecutive successes/);
});

test('shadow and standby reject notification or write enablement', () => {
  assert.throws(
    () => readHomeSchedulerConfig({ ...readEnv, TUBEPULSE_HOME_SCHEDULER_REMOTE_WRITE_ENABLED: 'true' }),
    /forbidden outside active/,
  );
  assert.throws(
    () => readHomeSchedulerConfig({ ...readEnv, TUBEPULSE_HOME_SCHEDULER_NOTIFICATIONS_ENABLED: 'true' }),
    /forbidden outside active/,
  );
});

test('active mode requires every independent activation guard', () => {
  const base = {
    ...readEnv,
    ...notificationBarrierEnv,
    TUBEPULSE_HOME_SCHEDULER_MODE: 'active',
    TUBEPULSE_HOME_SCHEDULER_REMOTE_WRITE_ENABLED: 'true',
    TUBEPULSE_HOME_SCHEDULER_NOTIFICATIONS_ENABLED: 'true',
    FIREBASE_SERVICE_ACCOUNT: '{"project_id":"test"}',
    YOUTUBE_API_KEY: 'synthetic-key',
  };
  assert.throws(() => readHomeSchedulerConfig(base), /scheduled triggers are disabled/);
  assert.throws(
    () => readHomeSchedulerConfig({ ...base, TUBEPULSE_CLOUDFLARE_SCHEDULES_CONFIRMED_DISABLED: 'true' }),
    /ACTIVATION_LATCH/,
  );
  assert.throws(() => readHomeSchedulerConfig({
    ...base,
    TUBEPULSE_CLOUDFLARE_SCHEDULES_CONFIRMED_DISABLED: 'true',
    TUBEPULSE_HOME_SCHEDULER_ACTIVATION_LATCH: ACTIVE_LATCH,
  }), /UNIFIED_AUTHORITY_LATCH/);
  const active = readHomeSchedulerConfig({
    ...base,
    ...authorityEnv,
    TUBEPULSE_CLOUDFLARE_SCHEDULES_CONFIRMED_DISABLED: 'true',
    TUBEPULSE_HOME_SCHEDULER_ACTIVATION_LATCH: ACTIVE_LATCH,
  });
  assert.equal(active.mode, 'active');
  assert.equal(active.authority.enabled, true);
});

test('active notification delivery requires a local admin pull and HTTPS production verification path', () => {
  const base = {
    ...readEnv,
    TUBEPULSE_HOME_SCHEDULER_MODE: 'active',
    TUBEPULSE_HOME_SCHEDULER_REMOTE_WRITE_ENABLED: 'true',
    TUBEPULSE_HOME_SCHEDULER_NOTIFICATIONS_ENABLED: 'true',
    TUBEPULSE_CLOUDFLARE_SCHEDULES_CONFIRMED_DISABLED: 'true',
    TUBEPULSE_HOME_SCHEDULER_ACTIVATION_LATCH: ACTIVE_LATCH,
    FIREBASE_SERVICE_ACCOUNT: '{"project_id":"test"}',
    YOUTUBE_API_KEY: 'synthetic-key',
  };
  assert.throws(() => readHomeSchedulerConfig(base), /production API visibility barrier/);
  assert.throws(() => readHomeSchedulerConfig({
    ...base,
    TUBEPULSE_HOME_SCHEDULER_API_URL: 'https://api.example.test',
  }), /UNIFIED_AUTHORITY_LATCH/);
  assert.throws(() => readHomeSchedulerConfig({
    ...base,
    ...authorityEnv,
    ...notificationBarrierEnv,
    TUBEPULSE_HOME_SCHEDULER_GATEWAY_ADMIN_URL: 'https://public.example.test/_tubepulse/admin/gateway/reconcile',
  }), /local gateway reconciliation/);
  assert.throws(() => readHomeSchedulerConfig({
    ...base,
    ...authorityEnv,
    ...notificationBarrierEnv,
    TUBEPULSE_HOME_SCHEDULER_API_URL: 'http://api.example.test',
  }), /must use https/);
  assert.throws(() => readHomeSchedulerConfig({
    ...base,
    ...authorityEnv,
    TUBEPULSE_HOME_SCHEDULER_API_URL: 'https://api.example.test',
    TUBEPULSE_HOME_SCHEDULER_GATEWAY_CONVERGENCE_REQUIRED: 'true',
  }), /gateway reconciliation configuration/);
});

test('shadow requires read-only canonical seed access', () => {
  assert.throws(() => readHomeSchedulerConfig({}), /complete read access/);
  const standby = readHomeSchedulerConfig({ TUBEPULSE_HOME_SCHEDULER_MODE: 'standby' });
  assert.equal(standby.mode, 'standby');
});

test('five-minute post cadence requires a separate explicit quota latch', () => {
  assert.throws(
    () => readHomeSchedulerConfig({ ...readEnv, TUBEPULSE_HOME_SCHEDULER_POSTS_CADENCE_MINUTES: '5' }),
    /explicit quota flag/,
  );
  const config = readHomeSchedulerConfig({
    ...readEnv,
    TUBEPULSE_HOME_SCHEDULER_POSTS_CADENCE_MINUTES: '5',
    TUBEPULSE_HOME_SCHEDULER_ALLOW_5M_POSTS: 'true',
    TUBEPULSE_HOME_SCHEDULER_5M_POSTS_LATCH: FIVE_MINUTE_POSTS_LATCH,
  });
  assert.equal(config.postsCadenceMinutes, 5);
});
