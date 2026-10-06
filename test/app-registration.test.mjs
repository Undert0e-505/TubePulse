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
  });
  assert.match(apiSource, /appVersion = appConfig\?\.expo\?\.version \|\| null/);
  assert.match(apiSource, /buildRegistrationPayload\(\{ fcmToken, platform, appVersion \}\)/);
});

test('registration preserves null-token semantics without inventing a version', () => {
  assert.deepEqual(buildRegistrationPayload({ fcmToken: '', platform: 'android', appVersion: '  ' }), {
    fcmToken: null,
    platform: 'android',
    appVersion: null,
  });
});
