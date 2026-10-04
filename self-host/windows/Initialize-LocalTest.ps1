[CmdletBinding()]
param(
    [ValidateSet('127.0.0.1', '0.0.0.0')]
    [string]$PublishAddress = '127.0.0.1',

    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$selfHostDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $selfHostDir '..'))
$sourceSecretsDir = Join-Path $repoRoot 'secrets'
$targetSecretsDir = Join-Path $selfHostDir 'secrets'
$targetEnv = Join-Path $selfHostDir '.env'
$sourceFirebase = Join-Path $sourceSecretsDir 'fcm-service-account.json'
$sourceYoutube = Join-Path $sourceSecretsDir 'youtube.env'

foreach ($requiredPath in @($sourceFirebase, $sourceYoutube)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required local source secret is missing: $requiredPath"
    }
}

$firebase = Get-Content -LiteralPath $sourceFirebase -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$firebase.private_key) -or
    [string]::IsNullOrWhiteSpace([string]$firebase.client_email)) {
    throw 'The local Firebase service-account JSON is incomplete.'
}

$youtubeValue = $null
foreach ($line in Get-Content -LiteralPath $sourceYoutube) {
    if ($line -match '^\s*(?:export\s+)?YOUTUBE_API_KEY\s*=\s*(.+?)\s*$') {
        $youtubeValue = $matches[1].Trim()
        if ($youtubeValue.Length -ge 2 -and
            (($youtubeValue.StartsWith('"') -and $youtubeValue.EndsWith('"')) -or
             ($youtubeValue.StartsWith("'") -and $youtubeValue.EndsWith("'")))) {
            $youtubeValue = $youtubeValue.Substring(1, $youtubeValue.Length - 2)
        }
        break
    }
}
if ([string]::IsNullOrWhiteSpace($youtubeValue)) {
    throw 'YOUTUBE_API_KEY was not found in the local youtube.env file.'
}

$managedFiles = @(
    $targetEnv,
    (Join-Path $targetSecretsDir 'firebase.json'),
    (Join-Path $targetSecretsDir 'youtube-api-key.txt'),
    (Join-Path $targetSecretsDir 'admin-token.txt')
)
if (-not $Force) {
    $existing = @($managedFiles | Where-Object { Test-Path -LiteralPath $_ })
    if ($existing.Count -gt 0) {
        throw 'Local test configuration already exists. Re-run with -Force only if replacing it is intentional.'
    }
}

New-Item -ItemType Directory -Path $targetSecretsDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $selfHostDir 'data') -Force | Out-Null

$adminBytes = [byte[]]::new(48)
$randomNumberGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $randomNumberGenerator.GetBytes($adminBytes)
} finally {
    $randomNumberGenerator.Dispose()
}
$adminToken = [Convert]::ToBase64String($adminBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

Copy-Item -LiteralPath $sourceFirebase -Destination (Join-Path $targetSecretsDir 'firebase.json') -Force
[System.IO.File]::WriteAllText((Join-Path $targetSecretsDir 'youtube-api-key.txt'), "$youtubeValue`n", $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $targetSecretsDir 'admin-token.txt'), "$adminToken`n", $utf8NoBom)

$envText = @"
# Generated local standalone test configuration. Never commit this file.
TUBEPULSE_MODE=standalone
TUBEPULSE_HOST=0.0.0.0
TUBEPULSE_PORT=8788
TUBEPULSE_DATA_DIR=/data
TUBEPULSE_PUBLISH_ADDRESS=$PublishAddress
TUBEPULSE_ADMIN_TOKEN_FILE=/run/secrets/tubepulse/admin-token.txt
FIREBASE_SERVICE_ACCOUNT_FILE=/run/secrets/tubepulse/firebase.json
YOUTUBE_API_KEY_FILE=/run/secrets/tubepulse/youtube-api-key.txt
TUBEPULSE_AUTO_TAKEOVER=false
TUBEPULSE_CLOUDFLARE_WRITE_ENABLED=false
TUBEPULSE_SYNC_AUTO_PUSH=false
TUBEPULSE_ENABLE_COMMUNITY_POSTS=true
"@
[System.IO.File]::WriteAllText($targetEnv, $envText, $utf8NoBom)

Write-Output "Created ignored standalone test configuration at $targetEnv"
Write-Output "Copied credentials into ignored files under $targetSecretsDir"
Write-Output 'No Cloudflare credentials were copied or configured.'
Write-Output "Docker publish address: $PublishAddress"
