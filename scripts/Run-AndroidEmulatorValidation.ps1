[CmdletBinding()]
param(
    [Parameter()]
    [string]$ApiUrl = 'http://10.0.2.2:8788',

    [Parameter()]
    [switch]$ValidateOnly,

    [Parameter()]
    [switch]$NoInstall,

    [Parameter()]
    [switch]$AllowProductionEndpoint
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$productionOrigin = 'https://tubepulse-api.jimothyoakley55.workers.dev'
$parsed = $null
if (-not [System.Uri]::TryCreate($ApiUrl, [System.UriKind]::Absolute, [ref]$parsed) -or
    $parsed.Scheme -notin @('http', 'https') -or
    -not [string]::IsNullOrEmpty($parsed.UserInfo) -or
    -not [string]::IsNullOrEmpty($parsed.Query) -or
    -not [string]::IsNullOrEmpty($parsed.Fragment)) {
    throw 'ApiUrl must be an absolute http(s) origin without credentials, query, or fragment.'
}
$origin = $parsed.AbsoluteUri.TrimEnd('/')
$isolatedHosts = @('10.0.2.2', '127.0.0.1', 'localhost')
$isIsolated = $isolatedHosts -contains $parsed.Host
$overrideLatch = [Environment]::GetEnvironmentVariable('TUBEPULSE_ALLOW_EMULATOR_PRODUCTION_REGISTRATION', 'Process')
if (-not $isIsolated) {
    if (-not $AllowProductionEndpoint -or $overrideLatch -ne 'I_ACCEPT_TEST_DATA_POLLUTION') {
        throw "Emulator validation is fail-closed: '$origin' is not an isolated emulator/loopback endpoint. Use 10.0.2.2 or localhost. A production exception requires both -AllowProductionEndpoint and TUBEPULSE_ALLOW_EMULATOR_PRODUCTION_REGISTRATION=I_ACCEPT_TEST_DATA_POLLUTION."
    }
}
if ($origin -eq $productionOrigin -and -not $isIsolated -and -not $AllowProductionEndpoint) {
    throw 'The production TubePulse Worker is forbidden for emulator validation.'
}

Write-Output "EMULATOR_ENDPOINT=$origin"
Write-Output 'PACKAGE=com.tubepulse.app.selfhost'
Write-Output 'PREVIEW_MODE=true'
Write-Output 'PUSH_ENABLED=false'
Write-Output "PRODUCTION_OVERRIDE=$([bool]$AllowProductionEndpoint)"
if ($ValidateOnly) { return }

& (Join-Path $PSScriptRoot 'Build-SelfHostApk.ps1') -ApiUrl $origin -ReactNativeArchitecture x86_64
if ($LASTEXITCODE -ne 0) { throw "Isolated emulator APK build failed with exit code $LASTEXITCODE." }
if ($NoInstall) { return }

$adb = Join-Path 'D:\dev\android-sdk' 'platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adb -PathType Leaf)) { throw "adb was not found at $adb" }
$emulators = @(& $adb devices | Select-String '^emulator-[0-9]+\s+device$' | ForEach-Object {
    ($_ -split '\s+')[0]
})
if ($emulators.Count -ne 1) { throw "Expected exactly one running Android emulator; found $($emulators.Count)." }
$version = [string](Get-Content -LiteralPath (Join-Path $repoRoot 'app.json') -Raw | ConvertFrom-Json).expo.version
$apk = Join-Path $repoRoot "dist\TubePulse-Preview-$version-debug.apk"
& $adb -s $emulators[0] install -r $apk
if ($LASTEXITCODE -ne 0) { throw "adb install failed with exit code $LASTEXITCODE." }
Write-Output "INSTALLED_ON=$($emulators[0])"
