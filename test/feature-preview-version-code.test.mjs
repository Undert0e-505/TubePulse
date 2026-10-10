import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('..', import.meta.url));
const buildScript = fileURLToPath(new URL('../build-and-release.ps1', import.meta.url));
const runnerScript = fileURLToPath(new URL('../scripts/Run-AndroidBuildTask.ps1', import.meta.url));
const buildGradle = readFileSync(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
const checkedInVersionCode = Number(buildGradle.match(/versionCode (\d+)/)?.[1]);

function runRejected(args) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', buildScript, ...args],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0, `expected rejection for: ${args.join(' ')}`);
  return `${result.stdout}\n${result.stderr}`;
}

test('build-only versionCode override rejects invalid or unsafe combinations before building', () => {
  assert.match(
    runRejected(['-BuildOnly', '-BuildOnlyVersionCodeOverride', 'not-a-code']),
    /must be a positive integer/,
  );
  assert.match(
    runRejected(['-BuildOnly', '-BuildOnlyVersionCodeOverride', String(checkedInVersionCode)]),
    new RegExp(`must be greater than the checked-in\\s+versionCode \\(${checkedInVersionCode}\\)`),
  );
  assert.match(
    runRejected(['4.2.0', '-BuildOnlyVersionCodeOverride', '411']),
    /allowed only with -BuildOnly/,
  );
  assert.match(
    runRejected(['4.2.0', '-ValidateOnly', '-BuildOnlyVersionCodeOverride', '411']),
    /allowed only with -BuildOnly/,
  );
});

test('FeaturePreview alone uses the fixed scoped init hook and all builds verify their expected code', () => {
  const buildSource = readFileSync(buildScript, 'utf8');
  const runnerSource = readFileSync(runnerScript, 'utf8');
  const parameterBlock = buildSource.slice(buildSource.indexOf('param('), buildSource.indexOf('\n)\n', buildSource.indexOf('param(')) + 3);

  assert.equal(buildSource.includes('android.injected.version.code'), false);
  assert.match(buildSource, /feature-preview-version-code-\{0\}\.init\.gradle/);
  assert.match(buildSource, /project\.path == ':app' && project\.rootProject == gradle\.rootProject/);
  assert.match(buildSource, /project\.plugins\.withId\('com\.android\.application'\)/);
  assert.match(buildSource, /variant\.buildType\.name == 'release'/);
  assert.match(buildSource, /output\.versionCodeOverride = \$expectedApkVersionCode/);
  assert.match(buildSource, /\$gradleArguments \+= @\('--init-script', \$previewVersionInitScriptPath\)/);
  assert.match(buildSource, /finally \{[\s\S]*Remove-Item -LiteralPath \$previewVersionInitScriptPath -Force/);
  assert.equal(/InitScript/i.test(parameterBlock), false);
  assert.match(buildSource, /\$apkVc -ne \$expectedApkVersionCode/);
  assert.match(runnerSource, /if \(\$Mode -eq 'FeaturePreview'\) \{\s*\$expectedApkVersionCode = \[string\]\(\(\[int\]\$versionCode\) \+ 1\)\s*\}/);
  assert.match(runnerSource, /if \(\$Mode -eq 'FeaturePreview'\) \{\s*\$arguments \+= @\('-BuildOnlyVersionCodeOverride', \$expectedApkVersionCode\)\s*\}/);
  assert.match(runnerSource, /Assert-ReleaseApk -ApkPath \$outputPath -ExpectedVersion \$version -ExpectedVersionCode \$expectedApkVersionCode/);
  assert.equal((runnerSource.match(/'-BuildOnlyVersionCodeOverride'/g) || []).length, 1);
});
