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

test('monitoring launcher parses and dry-runs without host mutation', () => {
  const script = path.resolve(selfHostDir, '..', 'monitoring', 'windows', 'Start-TubePulseMonitoring.ps1');
  const escaped = script.replaceAll("'", "''");
  assert.equal(runPowerShell(['-Command', `$ErrorActionPreference='Stop'; [void][scriptblock]::Create([IO.File]::ReadAllText('${escaped}')); 'ok'`]), 'ok');
  const result = JSON.parse(runPowerShell(['-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun']));
  assert.equal(result.DryRun, true);
  assert.equal(result.MutatedHost, false);
  assert.ok(['127.0.0.1', '0.0.0.0'].includes(result.GrafanaBindAddress));
  assert.equal(result.LoopbackOnly, result.GrafanaBindAddress === '127.0.0.1');
  assert.match(result.ComposeFile, /monitoring[\\/]compose\.yaml$/i);
});

test('authority startup dry-run resolves its production files without host mutation', () => {
  const script = path.join(windowsDir, 'Start-HomeAuthority.ps1');
  const output = runPowerShell(['-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun', '-InitialDelaySeconds', '0']);
  const result = JSON.parse(output);
  assert.equal(result.DryRun, true);
  assert.equal(result.MutatedHost, false);
  assert.match(result.ComposeFile, /compose\.authority\.yaml$/i);
  assert.match(result.EnvironmentFile, /\.env\.authority$/i);
  assert.match(result.TunnelBootMarker, /data-authority[\\/]startup-cloudflared-boot\.json$/i);
});

test('startup supervisor performs tunnel recovery once per OS boot after authority readiness', () => {
  const script = path.join(windowsDir, 'Start-HomeAuthority.ps1');
  const source = runPowerShell([
    '-Command',
    `$ErrorActionPreference='Stop'; $text=[IO.File]::ReadAllText('${script.replaceAll("'", "''")}'); ` +
      `if ($text -notmatch 'Get-CurrentBootIdentity' -or $text -notmatch 'startup-cloudflared-boot.json') { throw 'boot marker missing' }; ` +
      `if ($text -notmatch 'UtcDateTime.Ticks' -or $text -notmatch 'InvariantCulture') { throw 'boot identity is not cross-PowerShell stable' }; ` +
      `if (-not $text.Contains("Compose-Arguments -Tail @('restart', 'cloudflared')")) { throw 'targeted tunnel restart missing' }; ` +
      `if ($text -notmatch 'CloudflaredRestartAttempted' -or $text -notmatch 'Registered tunnel connection') { throw 'bounded registration proof missing' }; ` +
      `if ($text.LastIndexOf('Ensure-CloudflaredBootRecovery') -gt $text.IndexOf('if ($evaluation.Success)')) { 'ok' } else { throw 'tunnel recovery is not readiness-gated' }`,
  ]);
  assert.equal(source, 'ok');
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

test('startup supervisor handles PowerShell date conversion without locale round-tripping', () => {
  const script = path.join(windowsDir, 'Start-HomeAuthority.ps1');
  const source = runPowerShell([
    '-Command',
    `$ErrorActionPreference='Stop'; $text=[IO.File]::ReadAllText('${script.replaceAll("'", "''")}'); ` +
      `if (-not $text.Contains('$Value -is [DateTimeOffset]') -or -not $text.Contains('$Value -is [DateTime]')) { throw 'typed timestamp handling missing' }; 'ok'`,
  ]);
  assert.equal(source, 'ok');
});
