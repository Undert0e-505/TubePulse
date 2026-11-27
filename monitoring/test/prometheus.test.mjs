import assert from 'node:assert/strict';
import test from 'node:test';
import { prometheusText } from '../src/prometheus.mjs';

test('Prometheus exposition contains aggregate labels and excludes identifiers', () => {
  const metrics = prometheusText({
    collector: {
      lastCollectionSuccess: true, errorsTotal: 0,
      lastAttemptAt: '2026-10-06T11:05:00Z', lastSuccessAt: '2026-10-06T11:05:00Z',
      limits: {
        d1RowsWritten: 100000, d1RowsRead: 5000000, durableObjectRowsWritten: 100000,
        durableObjectRequests: 100000, durableObjectRequestsSafeTarget: 90000, workerRequests: 100000,
      },
    },
    snapshot: {
      intervalStart: '2026-10-06T11:00:00Z', collection: { hostSuccess: true, cloudflareSuccess: true },
      host: {
        capabilities: {
          localKvIntegrity: true,
          homeFeedHealth: true,
          notificationVisibility: true,
          durableNotificationIntent: true,
        },
        host: {
          ready: true, current: true,
          localIntegrityHealthy: true, localIntegrityActiveIssues: 0,
          homeFeedHealthy: true, homeFeedConsecutiveFailures: 0,
          startupRecoveryHistoricalFailure: true,
          startupRecoverySuperseded: true,
          localIntegrityHealthy: true,
          localIntegrityActiveIssues: 0,
          homeFeedHealthy: true,
          homeFeedConsecutiveFailures: 0,
        },
        installs: { registered: 2, appVersions: [{ version: '4.0.0', count: 2 }] },
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
          publicationProjection: { rows: 72000, ratio: 72000 / 70000, exhaustionRisk: true },
          publicationMutations: {
            localMutations: 8, uniqueKeys: 6,
            byFamily: { 'channel-recent-videos': 4, 'nag-ledger': 1 },
            byReason: { 'metrics-only': 4, 'packed-nag-ledger': 1 },
          },
          requestTelemetry: {
            total: 50, acquireContention: 2,
            byRoute: { '/status': 10, '/acquire': 20 }, byOutcome: { success: 48, contention: 2 },
          },
        },
      },
      cloudflare: {
        window: { workers: [{ script: 'tubepulse-api', status: 'success', requests: 5 }], d1: {}, durableObjects: {} },
        day: { workers: [], d1: {}, durableObjects: {
          requests: 57000, requestsLower: 56000, requestsUpper: 58000,
          requestsSampleSize: 1200, requestsConfidenceValid: true, rowsWritten: 97398,
        } },
      },
    },
  });
  assert.match(metrics, /tubepulse_collector_collection_success 1/);
  assert.match(metrics, /tubepulse_host_ready 1/);
  assert.match(metrics, /tubepulse_host_startup_recovery_historical_failure 1/);
  assert.match(metrics, /tubepulse_host_startup_recovery_superseded 1/);
  assert.match(metrics, /tubepulse_monitoring_capability\{capability="localKvIntegrity"\} 1/);
  assert.match(metrics, /tubepulse_host_local_blob_integrity_healthy 1/);
  assert.match(metrics, /tubepulse_host_feed_healthy 1/);
  assert.match(metrics, /tubepulse_installs_app_version\{version="4\.0\.0"\} 2/);
  assert.match(metrics, /tubepulse_subscriptions_configured_memberships 4/);
  assert.match(metrics, /tubepulse_subscriptions_indexed_memberships 4/);
  assert.match(metrics, /tubepulse_subscription_integrity_consistent 1/);
  assert.match(metrics, /tubepulse_subscription_membership_mismatches\{direction="missing_from_subscriber_index"\} 0/);
  assert.match(metrics, /tubepulse_subscription_integrity_issues\{kind="active_channel_without_subscriber_index"\} 0/);
  assert.match(metrics, /tubepulse_cloudflare_worker_requests\{period="window",script="tubepulse-api",status="success"\} 5/);
  assert.match(metrics, /tubepulse_cloudflare_do_rows_written\{period="day"\} 97398/);
  assert.match(metrics, /tubepulse_guardrail\{resource="do_rows_written_day"\} 100000/);
  assert.match(metrics, /tubepulse_guardrail\{resource="do_requests_day"\} 100000/);
  assert.match(metrics, /tubepulse_guardrail\{resource="do_requests_safe_target_day"\} 90000/);
  assert.match(metrics, /tubepulse_cloudflare_do_requests\{period="day"\} 57000/);
  assert.match(metrics, /tubepulse_cloudflare_do_requests_lower\{period="day"\} 56000/);
  assert.match(metrics, /tubepulse_cloudflare_do_requests_upper\{period="day"\} 58000/);
  assert.match(metrics, /tubepulse_authority_coordinator_requests_by_route_volatile\{route="\/acquire"\} 20/);
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
  assert.match(metrics, /tubepulse_authority_d1_publication_projected_rows 72000/);
  assert.match(metrics, /tubepulse_authority_d1_publication_exhaustion_risk 1/);
  assert.match(metrics, /tubepulse_authority_publication_mutations\{kind="local_mutations"\} 8/);
  assert.match(metrics, /tubepulse_authority_publication_mutations_by_family\{family="channel-recent-videos"\} 4/);
  assert.match(metrics, /tubepulse_authority_publication_mutations_by_family\{family="nag-ledger"\} 1/);
  assert.match(metrics, /tubepulse_authority_publication_mutations_by_reason\{reason="metrics-only"\} 4/);
  assert.match(metrics, /tubepulse_authority_publication_mutations_by_reason\{reason="packed-nag-ledger"\} 1/);
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

test('unsupported Home integrity and feed evidence stays unknown rather than becoming failure zero', () => {
  const metrics = prometheusText({
    collector: { lastCollectionSuccess: true, errorsTotal: 0, limits: {} },
    snapshot: { host: { host: { ready: true }, youtube: { general: {}, statistics: {} }, notifications: {} } },
  });
  assert.match(metrics, /tubepulse_monitoring_capability\{capability="localKvIntegrity"\} 0/);
  assert.match(metrics, /tubepulse_monitoring_capability\{capability="homeFeedHealth"\} 0/);
  assert.doesNotMatch(metrics, /tubepulse_host_local_blob_integrity_healthy /);
  assert.doesNotMatch(metrics, /tubepulse_host_local_blob_integrity_issues /);
  assert.doesNotMatch(metrics, /tubepulse_host_feed_healthy /);
  assert.doesNotMatch(metrics, /tubepulse_host_feed_consecutive_failures /);
  assert.match(metrics, /tubepulse_host_ready 1/);
});

test('supported integrity or feed failure makes evidenced host readiness false', () => {
  const metrics = prometheusText({
    collector: { lastCollectionSuccess: true, errorsTotal: 0, limits: {} },
    snapshot: { host: {
      capabilities: { localKvIntegrity: true, homeFeedHealth: true },
      host: {
        ready: true, localIntegrityHealthy: true, localIntegrityActiveIssues: 0,
        homeFeedHealthy: false, homeFeedConsecutiveFailures: 1,
      },
      youtube: { general: {}, statistics: {} }, notifications: {},
    } },
  });
  assert.match(metrics, /tubepulse_host_ready 0/);
  assert.match(metrics, /tubepulse_host_feed_healthy 0/);
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
