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

for (const name of ['Start-HomeAuthority.ps1', 'Install-HomeAuthorityStartupTask.ps1', 'Install-HomeAuthorityStartupShortcut.ps1']) {
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
  assert.equal(result.Plan.User, `${process.env.USERDOMAIN}\\${process.env.USERNAME}`);
  assert.match(result.Plan.Arguments, /Start-HomeAuthority\.ps1/i);
});

test('Scheduled Task installer accepts an explicit interactive target across UAC identities', () => {
  const script = path.join(windowsDir, 'Install-HomeAuthorityStartupTask.ps1');
  const target = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const output = runPowerShell(['-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun', '-TargetUser', target]);
  const result = JSON.parse(output);
  assert.equal(result.Plan.User, target);
});

test('per-user Startup installer dry-run is hidden, absolute, and non-administrative', () => {
  const script = path.join(windowsDir, 'Install-HomeAuthorityStartupShortcut.ps1');
  const output = runPowerShell(['-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun']);
  const result = JSON.parse(output);
  assert.equal(result.DryRun, true);
  assert.equal(result.MutatedHost, false);
  assert.equal(result.Plan.RequiresAdministrator, false);
  assert.match(result.Plan.ShortcutPath, /Startup[\\/]TubePulse Home Authority\.lnk$/i);
  assert.match(result.Plan.TargetPath, /powershell\.exe$/i);
  assert.match(result.Plan.Arguments, /-WindowStyle Hidden/i);
  assert.match(result.Plan.Arguments, /Start-HomeAuthority\.ps1/i);
  assert.ok(path.isAbsolute(result.Plan.WorkingDirectory));
});

test('startup supervisor evaluates the status fields actually exposed by Home', () => {
  const script = path.join(windowsDir, 'Start-HomeAuthority.ps1');
  const source = runPowerShell([
    '-Command',
    `$ErrorActionPreference='Stop'; $text=[IO.File]::ReadAllText('${script.replaceAll("'", "''")}'); ` +
      `if ($text -match 'lease\.heartbeatAt') { throw 'unsupported heartbeat field' }; ` +
      `if ($text -notmatch "-Name 'state'" -or $text -notmatch "-Name 'lastGoodAt'" -or $text -notmatch 'lastMinuteJobs') { throw 'missing progress fields' }; 'ok'`,
  ]);
  assert.equal(source, 'ok');
});

test('startup supervisor treats Docker stderr as native progress and uses the exit code', () => {
  const script = path.join(windowsDir, 'Start-HomeAuthority.ps1');
  const source = runPowerShell([
    '-Command',
    `$ErrorActionPreference='Stop'; $text=[IO.File]::ReadAllText('${script.replaceAll("'", "''")}'); ` +
      `if ($text -notmatch "ErrorActionPreference = 'Continue'" -or $text -notmatch '\\$exitCode = \\$LASTEXITCODE') { throw 'native wrapper missing' }; 'ok'`,
  ]);
  assert.equal(source, 'ok');
});

test('signed status check uses the tracked source without rebuilding the live image', () => {
  const script = path.join(windowsDir, 'Start-HomeAuthority.ps1');
  const source = runPowerShell([
    '-Command',
    `$ErrorActionPreference='Stop'; $text=[IO.File]::ReadAllText('${script.replaceAll("'", "''")}'); ` +
      `if ($text -notmatch '/app/self-host/src:ro' -or $text -notmatch "'--volume'") { throw 'read-only source mount missing' }; ` +
      `if ($text -match "'--build'") { throw 'live image rebuild is unsafe here' }; 'ok'`,
  ]);
  assert.equal(source, 'ok');
});

test('startup supervisor remains compatible with Windows PowerShell 5', () => {
  const script = path.join(windowsDir, 'Start-HomeAuthority.ps1');
  const source = runPowerShell([
    '-Command',
    `$ErrorActionPreference='Stop'; $text=[IO.File]::ReadAllText('${script.replaceAll("'", "''")}'); ` +
      `if ($text -match 'Select-Object -Reverse') { throw 'unsupported PowerShell parameter' }; 'ok'`,
  ]);
  assert.equal(source, 'ok');
});

test('startup supervisor tolerates transient optional scheduler fields under strict mode', () => {
  const script = path.join(windowsDir, 'Start-HomeAuthority.ps1');
  const source = runPowerShell([
    '-Command',
    `$ErrorActionPreference='Stop'; $text=[IO.File]::ReadAllText('${script.replaceAll("'", "''")}'); ` +
      `if ($text -notmatch 'function Get-OptionalProperty' -or $text -notmatch 'scheduler.currentSweep') { throw 'optional accessor missing' }; 'ok'`,
  ]);
  assert.equal(source, 'ok');
});
