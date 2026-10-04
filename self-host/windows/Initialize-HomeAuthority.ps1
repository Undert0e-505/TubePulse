[CmdletBinding()]
param(
    [ValidatePattern('^https://[^/]+(?:/)?$')]
    [string]$ApiUrl = 'https://tubepulse-api.jimothyoakley55.workers.dev'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$selfHostDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $selfHostDir '..'))
$secretDir = [IO.Path]::GetFullPath((Join-Path $selfHostDir 'secrets'))
$templatePath = [IO.Path]::GetFullPath((Join-Path $selfHostDir 'compose.authority.env.example'))
$envPath = [IO.Path]::GetFullPath((Join-Path $selfHostDir '.env.authority'))
$authoritySecretPath = [IO.Path]::GetFullPath((Join-Path $secretDir 'authority-secret.txt'))

if ([IO.Path]::GetDirectoryName($authoritySecretPath).TrimEnd('\') -ne $secretDir.TrimEnd('\')) {
    throw 'Authority secret path escaped self-host/secrets.'
}

function Set-RestrictedFileAcl {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $LiteralPath '/inheritance:r' '/grant:r' `
        "${identity}:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to apply a restrictive ACL.' }
}

if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) {
    throw 'Tracked authority environment template is missing.'
}
[IO.Directory]::CreateDirectory($secretDir) | Out-Null

if (-not (Test-Path -LiteralPath $authoritySecretPath)) {
    $bytes = New-Object byte[] 48
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    $secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [IO.File]::WriteAllText($authoritySecretPath, $secret, (New-Object Text.UTF8Encoding($false)))
}

$requiredSecrets = @(
    $authoritySecretPath,
    (Join-Path $secretDir 'cloudflare-scheduler-write-token.txt'),
    (Join-Path $secretDir 'cloudflared-tunnel-token.txt'),
    (Join-Path $secretDir 'firebase.json'),
    (Join-Path $secretDir 'youtube-api-key.txt')
)
foreach ($path in $requiredSecrets) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required ignored secret is missing: $([IO.Path]::GetFileName($path))"
    }
    Set-RestrictedFileAcl -LiteralPath $path
}

if (-not (Test-Path -LiteralPath $envPath)) {
    $content = [IO.File]::ReadAllText($templatePath)
    $content = $content.Replace('https://tubepulse-api.example.workers.dev', $ApiUrl.TrimEnd('/'))
    [IO.File]::WriteAllText($envPath, $content, (New-Object Text.UTF8Encoding($false)))
}
Set-RestrictedFileAcl -LiteralPath $envPath

foreach ($path in @($requiredSecrets + $envPath)) {
    & git -C $repoRoot check-ignore --no-index --quiet -- $path
    if ($LASTEXITCODE -ne 0) { throw 'A generated authority file is not ignored by Git.' }
}

[pscustomobject]@{
    AuthoritySecretReady = $true
    RequiredSecretFilesReady = $true
    EnvironmentReady = $true
    EnvironmentPath = $envPath
    SecretsPrinted = $false
}
