import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readConfig } from '../src/config.mjs';

test('safe standalone defaults bind loopback and keep cloud sync disabled', () => {
  const config = readConfig({}, { quiet: true });
  assert.equal(config.mode, 'standalone');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8788);
  assert.equal(config.autoTakeover, false);
  assert.equal(config.sync.configured, false);
  assert.equal(config.sync.writeEnabled, false);
  assert.ok(config.warnings.some((warning) => warning.includes('FIREBASE_SERVICE_ACCOUNT')));
});

test('mirror configuration supports secret files without exposing contents', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, 'cf.token');
  const adminFile = path.join(directory, 'admin.token');
  await fs.writeFile(tokenFile, 'cloud-token\n');
  await fs.writeFile(adminFile, 'admin-token\n');
  const config = readConfig({
    TUBEPULSE_MODE: 'mirror',
    TUBEPULSE_ADMIN_TOKEN_FILE: adminFile,
    CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_KV_NAMESPACE_ID: 'namespace',
    CLOUDFLARE_API_TOKEN_FILE: tokenFile,
    TUBEPULSE_AUTO_TAKEOVER: 'true',
  });
  assert.equal(config.adminToken, 'admin-token');
  assert.equal(config.sync.apiToken, 'cloud-token');
  assert.equal(config.sync.configured, true);
  assert.equal(config.autoTakeover, true);
});

test('YouTube API key can be loaded from a secret file', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-youtube-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const keyFile = path.join(directory, 'youtube.key');
  await fs.writeFile(keyFile, 'youtube-secret\n');

  const config = readConfig({ YOUTUBE_API_KEY_FILE: keyFile }, { quiet: true });

  assert.equal(config.workerBindings.YOUTUBE_API_KEY, 'youtube-secret');
  assert.ok(!config.warnings.some((warning) => warning.includes('YOUTUBE_API_KEY')));
});

test('partial Cloudflare and unsafe automatic push configuration fail closed', () => {
  assert.throws(() => readConfig({ CLOUDFLARE_ACCOUNT_ID: 'only-one' }), /requires/);
  assert.throws(() => readConfig({ TUBEPULSE_SYNC_AUTO_PUSH: 'true' }), /WRITE_ENABLED/);
  assert.throws(
    () => readConfig({ TUBEPULSE_SYNC_AUTO_PUSH: 'true', TUBEPULSE_CLOUDFLARE_WRITE_ENABLED: 'true' }),
    /credentials/,
  );
});

test('pilot mode is local-only and refuses unsafe role or write settings', () => {
  const safe = readConfig({
    TUBEPULSE_PILOT: 'true',
    TUBEPULSE_MODE: 'standalone',
    TUBEPULSE_AUTO_TAKEOVER: 'false',
    TUBEPULSE_CLOUDFLARE_WRITE_ENABLED: 'false',
    TUBEPULSE_SYNC_AUTO_PUSH: 'false',
    CLOUDFLARE_ACCOUNT_ID: 'existing-account',
    CLOUDFLARE_KV_NAMESPACE_ID: 'existing-namespace',
    CLOUDFLARE_API_TOKEN_FILE: 'file-that-must-not-be-read',
  }, { quiet: true });

  assert.equal(safe.pilot, true);
  assert.equal(safe.mode, 'standalone');
  assert.equal(safe.autoTakeover, false);
  assert.equal(safe.sync.configured, false);
  assert.equal(safe.sync.writeEnabled, false);
  assert.equal(safe.sync.autoPush, false);
  assert.ok(safe.warnings.some((warning) => warning.includes('ignores Cloudflare')));

  assert.throws(
    () => readConfig({ TUBEPULSE_PILOT: 'true', TUBEPULSE_MODE: 'mirror' }),
    /requires TUBEPULSE_MODE=standalone/,
  );
  assert.throws(
    () => readConfig({ TUBEPULSE_PILOT: 'true', TUBEPULSE_AUTO_TAKEOVER: 'true' }),
    /requires TUBEPULSE_AUTO_TAKEOVER=false/,
  );
  assert.throws(
    () => readConfig({ TUBEPULSE_PILOT: 'true', TUBEPULSE_CLOUDFLARE_WRITE_ENABLED: 'true' }),
    /requires TUBEPULSE_CLOUDFLARE_WRITE_ENABLED=false/,
  );
  assert.throws(
    () => readConfig({ TUBEPULSE_PILOT: 'true', TUBEPULSE_SYNC_AUTO_PUSH: 'true' }),
    /requires TUBEPULSE_SYNC_AUTO_PUSH=false/,
  );
});

test('Home gateway origin is opt-in and fails closed without mirror prerequisites', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-gateway-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fingerprintFile = path.join(directory, 'canary-device.json');
  await fs.writeFile(fingerprintFile, JSON.stringify({
    deviceFingerprintSha256: 'a'.repeat(64),
    ignoredRawField: 'must-not-be-consumed',
  }));
  const base = {
    TUBEPULSE_GATEWAY_ORIGIN_ENABLED: 'true',
    TUBEPULSE_MODE: 'mirror',
    TUBEPULSE_ADMIN_TOKEN: 'synthetic-admin',
    TUBEPULSE_HOME_GATEWAY_SECRET: 'synthetic-local-gateway-secret-32-characters-minimum',
    TUBEPULSE_HOME_CANARY_SHA256_FILE: fingerprintFile,
    CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_KV_NAMESPACE_ID: 'namespace',
    CLOUDFLARE_API_TOKEN: 'token',
    TUBEPULSE_GATEWAY_RECONCILE_URL: 'https://api.synthetic.test/_tubepulse/gateway/reconcile',
  };
  const config = readConfig(base, { quiet: true });
  assert.equal(config.gatewayOrigin.enabled, true);
  assert.equal(config.gatewayOrigin.fingerprint, 'a'.repeat(64));
  assert.equal(config.gatewayOrigin.secret, base.TUBEPULSE_HOME_GATEWAY_SECRET);
  assert.equal(config.gatewayOrigin.reconcileUrl, base.TUBEPULSE_GATEWAY_RECONCILE_URL);
  assert.equal(config.gatewayOrigin.reconcileTimeoutMs, 10_000);
  assert.equal(config.warnings.some((warning) => warning.includes('RECONCILE_URL')), false);
  assert.equal(config.workerBindings.TUBEPULSE_HOME_GATEWAY_SECRET, undefined, 'origin secret must not enter the local Worker runtime');
  assert.equal(config.mode, 'mirror');

  assert.throws(() => readConfig({ ...base, TUBEPULSE_MODE: 'standalone' }), /requires TUBEPULSE_MODE=mirror/);
  assert.throws(() => readConfig({ ...base, TUBEPULSE_PILOT: 'true' }), /not allowed in pilot mode/);
  assert.throws(() => readConfig({ ...base, TUBEPULSE_HOME_GATEWAY_SECRET: 'short' }), /at least 32/);
  assert.throws(() => readConfig({ ...base, TUBEPULSE_HOME_CANARY_SHA256: 'bad', TUBEPULSE_HOME_CANARY_SHA256_FILE: '' }), /64-hex/);
  assert.throws(() => readConfig({ ...base, CLOUDFLARE_API_TOKEN: '' }), /Cloudflare sync requires/);
  assert.throws(() => readConfig({ ...base, TUBEPULSE_AUTO_TAKEOVER: 'true' }), /AUTO_TAKEOVER=false/);
  assert.throws(() => readConfig({ ...base, TUBEPULSE_CLOUDFLARE_WRITE_ENABLED: 'true' }), /writes and automatic push/);
  assert.throws(
    () => readConfig({ ...base, TUBEPULSE_GATEWAY_RECONCILE_URL: 'http://api.synthetic.test/_tubepulse/gateway/reconcile' }),
    /must use HTTPS/,
  );
  assert.throws(
    () => readConfig({ ...base, TUBEPULSE_GATEWAY_RECONCILE_URL: 'https://api.synthetic.test/feed' }),
    /must end at/,
  );
  const local = readConfig({
    ...base,
    TUBEPULSE_GATEWAY_RECONCILE_URL: 'http://127.0.0.1:9999/_tubepulse/gateway/reconcile',
    TUBEPULSE_GATEWAY_RECONCILE_ALLOW_HTTP: 'true',
    TUBEPULSE_GATEWAY_RECONCILE_TIMEOUT_SECONDS: '3',
  }, { quiet: true });
  assert.equal(local.gatewayOrigin.reconcileTimeoutMs, 3_000);
});

test('disabled gateway ignores absent gateway secrets and retains safe defaults', () => {
  const config = readConfig({ TUBEPULSE_GATEWAY_ORIGIN_ENABLED: 'false' }, { quiet: true });
  assert.equal(config.gatewayOrigin.enabled, false);
  assert.equal(config.gatewayOrigin.secret, undefined);
  assert.equal(config.gatewayOrigin.fingerprint, undefined);
});
