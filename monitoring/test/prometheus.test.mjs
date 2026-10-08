import assert from 'node:assert/strict';
import test from 'node:test';
import { prometheusText } from '../src/prometheus.mjs';

test('Prometheus exposition contains aggregate labels and excludes identifiers', () => {
  const metrics = prometheusText({
    collector: {
      lastCollectionSuccess: true, errorsTotal: 0,
      lastAttemptAt: '2026-10-06T11:05:00Z', lastSuccessAt: '2026-10-06T11:05:00Z',
      limits: { d1RowsWritten: 100000, d1RowsRead: 5000000, workerRequests: 100000 },
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
        notifications: { pending: 2, oldestPendingAgeSeconds: 75, durableBacklog: 1 },
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
        day: { workers: [], d1: {}, durableObjects: {} },
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
  assert.match(metrics, /tubepulse_notifications_pending 2/);
  assert.match(metrics, /tubepulse_notifications_oldest_pending_age_seconds 75/);
  assert.match(metrics, /tubepulse_notifications_durable_backlog 1/);
  assert.match(metrics, /tubepulse_authority_pending_backup_keys 2/);
  assert.match(metrics, /tubepulse_authority_pending_backup_consecutive_samples 1/);
  assert.match(metrics, /tubepulse_authority_transaction_active 1/);
  assert.match(metrics, /tubepulse_authority_transaction_active_consecutive_samples 1/);
  assert.doesNotMatch(metrics, /deviceId|channelId|fcmToken|UC[A-Za-z0-9_-]{20}/);
});
