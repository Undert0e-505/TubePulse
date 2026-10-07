[CmdletBinding()]
param(
    [ValidateSet('Preflight', 'Official', 'Preview')]
    [string]$Mode = 'Official'
)

$ErrorActionPreference = 'Stop'

$expectedRepo = [System.IO.Path]::GetFullPath('D:\dev\TubePulse')
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $repo.Equals($expectedRepo, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Android build runner is restricted to $expectedRepo (resolved $repo)."
}

$runtimeDir = Join-Path $repo 'logs\build-runner'
$statusPath = Join-Path $runtimeDir ("{0}.status.json" -f $Mode.ToLowerInvariant())
$logPath = Join-Path $runtimeDir ("{0}.log" -f $Mode.ToLowerInvariant())
$errorLogPath = Join-Path $runtimeDir ("{0}.stderr.log" -f $Mode.ToLowerInvariant())
$startedAt = [DateTimeOffset]::UtcNow
$mutex = New-Object System.Threading.Mutex($false, 'Local\TubePulseAndroidBuildRunner')
$hasMutex = $false

function Write-RunnerStatus {
    param(
        [string]$State,
        [string]$Stage,
        [int]$ExitCode = 0,
        [string]$OutputPath = '',
        [string]$Sha256 = '',
        [string]$Message = ''
    )

    $payload = [ordered]@{
        mode = $Mode
        state = $State
        stage = $Stage
        exitCode = $ExitCode
        startedAt = $startedAt.ToString('o')
        updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
        outputPath = $OutputPath
        sha256 = $Sha256
        message = $Message
    }
    $tempPath = "$statusPath.tmp"
    $payload | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $tempPath -Encoding UTF8
    Move-Item -LiteralPath $tempPath -Destination $statusPath -Force
}

function Invoke-GitText {
    param([string[]]$Arguments)
    $result = & git -C $repo @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed."
    }
    return (($result | Out-String).Trim())
}

try {
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    $hasMutex = $mutex.WaitOne(0)
    if (-not $hasMutex) {
        Write-RunnerStatus -State 'failed' -Stage 'lock' -ExitCode 2 -Message 'Another TubePulse Android build is already running.'
        exit 2
    }

    Write-RunnerStatus -State 'running' -Stage 'validate'

    $topLevel = [System.IO.Path]::GetFullPath((Invoke-GitText @('rev-parse', '--show-toplevel')))
    if (-not $topLevel.Equals($repo, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Git top level is not the fixed TubePulse repository.'
    }
    $remote = Invoke-GitText @('remote', 'get-url', 'origin')
    if ($remote -notin @('https://github.com/Undert0e-505/TubePulse.git', 'git@github.com:Undert0e-505/TubePulse.git')) {
        throw 'Origin is not the expected TubePulse repository.'
    }
    $branch = Invoke-GitText @('branch', '--show-current')
    if ($branch -ne 'master') {
        throw "Build runner requires master (found $branch)."
    }
    $head = Invoke-GitText @('rev-parse', 'HEAD')
    $originHead = Invoke-GitText @('rev-parse', 'origin/master')
    if ($head -ne $originHead) {
        throw 'Local master does not match origin/master.'
    }

    $statusText = Invoke-GitText @('status', '--porcelain=v1')
    $status = @($statusText -split "`r?`n" | Where-Object { $_ })
    $unexpected = @($status | Where-Object {
        $path = $_.Substring(3).Replace('\', '/')
        -not ($path.StartsWith('monitoring/') -or $path.StartsWith('logs/'))
    })
    if ($unexpected.Count -gt 0) {
        throw "Unexpected source changes block the build: $($unexpected -join '; ')"
    }

    $appConfig = Get-Content -LiteralPath (Join-Path $repo 'app.json') -Raw | ConvertFrom-Json
    $version = [string]$appConfig.expo.version
    if ($version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
        throw 'app.json does not contain a stable semantic version.'
    }
    $buildGradle = Get-Content -LiteralPath (Join-Path $repo 'android\app\build.gradle') -Raw
    if ($buildGradle -notmatch 'versionName "([^"]+)"') { throw 'Could not read Gradle versionName.' }
    $versionName = $Matches[1]
    if ($buildGradle -notmatch 'versionCode (\d+)') { throw 'Could not read Gradle versionCode.' }
    $versionCode = $Matches[1]
    if ($versionName -ne $version -or $versionCode -ne ($version -replace '\.', '')) {
        throw "Version metadata is inconsistent ($version / $versionName / $versionCode)."
    }

    $env:JAVA_HOME = 'C:\Program Files\Java\jdk-21'
    $env:ANDROID_HOME = 'D:\dev\android-sdk'
    $env:ANDROID_SDK_ROOT = 'D:\dev\android-sdk'
    $env:NODE_ENV = 'production'
    $env:EXPO_PUBLIC_TUBEPULSE_API_URL = ''
    $env:EXPO_PUBLIC_TUBEPULSE_API_FALLBACK_URL = ''
    $env:EXPO_PUBLIC_TUBEPULSE_UPDATE_DEMO = ''
    $env:EXPO_PUBLIC_TUBEPULSE_UPDATE_DEMO_TAG = ''

    if ($Mode -eq 'Preview') {
        $parts = $version.Split('.')
        $demoPatch = ([int]$parts[2]) + 1
        $env:EXPO_PUBLIC_TUBEPULSE_UPDATE_DEMO = '1'
        $env:EXPO_PUBLIC_TUBEPULSE_UPDATE_DEMO_TAG = "v$($parts[0]).$($parts[1]).$demoPatch"
    }

    if ($Mode -eq 'Preflight') {
        Write-RunnerStatus -State 'running' -Stage 'gradle-preflight'
        $gradle = Join-Path $repo 'android\gradlew.bat'
        $process = Start-Process -FilePath $gradle -ArgumentList @('help', '--no-daemon') -WorkingDirectory $repo -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $logPath -RedirectStandardError $errorLogPath
        if ($process.ExitCode -ne 0) {
            throw "Gradle preflight failed with exit code $($process.ExitCode)."
        }
        Write-RunnerStatus -State 'completed' -Stage 'preflight-complete'
        exit 0
    }

    Write-RunnerStatus -State 'running' -Stage 'clean'
    foreach ($relative in @('android\app\.cxx', 'android\app\build', 'android\build')) {
        $target = [System.IO.Path]::GetFullPath((Join-Path $repo $relative))
        if (-not $target.StartsWith(($repo + [System.IO.Path]::DirectorySeparatorChar), [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing cleanup outside repository: $target"
        }
        if (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Recurse -Force
        }
    }

    Write-RunnerStatus -State 'running' -Stage 'build'
    $buildScript = Join-Path $repo 'build-and-release.ps1'
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $buildScript, '-BuildOnly')
    $process = Start-Process -FilePath $powershell -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $logPath -RedirectStandardError $errorLogPath
    if ($process.ExitCode -ne 0) {
        throw "Android build failed with exit code $($process.ExitCode)."
    }

    $officialPath = Join-Path $repo "dist\TubePulse-v$version.apk"
    if (-not (Test-Path -LiteralPath $officialPath)) {
        throw "Expected APK was not produced: $officialPath"
    }
    $outputPath = $officialPath
    if ($Mode -eq 'Preview') {
        $stamp = [DateTimeOffset]::Now.ToString('yyyyMMdd-HHmmss')
        $outputPath = Join-Path $repo "dist\TubePulse-v$version-preview-$stamp.apk"
        Copy-Item -LiteralPath $officialPath -Destination $outputPath
    }
    $sha256 = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash
    Write-RunnerStatus -State 'completed' -Stage 'build-complete' -OutputPath $outputPath -Sha256 $sha256
    exit 0
}
catch {
    try {
        Write-RunnerStatus -State 'failed' -Stage 'error' -ExitCode 1 -Message $_.Exception.Message
    }
    catch {}
    exit 1
}
finally {
    if ($hasMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
