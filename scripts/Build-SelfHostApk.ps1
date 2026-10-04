[CmdletBinding()]
param(
    [Parameter()]
    [string]$ApiUrl = 'http://192.168.7.216:8788',

    [Parameter()]
    [string]$OutputDirectory,

    [Parameter()]
    [string]$JavaHome,

    [Parameter()]
    [switch]$UseTcpJavaPipeFallback
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repoRoot 'dist'
} elseif (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) {
    $OutputDirectory = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
}

$parsedUrl = $null
if (-not [System.Uri]::TryCreate($ApiUrl, [System.UriKind]::Absolute, [ref]$parsedUrl) -or
    $parsedUrl.Scheme -notin @('http', 'https') -or
    [string]::IsNullOrWhiteSpace($parsedUrl.Host) -or
    -not [string]::IsNullOrEmpty($parsedUrl.UserInfo) -or
    -not [string]::IsNullOrEmpty($parsedUrl.Query) -or
    -not [string]::IsNullOrEmpty($parsedUrl.Fragment)) {
    throw 'ApiUrl must be an absolute http(s) URL without credentials, query, or fragment.'
}
$normalizedApiUrl = $parsedUrl.AbsoluteUri.TrimEnd('/')

$appConfigPath = Join-Path $repoRoot 'app.json'
$appConfig = Get-Content -LiteralPath $appConfigPath -Raw | ConvertFrom-Json
$version = [string]$appConfig.expo.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw 'app.json contains an unexpected Expo version.'
}

$sourceGoogleServices = Join-Path $repoRoot 'google-services.json'
if (-not (Test-Path -LiteralPath $sourceGoogleServices -PathType Leaf)) {
    $sourceGoogleServices = Join-Path $repoRoot 'android\app\google-services.json'
}
if (-not (Test-Path -LiteralPath $sourceGoogleServices -PathType Leaf)) {
    throw 'google-services.json is required to assemble the local test APK.'
}

$variantGoogleServices = Join-Path $repoRoot 'android\app\src\selfhost\google-services.json'
if (Test-Path -LiteralPath $variantGoogleServices) {
    throw "Refusing to overwrite existing variant Firebase config: $variantGoogleServices"
}

$googleConfig = Get-Content -LiteralPath $sourceGoogleServices -Raw | ConvertFrom-Json
$productionClient = @($googleConfig.client | Where-Object {
    $_.client_info.android_client_info.package_name -eq 'com.tubepulse.app'
}) | Select-Object -First 1
if ($null -eq $productionClient) {
    throw 'The source Firebase config has no com.tubepulse.app Android client.'
}

# Deep-copy just the selected non-secret client metadata and rewrite the package
# so the Gradle plugin can generate resources for the isolated test build. This
# does not register a Firebase app and therefore does not promise working FCM.
$variantConfig = $googleConfig | ConvertTo-Json -Depth 100 | ConvertFrom-Json
$variantClient = $productionClient | ConvertTo-Json -Depth 100 | ConvertFrom-Json
$variantClient.client_info.android_client_info.package_name = 'com.tubepulse.app.selfhost'
$variantConfig.client = @($variantClient)

$previousPrimary = [Environment]::GetEnvironmentVariable('EXPO_PUBLIC_TUBEPULSE_API_URL', 'Process')
$previousFallback = [Environment]::GetEnvironmentVariable('EXPO_PUBLIC_TUBEPULSE_FALLBACK_API_URL', 'Process')
$previousPreview = [Environment]::GetEnvironmentVariable('EXPO_PUBLIC_TUBEPULSE_PREVIEW', 'Process')
$previousPreviewDefault = [Environment]::GetEnvironmentVariable('EXPO_PUBLIC_TUBEPULSE_PREVIEW_DEFAULT_URL', 'Process')
$previousPreviewPush = [Environment]::GetEnvironmentVariable('EXPO_PUBLIC_TUBEPULSE_PREVIEW_PUSH_ENABLED', 'Process')
$previousNodeEnv = [Environment]::GetEnvironmentVariable('NODE_ENV', 'Process')
$previousJavaHome = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'Process')
$previousJavaToolOptions = [Environment]::GetEnvironmentVariable('JAVA_TOOL_OPTIONS', 'Process')

if ([string]::IsNullOrWhiteSpace($JavaHome) -and [string]::IsNullOrWhiteSpace($previousJavaHome)) {
    $microsoftJdkRoot = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft'
    $JavaHome = Get-ChildItem -LiteralPath $microsoftJdkRoot -Directory -Filter 'jdk-17*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\java.exe') } |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not [string]::IsNullOrWhiteSpace($JavaHome)) {
    $JavaHome = [System.IO.Path]::GetFullPath($JavaHome)
    if (-not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin\java.exe') -PathType Leaf)) {
        throw "JavaHome does not contain bin\\java.exe: $JavaHome"
    }
}

try {
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $variantJson = $variantConfig | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText($variantGoogleServices, $variantJson, $utf8NoBom)

    # This variant selects its endpoint at runtime. ApiUrl is only a first-run
    # form suggestion; it is never contacted until the user tests and accepts it.
    $env:EXPO_PUBLIC_TUBEPULSE_API_URL = ''
    $env:EXPO_PUBLIC_TUBEPULSE_FALLBACK_API_URL = ''
    $env:EXPO_PUBLIC_TUBEPULSE_PREVIEW = '1'
    $env:EXPO_PUBLIC_TUBEPULSE_PREVIEW_DEFAULT_URL = $normalizedApiUrl
    $env:EXPO_PUBLIC_TUBEPULSE_PREVIEW_PUSH_ENABLED = '0'
    $env:NODE_ENV = 'production'
    if (-not [string]::IsNullOrWhiteSpace($JavaHome)) {
        $env:JAVA_HOME = $JavaHome
    }
    if ($UseTcpJavaPipeFallback) {
        $tcpFallbackPath = Join-Path ([System.IO.Path]::GetPathRoot($repoRoot)) 'tubepulse-java-no-unix-sockets'
        if (Test-Path -LiteralPath $tcpFallbackPath) {
            throw "The Java TCP fallback path must not exist: $tcpFallbackPath"
        }
        $tcpFallbackOption = "-Djdk.net.unixdomain.tmpdir=$tcpFallbackPath"
        $javaToolOptions = @($previousJavaToolOptions, $tcpFallbackOption) |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        $env:JAVA_TOOL_OPTIONS = [string]::Join(' ', $javaToolOptions)
    }

    Push-Location (Join-Path $repoRoot 'android')
    try {
        & .\gradlew.bat --no-daemon :app:assembleSelfhost
        if ($LASTEXITCODE -ne 0) {
            throw "Gradle failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }

    $builtApk = Join-Path $repoRoot 'android\app\build\outputs\apk\selfhost\app-selfhost.apk'
    if (-not (Test-Path -LiteralPath $builtApk -PathType Leaf)) {
        throw "Gradle reported success but the expected APK was not created: $builtApk"
    }

    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    $destination = Join-Path $OutputDirectory "TubePulse-Preview-$version-debug.apk"
    Copy-Item -LiteralPath $builtApk -Destination $destination -Force
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $apkStream = [System.IO.File]::OpenRead($destination)
    try {
        $hashBytes = $sha256.ComputeHash($apkStream)
        $hash = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '')
    } finally {
        $apkStream.Dispose()
        $sha256.Dispose()
    }
    $size = (Get-Item -LiteralPath $destination).Length

    Write-Output "APK=$destination"
    Write-Output "SIZE_BYTES=$size"
    Write-Output "SHA256=$hash"
    Write-Output "PREVIEW_DEFAULT_URL=$normalizedApiUrl"
    Write-Output 'INITIAL_ENDPOINT=unconfigured (health test and explicit acceptance required)'
    Write-Output 'PUSH_ENABLED=false (null token pilot)'
} finally {
    [Environment]::SetEnvironmentVariable('EXPO_PUBLIC_TUBEPULSE_API_URL', $previousPrimary, 'Process')
    [Environment]::SetEnvironmentVariable('EXPO_PUBLIC_TUBEPULSE_FALLBACK_API_URL', $previousFallback, 'Process')
    [Environment]::SetEnvironmentVariable('EXPO_PUBLIC_TUBEPULSE_PREVIEW', $previousPreview, 'Process')
    [Environment]::SetEnvironmentVariable('EXPO_PUBLIC_TUBEPULSE_PREVIEW_DEFAULT_URL', $previousPreviewDefault, 'Process')
    [Environment]::SetEnvironmentVariable('EXPO_PUBLIC_TUBEPULSE_PREVIEW_PUSH_ENABLED', $previousPreviewPush, 'Process')
    [Environment]::SetEnvironmentVariable('NODE_ENV', $previousNodeEnv, 'Process')
    [Environment]::SetEnvironmentVariable('JAVA_HOME', $previousJavaHome, 'Process')
    [Environment]::SetEnvironmentVariable('JAVA_TOOL_OPTIONS', $previousJavaToolOptions, 'Process')
    Remove-Item -LiteralPath $variantGoogleServices -Force -ErrorAction SilentlyContinue
}
