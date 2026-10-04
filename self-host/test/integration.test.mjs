import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readConfig } from '../src/config.mjs';
import { createSyncStateFile } from '../src/file-state.mjs';
import { contentHash } from '../src/kv-adapters.mjs';
import { createTubePulseService } from '../src/service.mjs';

async function temporaryDataDir(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function serviceConfig(dataDir, overrides = {}) {
  return readConfig({
    TUBEPULSE_DATA_DIR: dataDir,
    TUBEPULSE_HOST: '127.0.0.1',
    TUBEPULSE_PORT: '0',
    TUBEPULSE_ADMIN_TOKEN: 'integration-admin-token',
    ...overrides,
  }, { quiet: true });
}

async function register(baseUrl, deviceId, extraHeaders = {}) {
  return await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${deviceId}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify({ fcmToken: null, platform: 'integration-test', appVersion: 'test' }),
  });
}

test('existing Worker API runs locally and persisted device state survives restart', async (t) => {
  const dataDir = await temporaryDataDir('tubepulse-self-host-persist-');
  const config = serviceConfig(dataDir);
  let service = await createTubePulseService(config, { timers: false, automaticSync: false });
  t.after(async () => {
    await service?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const health = await fetch(`${service.url}/`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).worker, 'tubepulse-api');

  const cors = await fetch(`${service.url}/feed`, {
    method: 'OPTIONS',
    headers: { 'Access-Control-Request-Headers': 'Authorization, X-TubePulse-Failover' },
  });
  assert.match(cors.headers.get('Access-Control-Allow-Headers'), /X-TubePulse-Failover/i);

  const registration = await register(service.url, 'persisted-device');
  assert.equal(registration.status, 200);
  assert.equal((await registration.json()).fcmTokenPresent, false);

  await service.close();
  service = await createTubePulseService(config, { timers: false, automaticSync: false });
  const feed = await fetch(`${service.url}/feed`, {
    headers: { Authorization: 'Bearer persisted-device' },
  });
  assert.equal(feed.status, 200);
  assert.deepEqual(await feed.json(), { channels: [] });

  const status = await (await fetch(`${service.url}/_tubepulse/status`)).json();
  assert.equal(status.status, 'ready');
  assert.equal(status.mode, 'standalone');
  assert.equal(status.scheduler.state, 'active');
  assert.equal(JSON.stringify(status).includes(dataDir), false, 'public status must not expose absolute data paths');
});

test('mirror is standby; marker requires an existing mirrored device; takeover is sticky', async (t) => {
  const dataDir = await temporaryDataDir('tubepulse-self-host-mirror-');
  const config = serviceConfig(dataDir, {
    TUBEPULSE_MODE: 'mirror',
    TUBEPULSE_AUTO_TAKEOVER: 'true',
  });
  const service = await createTubePulseService(config, { timers: false, automaticSync: false });
  t.after(async () => {
    await service.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  let status = await (await fetch(`${service.url}/_tubepulse/status`)).json();
  assert.equal(status.scheduler.state, 'standby');

  // A marked health probe with a made-up bearer is not an app operation and
  // must not activate the standby scheduler.
  const health = await fetch(`${service.url}/`, {
    headers: { Authorization: 'Bearer fake-device', 'X-TubePulse-Failover': '1' },
  });
  assert.equal(health.status, 200);
  status = await (await fetch(`${service.url}/_tubepulse/status`)).json();
  assert.equal(status.scheduler.state, 'standby');

  // Registration creates a new profile, but eligibility is checked before
  // dispatch, so an arbitrary new identity cannot use registration to activate.
  const firstRegistration = await register(service.url, 'new-device', { 'X-TubePulse-Failover': '1' });
  assert.equal(firstRegistration.status, 200);
  status = await (await fetch(`${service.url}/_tubepulse/status`)).json();
  assert.equal(status.scheduler.state, 'standby');

  // An unreadable/corrupt baseline fails closed for takeover but must not turn
  // a valid app request into a gateway error.
  await fs.writeFile(path.join(dataDir, 'sync-state.json'), '{not-json', 'utf8');
  let feed = await fetch(`${service.url}/feed`, {
    headers: { Authorization: 'Bearer new-device', 'X-TubePulse-Failover': '1' },
  });
  assert.equal(feed.status, 200);
  status = await (await fetch(`${service.url}/_tubepulse/status`)).json();
  assert.equal(status.scheduler.state, 'standby');

  // A second request from the locally registered identity is still not enough:
  // it was never confirmed by a Cloudflare synchronization baseline.
  feed = await fetch(`${service.url}/feed`, {
    headers: { Authorization: 'Bearer new-device', 'X-TubePulse-Failover': '1' },
  });
  assert.equal(feed.status, 200);
  status = await (await fetch(`${service.url}/_tubepulse/status`)).json();
  assert.equal(status.scheduler.state, 'standby');

  // Seed the durable baseline exactly as a successful sync does. Only then is
  // this existing profile eligible to signal automatic takeover.
  const profileKey = 'device:new-device:profile';
  const profileValue = await service.localNamespace.get(profileKey, 'text');
  const syncStateFile = createSyncStateFile(dataDir);
  const syncState = { schemaVersion: 1, baseline: {}, conflicts: {}, lastPull: null, lastPush: null };
  syncState.baseline[profileKey] = { hash: contentHash(profileValue) };
  await syncStateFile.write(syncState);

  // Merely retaining the key in the baseline is insufficient if the local
  // profile has since changed; the content hash must still match.
  const changedProfile = { ...JSON.parse(profileValue), platform: 'locally-changed' };
  await service.localNamespace.put(profileKey, JSON.stringify(changedProfile));
  feed = await fetch(`${service.url}/feed`, {
    headers: { Authorization: 'Bearer new-device', 'X-TubePulse-Failover': '1' },
  });
  assert.equal(feed.status, 200);
  status = await (await fetch(`${service.url}/_tubepulse/status`)).json();
  assert.equal(status.scheduler.state, 'standby');
  await service.localNamespace.put(profileKey, profileValue);

  // The next successful app request is baseline-backed, so explicit opt-in
  // auto-takeover activates the mirror.
  feed = await fetch(`${service.url}/feed`, {
    headers: { Authorization: 'Bearer new-device', 'X-TubePulse-Failover': '1' },
  });
  assert.equal(feed.status, 200);
  status = await (await fetch(`${service.url}/_tubepulse/status`)).json();
  assert.equal(status.scheduler.state, 'active');
  assert.equal(status.scheduler.stickyTakeover, true);
  assert.equal(status.scheduler.roleChangeReason, 'successful-client-failover-request');
  assert.equal(JSON.stringify(status).includes('new-device'), false, 'public status must not expose device identifiers');

  // Empty channel state makes all due scheduled handlers no-op without YouTube
  // or FCM traffic, while still proving workerd scheduled dispatch functions.
  const outcomes = await service.scheduler.tick(Date.UTC(2026, 8, 20, 12, 5, 0));
  assert.equal(outcomes.length, 5);
  assert.ok(outcomes.every((outcome) => outcome.outcome === 'ok'));

  const standby = await fetch(`${service.url}/_tubepulse/admin/standby`, {
    method: 'POST',
    headers: { Authorization: 'Bearer integration-admin-token' },
  });
  assert.equal(standby.status, 200);
  status = await (await fetch(`${service.url}/_tubepulse/status`)).json();
  assert.equal(status.scheduler.state, 'standby');
});

test('mutating admin endpoints fail closed without a configured token', async (t) => {
  const dataDir = await temporaryDataDir('tubepulse-self-host-no-admin-');
  const config = readConfig({
    TUBEPULSE_DATA_DIR: dataDir,
    TUBEPULSE_PORT: '0',
  }, { quiet: true });
  const service = await createTubePulseService(config, { timers: false, automaticSync: false });
  t.after(async () => {
    await service.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const response = await fetch(`${service.url}/_tubepulse/admin/takeover`, { method: 'POST' });
  assert.equal(response.status, 503);
});
