import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve('scripts/Run-AndroidEmulatorValidation.ps1');

function validate(args = [], env = {}) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ValidateOnly', ...args,
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, TUBEPULSE_ALLOW_EMULATOR_PRODUCTION_REGISTRATION: '', ...env },
  });
}

test('emulator validation accepts only the isolated Android host alias by default', () => {
  const result = validate(['-ApiUrl', 'http://10.0.2.2:8788']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PACKAGE=com\.tubepulse\.app\.selfhost/);
  assert.match(result.stdout, /PUSH_ENABLED=false/);
});

test('emulator validation refuses the production Worker without an exceptional override', () => {
  const result = validate(['-ApiUrl', 'https://tubepulse-api.jimothyoakley55.workers.dev']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /fail-closed/i);
});

test('one-sided production override remains refused', () => {
  const result = validate([
    '-ApiUrl', 'https://tubepulse-api.jimothyoakley55.workers.dev', '-AllowProductionEndpoint',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /I_ACCEPT_TEST_DATA_POLLUTION/);
});
