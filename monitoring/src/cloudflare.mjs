const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const sumRows = (rows, field) => (rows || []).reduce((total, row) => total + number(row?.sum?.[field]), 0);
const maxRows = (rows, field) => (rows || []).reduce((maximum, row) => Math.max(maximum, number(row?.max?.[field])), 0);

function assertIdentifier(value, label, pattern) {
  if (!pattern.test(String(value || ''))) throw new Error(`Invalid ${label} configuration`);
  return String(value);
}

function iso(value) { return new Date(value).toISOString(); }

export function buildCloudflareQuery({ accountId, d1DatabaseId, workerScript, windowStart, windowEnd }) {
  const account = assertIdentifier(accountId, 'Cloudflare account', /^[a-f0-9]{32}$/i);
  const database = assertIdentifier(d1DatabaseId, 'D1 database', /^[a-f0-9-]{36}$/i);
  const script = assertIdentifier(workerScript, 'Worker script', /^[A-Za-z0-9_-]{1,64}$/);
  const start = iso(windowStart);
  const end = iso(windowEnd);
  const endDate = new Date(windowEnd);
  const dayStart = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())).toISOString();
  const workerFields = 'dimensions { scriptName status } sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 }';
  const d1Fields = 'sum { readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes }';
  const doInvocationFields = 'dimensions { status } sum { requests errors wallTime } quantiles { cpuTimeP50 cpuTimeP99 }';
  const doPeriodicFields = 'dimensions { name } sum { activeTime cpuTime duration rowsRead rowsWritten storageDeletes storageReadUnits storageWriteUnits subrequests }';
  return `query TubePulseOperations {
    viewer { accounts(filter: { accountTag: "${account}" }) {
      workerWindow: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: "${start}", datetime_lt: "${end}" }) { ${workerFields} }
      workerDay: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: "${dayStart}", datetime_lt: "${end}" }) { ${workerFields} }
      d1Window: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { databaseId: "${database}", datetime_geq: "${start}", datetime_lt: "${end}" }) { ${d1Fields} }
      d1Day: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { databaseId: "${database}", datetime_geq: "${dayStart}", datetime_lt: "${end}" }) { ${d1Fields} }
      d1Storage: d1StorageAdaptiveGroups(limit: 10000, filter: { databaseId: "${database}", datetime_geq: "${dayStart}", datetime_lt: "${end}" }) { max { databaseSizeBytes } }
      doInvocationsWindow: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { scriptName: "${script}", datetime_geq: "${start}", datetime_lt: "${end}" }) { ${doInvocationFields} }
      doInvocationsDay: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { scriptName: "${script}", datetime_geq: "${dayStart}", datetime_lt: "${end}" }) { ${doInvocationFields} }
      doPeriodicWindow: durableObjectsPeriodicGroups(limit: 10000, filter: { datetime_geq: "${start}", datetime_lt: "${end}" }) { ${doPeriodicFields} }
      doPeriodicDay: durableObjectsPeriodicGroups(limit: 10000, filter: { datetime_geq: "${dayStart}", datetime_lt: "${end}" }) { ${doPeriodicFields} }
      doStorage: durableObjectsSqlStorageGroups(limit: 10000, filter: { datetime_geq: "${dayStart}", datetime_lt: "${end}" }) { max { storedBytes } }
    } }
  }`;
}

function workers(rows) {
  return (rows || [])
    .filter((row) => String(row?.dimensions?.scriptName || '').startsWith('tubepulse-'))
    .map((row) => ({
      script: String(row.dimensions.scriptName),
      status: String(row.dimensions.status || 'unknown'),
      requests: number(row.sum?.requests),
      errors: number(row.sum?.errors),
      subrequests: number(row.sum?.subrequests),
      cpuP50Microseconds: number(row.quantiles?.cpuTimeP50),
      cpuP99Microseconds: number(row.quantiles?.cpuTimeP99),
    }))
    .sort((left, right) => `${left.script}:${left.status}`.localeCompare(`${right.script}:${right.status}`));
}

function d1(rows) {
  return {
    readQueries: sumRows(rows, 'readQueries'),
    writeQueries: sumRows(rows, 'writeQueries'),
    rowsRead: sumRows(rows, 'rowsRead'),
    rowsWritten: sumRows(rows, 'rowsWritten'),
    responseBytes: sumRows(rows, 'queryBatchResponseBytes'),
  };
}

function durableObjects(invocations, periodic) {
  return {
    requests: sumRows(invocations, 'requests'),
    errors: sumRows(invocations, 'errors'),
    wallTimeMilliseconds: sumRows(invocations, 'wallTime'),
    cpuP50Microseconds: Math.max(0, ...(invocations || []).map((row) => number(row.quantiles?.cpuTimeP50))),
    cpuP99Microseconds: Math.max(0, ...(invocations || []).map((row) => number(row.quantiles?.cpuTimeP99))),
    activeTimeMilliseconds: sumRows(periodic, 'activeTime'),
    durationMilliseconds: sumRows(periodic, 'duration'),
    rowsRead: sumRows(periodic, 'rowsRead'),
    rowsWritten: sumRows(periodic, 'rowsWritten'),
    storageReadUnits: sumRows(periodic, 'storageReadUnits'),
    storageWriteUnits: sumRows(periodic, 'storageWriteUnits'),
    storageDeletes: sumRows(periodic, 'storageDeletes'),
    subrequests: sumRows(periodic, 'subrequests'),
  };
}

export function parseCloudflareAnalytics(payload, { windowStart, windowEnd }) {
  if (Array.isArray(payload?.errors) && payload.errors.length) throw new Error('Cloudflare GraphQL query failed');
  const account = payload?.data?.viewer?.accounts?.[0];
  if (!account) throw new Error('Cloudflare GraphQL account data is unavailable');
  const end = new Date(windowEnd);
  const dayStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())).toISOString();
  return {
    window: {
      start: iso(windowStart), end: iso(windowEnd),
      workers: workers(account.workerWindow),
      d1: d1(account.d1Window),
      durableObjects: durableObjects(account.doInvocationsWindow, account.doPeriodicWindow),
    },
    day: {
      start: dayStart, end: iso(windowEnd),
      workers: workers(account.workerDay),
      d1: d1(account.d1Day),
      durableObjects: durableObjects(account.doInvocationsDay, account.doPeriodicDay),
    },
    d1StorageBytes: maxRows(account.d1Storage, 'databaseSizeBytes'),
    durableObjectStorageBytes: maxRows(account.doStorage, 'storedBytes'),
    analyticsNote: 'GraphQL analytics are delayed/approximate and are not authoritative billing data.',
  };
}

export async function fetchCloudflareAnalytics({ token, fetchImpl = globalThis.fetch, ...options }) {
  if (!token) throw new Error('Cloudflare analytics token is missing');
  let response;
  try {
    response = await fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: buildCloudflareQuery(options) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('Cloudflare analytics network failure');
  }
  if (!response.ok) throw new Error(`Cloudflare analytics HTTP ${response.status}`);
  const payload = await response.json().catch(() => null);
  return parseCloudflareAnalytics(payload, options);
}
