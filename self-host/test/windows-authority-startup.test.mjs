import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const selfHostDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windowsDir = path.join(selfHostDir, 'windows');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

test('authority Compose uses the private awaited shutdown signal and a full-cycle grace window', () => {
  const compose = readFileSync(path.join(selfHostDir, 'compose.authority.yaml'), 'utf8');
  const cli = readFileSync(path.join(selfHostDir, 'src', 'home-authority-cli.mjs'), 'utf8');
  assert.match(compose, /stop_signal:\s*SIGUSR2/);
  assert.match(compose, /stop_grace_period:\s*4m/);
  assert.match(cli, /process\.once\('SIGUSR2',[\s\S]*shutdown\('SIGUSR2'\)/);
  assert.match(cli, /unified Home authority stopped/);
});

function runPowerShell(args) {
  return execFileSync(powershell, ['-NoProfile', '-NonInteractive', ...args], {
    cwd: selfHostDir,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function simulateStartupGate(scenario, { interval = 30, cycleTimeout = 60, margin = 15 } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tubepulse-startup-gate-'));
  try {
    const scenarioPath = path.join(directory, 'scenario.json');
    writeFileSync(scenarioPath, JSON.stringify(scenario));
    return JSON.parse(runPowerShell([
      '-ExecutionPolicy', 'Bypass', '-File', path.join(windowsDir, 'Start-HomeAuthority.ps1'),
      '-SimulationFile', scenarioPath,
      '-StabilityIntervalSeconds', String(interval),
      '-SchedulerCycleTimeoutSeconds', String(cycleTimeout),
      '-StabilityMarginSeconds', String(margin),
    ]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  assert.match(result.DeploymentManifest, /logs[\\/]deployments[\\/]production[\\/]current\.json$/i);
});

test('authority startup dry-run resolves its production files without host mutation', () => {
  const script = path.join(windowsDir, 'Start-HomeAuthority.ps1');
  const output = runPowerShell(['-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun', '-InitialDelaySeconds', '0']);
  const result = JSON.parse(output);
  assert.equal(result.DryRun, true);
  assert.equal(result.MutatedHost, false);
  assert.match(result.DeploymentManifest, /logs[\\/]deployments[\\/]production[\\/]current\.json$/i);
  assert.match(result.EnvironmentFile, /\.env\.authority$/i);
  assert.match(result.TunnelBootMarker, /data-authority[\\/]startup-cloudflared-boot\.json$/i);
  assert.equal(result.StabilityDeadlineSeconds,
    result.SchedulerCycleTimeoutSeconds + result.StabilityIntervalSeconds + result.StabilityMarginSeconds);
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

test('post-tunnel gate needs two signed checks separated by the stability interval', () => {
  const result = simulateStartupGate({ checks: ['pass', 'pass'], proof: 'ok' });
  assert.equal(result.Success, true);
  assert.equal(result.Checks, 2);
  assert.equal(result.ElapsedSeconds, 30);
  assert.equal(result.RestartAttempts, 0);
});

test('post-tunnel gate resets after connectivity fails and remains bounded', () => {
  const result = simulateStartupGate({ checks: ['pass', 'unavailable', 'unavailable', 'unavailable'], proof: 'ok' });
  assert.equal(result.Success, false);
  assert.equal(result.Category, 'stability-timeout');
  assert.ok(result.ElapsedSeconds <= result.DeadlineSeconds);
  assert.equal(result.RestartAttempts, 0, 'stability failure must not create a tunnel restart loop');
});

test('post-tunnel gate preserves idle proof around a legitimate scheduler publication and waits for settlement', () => {
  for (const busy of ['busy', 'local-busy']) {
    const result = simulateStartupGate({ checks: ['pass', busy, 'pass'], proof: 'ok' });
    assert.equal(result.Success, true);
    assert.equal(result.Checks, 3);
    assert.equal(result.ElapsedSeconds, 60);
    assert.equal(result.RestartAttempts, 0);
  }
});

test('derived gate deadline covers a full configured cycle, stability interval and margin', () => {
  const result = simulateStartupGate({ checks: ['busy', 'busy', 'pass', 'pass'], proof: 'ok' }, {
    interval: 30, cycleTimeout: 60, margin: 15,
  });
  assert.equal(result.DeadlineSeconds, 105);
  assert.equal(result.Success, true);
  assert.equal(result.ElapsedSeconds, 90);
});

test('stuck scheduler and foreign coordinator ownership fail within the derived bound', () => {
  const stuck = simulateStartupGate({ checks: ['stuck', 'stuck', 'stuck', 'stuck'], proof: 'ok' });
  assert.equal(stuck.Success, false);
  assert.equal(stuck.Category, 'stability-timeout');
  assert.ok(stuck.ElapsedSeconds <= stuck.DeadlineSeconds);
  const foreign = simulateStartupGate({ checks: ['foreign', 'foreign', 'foreign', 'foreign'], proof: 'ok' });
  assert.equal(foreign.Success, false);
  assert.equal(foreign.Category, 'stability-timeout');
  assert.ok(foreign.ElapsedSeconds <= foreign.DeadlineSeconds);
});

test('post-tunnel gate recovers only after a fresh consecutive pair', () => {
  const result = simulateStartupGate({ checks: ['pass', 'fail', 'pass', 'pass'], proof: 'ok' });
  assert.equal(result.Success, true);
  assert.equal(result.Checks, 4);
  assert.equal(result.ElapsedSeconds, 90);
});

test('post-tunnel gate requires a coordinator proof after the restart', () => {
  const missing = simulateStartupGate({ checks: ['pass', 'pass'], proof: 'failed' });
  assert.equal(missing.Success, false);
  assert.equal(missing.Category, 'coordinator-proof');
  const stale = simulateStartupGate({ checks: ['pass', 'pass'], proof: 'stale' });
  assert.equal(stale.Success, false);
  assert.equal(stale.Category, 'coordinator-proof');
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

test('startup timeline is bounded, retained and aggregate-only', () => {
  const source = readFileSync(path.join(windowsDir, 'Start-HomeAuthority.ps1'), 'utf8');
  assert.match(source, /retentionDays\s*=\s*7/);
  assert.match(source, /Select-Object -Last 20/);
  assert.match(source, /reconciliation-evidence/);
  assert.doesNotMatch(source, /deviceId\s*=|channelId\s*=|fcmToken\s*=/);
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

test('startup supervisor waits for Docker before verifying the pinned image', () => {
  const source = readFileSync(path.join(windowsDir, 'Start-HomeAuthority.ps1'), 'utf8');
  const loop = source.slice(source.indexOf('for ($attempt = 1;'));
  assert.ok(loop.indexOf('Test-DockerReady') >= 0);
  assert.ok(loop.indexOf('Resolve-PromotedHomeDeployment') > loop.indexOf('Test-DockerReady'));
  assert.match(source, /function Resolve-PromotedHomeDeployment[\s\S]*deploymentTool verify --component home/);
  assert.doesNotMatch(
    source.slice(source.indexOf("if (-not (Test-Path -LiteralPath $deploymentTool"), source.indexOf('for ($attempt = 1;')),
    /deploymentTool verify --component home/,
  );
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

test('ordinary startup is pinned, no-build, and refuses mutable workspace Compose', () => {
  const authority = readFileSync(path.join(windowsDir, 'Start-HomeAuthority.ps1'), 'utf8');
  const monitoring = readFileSync(path.resolve(selfHostDir, '..', 'monitoring', 'windows', 'Start-TubePulseMonitoring.ps1'), 'utf8');
  for (const source of [authority, monitoring]) {
    assert.match(source, /manage-production-deployment\.mjs/);
    assert.match(source, /verify-running/);
    assert.match(source, /--no-build/);
    assert.match(source, /--pull['"\s,]+never/);
    assert.doesNotMatch(source, /@\('up',\s*'-d',\s*'--build'/);
  }
  assert.doesNotMatch(authority, /Join-Path \$selfHostDirectory 'compose\.authority\.yaml'/);
  assert.doesNotMatch(monitoring, /Join-Path \$monitoringDirectory 'compose\.yaml'/);
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
