import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const selfHostDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windowsDir = path.join(selfHostDir, 'windows');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

function runPowerShell(args) {
  return execFileSync(powershell, ['-NoProfile', '-NonInteractive', ...args], {
    cwd: selfHostDir,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

for (const name of ['Start-HomeAuthority.ps1', 'Install-HomeAuthorityStartupTask.ps1']) {
  test(`${name} parses as PowerShell without execution`, () => {
    const script = path.join(windowsDir, name).replaceAll("'", "''");
    const result = runPowerShell(['-Command', `$ErrorActionPreference='Stop'; [void][scriptblock]::Create([IO.File]::ReadAllText('${script}')); 'ok'`]);
    assert.equal(result, 'ok');
  });
}

test('authority startup dry-run resolves its production files without host mutation', () => {
  const script = path.join(windowsDir, 'Start-HomeAuthority.ps1');
  const output = runPowerShell(['-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun', '-InitialDelaySeconds', '0']);
  const result = JSON.parse(output);
  assert.equal(result.DryRun, true);
  assert.equal(result.MutatedHost, false);
  assert.match(result.ComposeFile, /compose\.authority\.yaml$/i);
  assert.match(result.EnvironmentFile, /\.env\.authority$/i);
});

test('Scheduled Task installer dry-run produces hidden non-overlapping logon plan', () => {
  const script = path.join(windowsDir, 'Install-HomeAuthorityStartupTask.ps1');
  const output = runPowerShell(['-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun']);
  const result = JSON.parse(output);
  assert.equal(result.DryRun, true);
  assert.equal(result.MutatedHost, false);
  assert.equal(result.Plan.Trigger, 'AtLogOn');
  assert.equal(result.Plan.Hidden, true);
  assert.equal(result.Plan.MultipleInstances, 'IgnoreNew');
  assert.match(result.Plan.Arguments, /Start-HomeAuthority\.ps1/i);
});
