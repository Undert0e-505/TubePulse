import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCloudflareQuery, parseCloudflareAnalytics } from '../src/cloudflare.mjs';

const options = {
  accountId: 'a'.repeat(32), d1DatabaseId: '11111111-2222-3333-4444-555555555555',
  workerScript: 'tubepulse-api',
  windowStart: Date.parse('2026-10-06T11:00:00Z'), windowEnd: Date.parse('2026-10-06T11:05:00Z'),
};

test('query uses only verified aggregate datasets and finalized bounds', () => {
  const query = buildCloudflareQuery(options);
  for (const dataset of [
    'workersInvocationsAdaptive', 'd1AnalyticsAdaptiveGroups', 'd1StorageAdaptiveGroups',
    'durableObjectsInvocationsAdaptiveGroups', 'durableObjectsPeriodicGroups', 'durableObjectsSqlStorageGroups',
  ]) assert.match(query, new RegExp(dataset));
  assert.match(query, /datetime_geq/);
  assert.match(query, /datetime_lt/);
  assert.doesNotMatch(query, /deviceId|channelId|fcmToken/);
});

test('parser keeps TubePulse script aggregates and sums D1 and Durable Object usage', () => {
  const worker = (scriptName, requests) => ({
    dimensions: { scriptName, status: 'success' }, sum: { requests, errors: 1, subrequests: 2 },
    quantiles: { cpuTimeP50: 10, cpuTimeP99: 20 },
  });
  const d1 = { sum: { readQueries: 2, writeQueries: 3, rowsRead: 4, rowsWritten: 5, queryBatchResponseBytes: 6 } };
  const invocation = { dimensions: { status: 'success' }, sum: { requests: 7, errors: 1, wallTime: 8 }, quantiles: { cpuTimeP50: 9, cpuTimeP99: 10 } };
  const periodic = { dimensions: { name: 'coordinator' }, sum: { activeTime: 11, duration: 12, rowsRead: 13, rowsWritten: 14, storageReadUnits: 15, storageWriteUnits: 16, storageDeletes: 17, subrequests: 18 } };
  const account = {
    workerWindow: [worker('tubepulse-api', 20), worker('unrelated-worker', 999)],
    workerDay: [worker('tubepulse-api', 40)], d1Window: [d1, d1], d1Day: [d1],
    d1Storage: [{ max: { databaseSizeBytes: 100 } }],
    doInvocationsWindow: [invocation], doInvocationsDay: [invocation],
    doPeriodicWindow: [periodic], doPeriodicDay: [periodic], doStorage: [{ max: { storedBytes: 200 } }],
  };
  const parsed = parseCloudflareAnalytics({ data: { viewer: { accounts: [account] } } }, options);
  assert.equal(parsed.window.workers.length, 1);
  assert.equal(parsed.window.workers[0].script, 'tubepulse-api');
  assert.equal(parsed.window.d1.rowsWritten, 10);
  assert.equal(parsed.window.durableObjects.rowsWritten, 14);
  assert.equal(parsed.d1StorageBytes, 100);
  assert.equal(parsed.durableObjectStorageBytes, 200);
  const serialized = JSON.stringify(parsed);
  assert.doesNotMatch(serialized, /unrelated-worker|11111111|aaaaaaaa/);
});

test('parser returns sanitized errors', () => {
  assert.throws(() => parseCloudflareAnalytics({ errors: [{ message: 'secret detail' }] }, options), /^Error: Cloudflare GraphQL query failed$/);
});
