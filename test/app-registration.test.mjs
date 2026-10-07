import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildRegistrationPayload } from '../src/utils/appRegistration.mjs';

const appConfig = JSON.parse(fs.readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
const apiSource = fs.readFileSync(new URL('../src/utils/api.js', import.meta.url), 'utf8');

test('registration payload uses the configured application version', () => {
  const payload = buildRegistrationPayload({
    fcmToken: 'synthetic-token',
    platform: 'android',
    appVersion: appConfig.expo.version,
  });
  assert.deepEqual(payload, {
    fcmToken: 'synthetic-token',
    platform: 'android',
    appVersion: appConfig.expo.version,
    notificationCapability: 'local-v1',
  });
  assert.match(apiSource, /appVersion = appConfig\?\.expo\?\.version \|\| null/);
  assert.match(apiSource, /notificationCapability = LOCAL_NOTIFICATION_CAPABILITY/);
  assert.match(apiSource, /fcmToken, platform, appVersion, notificationCapability/);
});

test('registration preserves null-token semantics without inventing a version', () => {
  assert.deepEqual(buildRegistrationPayload({ fcmToken: '', platform: 'android', appVersion: '  ' }), {
    fcmToken: null,
    platform: 'android',
    appVersion: null,
    notificationCapability: 'local-v1',
  });
});

test('registration capability is explicit and rejects unknown values', () => {
  assert.equal(buildRegistrationPayload({ notificationCapability: 'future-v2' }).notificationCapability, null);
  assert.equal(buildRegistrationPayload({ notificationCapability: null }).notificationCapability, null);
});
