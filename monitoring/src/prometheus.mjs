function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function bool(value) { return value ? 1 : 0; }
function escape(value) { return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'); }
function labels(values = {}) {
  const entries = Object.entries(values);
  return entries.length ? `{${entries.map(([key, value]) => `${key}="${escape(value)}"`).join(',')}}` : '';
}

export function prometheusText({ snapshot, collector }) {
  const lines = [];
  const metric = (name, value, metricLabels) => lines.push(`${name}${labels(metricLabels)} ${number(value)}`);
  const host = snapshot?.host || {};
  const cloudflare = snapshot?.cloudflare || {};
  metric('tubepulse_collector_up', 1);
  metric('tubepulse_collector_collection_success', bool(collector.lastCollectionSuccess));
  metric('tubepulse_collector_errors_total', collector.errorsTotal);
  metric('tubepulse_collector_last_attempt_timestamp_seconds', collector.lastAttemptAt ? Date.parse(collector.lastAttemptAt) / 1000 : 0);
  metric('tubepulse_collector_last_success_timestamp_seconds', collector.lastSuccessAt ? Date.parse(collector.lastSuccessAt) / 1000 : 0);
  metric('tubepulse_collector_snapshot_interval_timestamp_seconds', snapshot?.intervalStart ? Date.parse(snapshot.intervalStart) / 1000 : 0);
  metric('tubepulse_collector_host_collection_success', bool(snapshot?.collection?.hostSuccess));
  metric('tubepulse_collector_cloudflare_collection_success', bool(snapshot?.collection?.cloudflareSuccess));
  metric('tubepulse_host_ready', bool(host.host?.ready));
  metric('tubepulse_host_authority_current', bool(host.host?.current));
  metric('tubepulse_host_scheduler_active', bool(host.host?.schedulerActive));
  metric('tubepulse_host_scheduler_lease_held', bool(host.host?.schedulerLeaseHeld));
  metric('tubepulse_host_mode', 1, { mode: host.host?.mode || 'unknown' });
  metric('tubepulse_host_scheduler_outcome', 1, { outcome: host.host?.schedulerOutcome || 'unknown' });
  metric('tubepulse_host_scheduler_progress_age_seconds', host.host?.schedulerProgressAgeSeconds ?? 0);
  metric('tubepulse_host_current_sweep', bool(host.host?.currentSweep));
  metric('tubepulse_host_last_error_present', bool(host.host?.lastErrorPresent));
  metric('tubepulse_installs_total', host.installs?.registered);
  metric('tubepulse_installs_push_capable', host.installs?.pushCapable);
  for (const [window, count] of Object.entries(host.installs?.new || {})) metric('tubepulse_installs_new', count, { window });
  for (const [window, count] of Object.entries(host.installs?.active || {})) metric('tubepulse_installs_active', count, { window });
  for (const entry of host.installs?.appVersions || []) metric('tubepulse_installs_app_version', entry.count, { version: entry.version });
  metric('tubepulse_channels_active', host.subscriptions?.activeChannels);
  metric('tubepulse_subscriptions_configured_memberships', host.subscriptions?.configuredMemberships);
  metric('tubepulse_subscriptions_indexed_memberships', host.subscriptions?.indexedMemberships);
  metric('tubepulse_subscription_integrity_consistent', bool(host.subscriptions?.indexConsistent));
  metric('tubepulse_subscription_membership_mismatches', host.subscriptions?.integrityIssues?.missingFromSubscriberIndex, { direction: 'missing_from_subscriber_index' });
  metric('tubepulse_subscription_membership_mismatches', host.subscriptions?.integrityIssues?.missingFromDeviceConfig, { direction: 'missing_from_device_config' });
  const integrityIssueNames = {
    activeChannelsWithNoSubscriberIndex: 'active_channel_without_subscriber_index',
    configuredChannelsAbsentFromActive: 'configured_channel_absent_from_active',
    indexedChannelsAbsentFromActive: 'indexed_channel_absent_from_active',
    deviceChannelRecordsWithoutProfile: 'device_channels_without_profile',
    configuredMembershipsMissingProfile: 'configured_membership_missing_profile',
    subscriberMembershipsMissingProfile: 'indexed_membership_missing_profile',
    duplicateConfiguredMemberships: 'duplicate_configured_membership',
    duplicateIndexedMemberships: 'duplicate_indexed_membership',
    duplicateActiveChannels: 'duplicate_active_channel',
    malformedDeviceChannelRecords: 'malformed_device_channels',
    malformedSubscriberIndexes: 'malformed_subscriber_index',
    malformedActiveChannelIndex: 'malformed_active_channel_index',
  };
  for (const [field, kind] of Object.entries(integrityIssueNames)) {
    metric('tubepulse_subscription_integrity_issues', host.subscriptions?.integrityIssues?.[field], { kind });
  }
  for (const field of ['mean', 'p50', 'p95', 'max', 'zero']) metric('tubepulse_channels_per_install', host.subscriptions?.perInstall?.[field], { statistic: field });
  metric('tubepulse_youtube_last_good_age_seconds', host.youtube?.lastGoodAgeSeconds ?? 0);
  metric('tubepulse_youtube_last_error_present', bool(host.youtube?.lastErrorPresent));
  metric('tubepulse_youtube_source_mode', 1, { mode: host.youtube?.sourceMode || 'unknown' });
  metric('tubepulse_youtube_statistics_method', 1, { method: host.youtube?.statsMethod || 'unknown' });
  for (const quota of ['general', 'statistics']) {
    metric('tubepulse_youtube_quota_used', host.youtube?.[quota]?.used, { quota });
    metric('tubepulse_youtube_quota_limit', host.youtube?.[quota]?.limit, { quota });
    metric('tubepulse_youtube_quota_reserve', host.youtube?.[quota]?.reserve, { quota });
    metric('tubepulse_youtube_api_failures', host.youtube?.[quota]?.failures, { quota });
  }
  for (const field of ['queued', 'sent', 'failed', 'suppressed', 'recovered', 'deduplicated']) metric(`tubepulse_notifications_${field}`, host.notifications?.[field]);
  for (const field of ['durableBacklog', 'ambiguousSending', 'callbackPending', 'retainedFailures', 'retainedDeadTokens']) {
    metric(`tubepulse_notifications_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`, host.notifications?.[field]);
  }
  metric('tubepulse_notifications_barrier_healthy', bool(host.notifications?.barrierHealthy));
  metric('tubepulse_authority_remote_available', bool(host.authority?.remoteAvailable));
  metric('tubepulse_authority_current', bool(host.authority?.current));
  metric('tubepulse_authority_pending_backup_keys', host.authority?.pendingBackupKeys);
  metric('tubepulse_authority_transaction_active', bool(host.authority?.transactionActive));
  metric('tubepulse_authority_lease_active', bool(host.authority?.leaseActive));
  metric('tubepulse_authority_backend_ready', bool(host.authority?.backendReady));
  for (const field of ['total', 'publication', 'api']) metric('tubepulse_authority_d1_estimated_rows', host.authority?.estimatedRows?.[field], { kind: field });
  for (const field of ['total', 'publication', 'appReserve']) metric('tubepulse_authority_d1_estimated_row_limit', host.authority?.limits?.[field], { kind: field });
  for (const period of ['window', 'day']) {
    const data = cloudflare?.[period] || {};
    for (const worker of data.workers || []) {
      const workerLabels = { period, script: worker.script, status: worker.status };
      metric('tubepulse_cloudflare_worker_requests', worker.requests, workerLabels);
      metric('tubepulse_cloudflare_worker_errors', worker.errors, workerLabels);
      metric('tubepulse_cloudflare_worker_subrequests', worker.subrequests, workerLabels);
      metric('tubepulse_cloudflare_worker_cpu_seconds', worker.cpuP50Microseconds / 1e6, { ...workerLabels, quantile: '0.50' });
      metric('tubepulse_cloudflare_worker_cpu_seconds', worker.cpuP99Microseconds / 1e6, { ...workerLabels, quantile: '0.99' });
    }
    for (const field of ['readQueries', 'writeQueries', 'rowsRead', 'rowsWritten', 'responseBytes']) {
      metric(`tubepulse_cloudflare_d1_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`, data.d1?.[field], { period });
    }
    for (const field of ['requests', 'errors', 'wallTimeMilliseconds', 'activeTimeMilliseconds', 'durationMilliseconds', 'rowsRead', 'rowsWritten', 'storageReadUnits', 'storageWriteUnits', 'storageDeletes', 'subrequests']) {
      metric(`tubepulse_cloudflare_do_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`, data.durableObjects?.[field], { period });
    }
  }
  metric('tubepulse_cloudflare_d1_storage_bytes', cloudflare?.d1StorageBytes);
  metric('tubepulse_cloudflare_do_storage_bytes', cloudflare?.durableObjectStorageBytes);
  metric('tubepulse_guardrail', collector.limits.d1RowsWritten, { resource: 'd1_rows_written_day' });
  metric('tubepulse_guardrail', collector.limits.d1RowsRead, { resource: 'd1_rows_read_day' });
  metric('tubepulse_guardrail', collector.limits.workerRequests, { resource: 'worker_requests_day' });
  return `${lines.join('\n')}\n`;
}
