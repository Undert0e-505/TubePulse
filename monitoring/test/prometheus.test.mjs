import assert from 'node:assert/strict';
import test from 'node:test';
import { prometheusText } from '../src/prometheus.mjs';

test('Prometheus exposition contains aggregate labels and excludes identifiers', () => {
  const metrics = prometheusText({
    collector: {
      lastCollectionSuccess: true, errorsTotal: 0,
      lastAttemptAt: '2026-10-06T11:05:00Z', lastSuccessAt: '2026-10-06T11:05:00Z',
      limits: { d1RowsWritten: 100000, d1RowsRead: 5000000, durableObjectRowsWritten: 100000, workerRequests: 100000 },
    },
    snapshot: {
      intervalStart: '2026-10-06T11:00:00Z', collection: { hostSuccess: true, cloudflareSuccess: true },
      host: {
        host: { ready: true, current: true }, installs: { registered: 2, appVersions: [{ version: '4.0.0', count: 2 }] },
        subscriptions: {
          activeChannels: 3,
          configuredMemberships: 4,
          indexedMemberships: 4,
          indexConsistent: true,
          integrityIssues: {
            missingFromSubscriberIndex: 0,
            missingFromDeviceConfig: 0,
            activeChannelsWithNoSubscriberIndex: 0,
          },
          perInstall: { mean: 2, p50: 2, p95: 2, max: 2, zero: 0 },
        },
        youtube: { general: {}, statistics: {} },
        liveWatch: { enabled: true, units: 30, requests: 30, dailyCap: 2000, remaining: 1970, ratio: 0.015, active: 2, inWindow: 1, degraded: false },
        notifications: {
          pending: 2, oldestPendingAgeSeconds: 75, durableBacklog: 1,
          barrierHealthy: true, barrierDegraded: true,
          fcmAcceptedTotal: 123, fcmFailedTotal: 4,
          fcmAcceptedInterval: 3, fcmFailedInterval: 1,
          permanentInvalidTokenResponsesTotal: 3,
          uniqueDeadTokenCleanupsTotal: 2,
          invalidTokenMonitoringCutoverAt: '2026-10-10T17:00:00.000Z',
          invalidTokenEvents: [{
            bucket: '2026-10-10T17:20:00.000Z', permanentResponses: 2, uniqueCleanups: 1,
          }],
        },
        authority: {
          pendingBackupKeys: 2,
          pendingBackupConsecutiveSamples: 1,
          transactionActive: true,
          transactionActiveConsecutiveSamples: 1,
          estimatedRows: {},
          limits: {},
        },
      },
      cloudflare: {
        window: { workers: [{ script: 'tubepulse-api', status: 'success', requests: 5 }], d1: {}, durableObjects: {} },
        day: { workers: [], d1: {}, durableObjects: { rowsWritten: 97398 } },
      },
    },
  });
  assert.match(metrics, /tubepulse_collector_collection_success 1/);
  assert.match(metrics, /tubepulse_installs_app_version\{version="4\.0\.0"\} 2/);
  assert.match(metrics, /tubepulse_subscriptions_configured_memberships 4/);
  assert.match(metrics, /tubepulse_subscriptions_indexed_memberships 4/);
  assert.match(metrics, /tubepulse_subscription_integrity_consistent 1/);
  assert.match(metrics, /tubepulse_subscription_membership_mismatches\{direction="missing_from_subscriber_index"\} 0/);
  assert.match(metrics, /tubepulse_subscription_integrity_issues\{kind="active_channel_without_subscriber_index"\} 0/);
  assert.match(metrics, /tubepulse_cloudflare_worker_requests\{period="window",script="tubepulse-api",status="success"\} 5/);
  assert.match(metrics, /tubepulse_cloudflare_do_rows_written\{period="day"\} 97398/);
  assert.match(metrics, /tubepulse_guardrail\{resource="do_rows_written_day"\} 100000/);
  assert.match(metrics, /tubepulse_notifications_pending 2/);
  assert.match(metrics, /tubepulse_notifications_oldest_pending_age_seconds 75/);
  assert.match(metrics, /tubepulse_notifications_durable_backlog 1/);
  assert.match(metrics, /tubepulse_notifications_barrier_healthy 1/);
  assert.match(metrics, /tubepulse_notifications_barrier_degraded 1/);
  assert.match(metrics, /# HELP tubepulse_notifications_fcm_accepted_total FCM send requests accepted successfully by Firebase; this does not confirm handset delivery\./);
  assert.match(metrics, /# TYPE tubepulse_notifications_fcm_accepted_total counter/);
  assert.match(metrics, /tubepulse_notifications_fcm_accepted_total 123/);
  assert.match(metrics, /# TYPE tubepulse_notifications_fcm_failed_total counter/);
  assert.match(metrics, /tubepulse_notifications_fcm_failed_total 4/);
  assert.match(metrics, /# TYPE tubepulse_notifications_fcm_permanent_invalid_responses_total counter/);
  assert.match(metrics, /tubepulse_notifications_fcm_permanent_invalid_responses_total 3/);
  assert.match(metrics, /# TYPE tubepulse_notifications_dead_token_cleanups_total counter/);
  assert.match(metrics, /tubepulse_notifications_dead_token_cleanups_total 2/);
  assert.match(metrics, /tubepulse_notifications_invalid_token_monitoring_cutover_timestamp_seconds 1791651600/);
  assert.match(metrics, /# TYPE tubepulse_notifications_invalid_token_events gauge/);
  assert.match(metrics, /tubepulse_notifications_invalid_token_events\{bucket="2026-10-10T17:20:00\.000Z",event="response"\} 2/);
  assert.match(metrics, /tubepulse_notifications_invalid_token_events\{bucket="2026-10-10T17:20:00\.000Z",event="cleanup"\} 1/);
  assert.match(metrics, /# TYPE tubepulse_notifications_fcm_accepted_interval gauge/);
  assert.match(metrics, /tubepulse_notifications_fcm_accepted_interval 3/);
  assert.match(metrics, /# TYPE tubepulse_notifications_fcm_failed_interval gauge/);
  assert.match(metrics, /tubepulse_notifications_fcm_failed_interval 1/);
  assert.match(metrics, /tubepulse_authority_pending_backup_keys 2/);
  assert.match(metrics, /tubepulse_authority_pending_backup_consecutive_samples 1/);
  assert.match(metrics, /tubepulse_authority_transaction_active 1/);
  assert.match(metrics, /tubepulse_authority_transaction_active_consecutive_samples 1/);
  assert.match(metrics, /# HELP tubepulse_live_watch_quota_units_used/);
  assert.match(metrics, /tubepulse_live_watch_quota_units_used 30/);
  assert.match(metrics, /tubepulse_live_watch_requests_total 30/);
  assert.match(metrics, /tubepulse_live_watch_quota_daily_cap 2000/);
  assert.match(metrics, /tubepulse_live_watch_quota_remaining 1970/);
  assert.match(metrics, /tubepulse_live_watch_quota_ratio 0\.015/);
  assert.match(metrics, /tubepulse_live_watch_active_watchers 2/);
  assert.match(metrics, /tubepulse_live_watch_in_window_watchers 1/);
  assert.match(metrics, /tubepulse_live_watch_degraded 0/);
  assert.doesNotMatch(metrics, /deviceId|channelId|fcmToken|UC[A-Za-z0-9_-]{20}/);
});

test('live-watch metrics fail safe to zero during older-host or restart windows', () => {
  const metrics = prometheusText({
    collector: { lastCollectionSuccess: false, errorsTotal: 1, limits: {} },
    snapshot: { host: { youtube: { general: {}, statistics: {} } } },
  });
  assert.match(metrics, /tubepulse_live_watch_quota_units_used 0/);
  assert.match(metrics, /tubepulse_live_watch_quota_daily_cap 0/);
  assert.match(metrics, /tubepulse_live_watch_quota_ratio 0/);
  assert.match(metrics, /tubepulse_live_watch_active_watchers 0/);
  assert.match(metrics, /tubepulse_live_watch_degraded 0/);
});
