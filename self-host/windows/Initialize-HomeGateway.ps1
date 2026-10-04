[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$TunnelId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{32}$')]
    [string]$AccountId,

    [switch]$UseCloudflareApiTokenEnvironment,

    [switch]$RotateConnectorToken
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$selfHostDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$secretDir = [IO.Path]::GetFullPath((Join-Path $selfHostDir 'secrets'))
$envPath = [IO.Path]::GetFullPath((Join-Path $selfHostDir '.env.gateway'))
$envTemplatePath = [IO.Path]::GetFullPath((Join-Path $selfHostDir 'compose.gateway.env.example'))

if ($secretDir.TrimEnd('\') -ne (Join-Path $selfHostDir 'secrets').TrimEnd('\')) {
    throw 'Resolved secret directory escaped self-host.'
}

function Set-RestrictedFileAcl {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $LiteralPath '/inheritance:r' '/grant:r' `
        "${identity}:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to apply the restrictive file ACL.' }

    $acl = Get-Acl -LiteralPath $LiteralPath
    $unexpected = @($acl.Access | Where-Object {
        $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin @(
            $identity,
            'NT AUTHORITY\SYSTEM',
            'BUILTIN\Administrators'
        )
    })
    if (-not $acl.AreAccessRulesProtected -or $unexpected.Count -gt 0) {
        throw 'The restrictive file ACL could not be verified.'
    }
}

function Write-NewRestrictedSecret {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $path = [IO.Path]::GetFullPath((Join-Path $secretDir $Name))
    if ([IO.Path]::GetDirectoryName($path).TrimEnd('\') -ne $secretDir.TrimEnd('\')) {
        throw 'Secret destination escaped the expected directory.'
    }
    if (Test-Path -LiteralPath $path) {
        $existing = [IO.File]::ReadAllText($path).Trim()
        if ($existing -ne $Value) {
            throw "A different $Name already exists; refusing to overwrite it."
        }
    } else {
        [IO.File]::WriteAllText($path, $Value, (New-Object Text.UTF8Encoding($false)))
    }
    Set-RestrictedFileAcl -LiteralPath $path
    return $path
}

function New-RandomSecret {
    $bytes = New-Object byte[] 48
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Read-ConnectorTokenFromClipboard {
    $clipboard = Get-Clipboard -Raw
    if ([string]::IsNullOrWhiteSpace($clipboard)) {
        throw 'The clipboard is empty; copy the Docker connector command from the expected tunnel first.'
    }
    if ($clipboard -notmatch '(?is)docker\s+run.+cloudflare/cloudflared.+tunnel.+run') {
        throw 'The clipboard does not contain a cloudflared Docker connector command.'
    }
    $match = [regex]::Match(
        $clipboard,
        '(?i)(?:--token(?:=|\s+))(?<quote>["'']?)(?<token>[A-Za-z0-9._~+\-/=]+)\k<quote>'
    )
    if (-not $match.Success -or $match.Groups['token'].Value.Length -lt 40) {
        throw 'The clipboard command does not contain an extractable connector token.'
    }
    return $match.Groups['token'].Value
}

function Assert-ConnectorIdentity {
    param([Parameter(Mandatory = $true)][string]$Token)

    try {
        $base64 = $Token.Replace('-', '+').Replace('_', '/')
        while (($base64.Length % 4) -ne 0) { $base64 += '=' }
        $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($base64)) | ConvertFrom-Json
    } catch {
        throw 'The connector token payload could not be validated.'
    }
    if ([string]$payload.t -ne $TunnelId -or [string]$payload.a -ne $AccountId) {
        throw 'The connector token does not belong to the expected tunnel and account.'
    }
}

[IO.Directory]::CreateDirectory($secretDir) | Out-Null

$connectorToken = Read-ConnectorTokenFromClipboard
Assert-ConnectorIdentity -Token $connectorToken

$canaryPath = Join-Path $secretDir 'canary-device.json'
if (-not (Test-Path -LiteralPath $canaryPath)) {
    throw 'Missing ignored secrets/canary-device.json; provision the full canary fingerprint before continuing.'
}
$canary = Get-Content -LiteralPath $canaryPath -Raw | ConvertFrom-Json
if ([string]$canary.deviceFingerprintSha256 -notmatch '^[a-f0-9]{64}$') {
    throw 'canary-device.json does not contain a full lowercase SHA-256 fingerprint.'
}

$cloudflareTokenPath = Join-Path $secretDir 'cloudflare-read-token.txt'
if ($UseCloudflareApiTokenEnvironment) {
    if ([string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) {
        throw 'CLOUDFLARE_API_TOKEN is not available in this process.'
    }
} elseif (-not (Test-Path -LiteralPath $cloudflareTokenPath)) {
    throw 'Missing cloudflare-read-token.txt. Supply a KV read-only token or explicitly use -UseCloudflareApiTokenEnvironment.'
}
if (-not (Test-Path -LiteralPath $envTemplatePath)) {
    throw 'Missing tracked gateway environment template.'
}

$connectorPath = Join-Path $secretDir 'cloudflared-tunnel-token.txt'
if (Test-Path -LiteralPath $connectorPath) {
    $existingConnector = [IO.File]::ReadAllText($connectorPath).Trim()
    if ($existingConnector -ne $connectorToken) {
        if (-not $RotateConnectorToken) {
            throw 'A different connector token exists; use -RotateConnectorToken only after rotating it in Cloudflare.'
        }
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backupPath = Join-Path $secretDir "cloudflared-tunnel-token.$stamp.bak"
        if (Test-Path -LiteralPath $backupPath) { throw 'Connector-token backup destination already exists.' }
        Move-Item -LiteralPath $connectorPath -Destination $backupPath
        Set-RestrictedFileAcl -LiteralPath $backupPath
    }
}
$connectorPath = Write-NewRestrictedSecret -Name 'cloudflared-tunnel-token.txt' -Value $connectorToken

$adminPath = Join-Path $secretDir 'gateway-admin-token.txt'
if (-not (Test-Path -LiteralPath $adminPath)) {
    [void](Write-NewRestrictedSecret -Name 'gateway-admin-token.txt' -Value (New-RandomSecret))
} else {
    Set-RestrictedFileAcl -LiteralPath $adminPath
}

$gatewayPath = Join-Path $secretDir 'gateway-secret.txt'
if (-not (Test-Path -LiteralPath $gatewayPath)) {
    [void](Write-NewRestrictedSecret -Name 'gateway-secret.txt' -Value (New-RandomSecret))
} else {
    Set-RestrictedFileAcl -LiteralPath $gatewayPath
}

Set-RestrictedFileAcl -LiteralPath $canaryPath

if ($UseCloudflareApiTokenEnvironment) {
    [void](Write-NewRestrictedSecret -Name 'cloudflare-read-token.txt' -Value ($env:CLOUDFLARE_API_TOKEN).Trim())
} else {
    Set-RestrictedFileAcl -LiteralPath $cloudflareTokenPath
}

if (-not (Test-Path -LiteralPath $envPath)) {
    Copy-Item -LiteralPath $envTemplatePath -Destination $envPath
}
Set-RestrictedFileAcl -LiteralPath $envPath

foreach ($path in @($connectorPath, $adminPath, $gatewayPath, $canaryPath, $cloudflareTokenPath, $envPath)) {
    git -C ([IO.Path]::GetFullPath((Join-Path $selfHostDir '..'))) check-ignore --no-index --quiet -- $path
    if ($LASTEXITCODE -ne 0) { throw 'A generated local configuration file is not ignored by Git.' }
}

[pscustomobject]@{
    TunnelIdentityValidated = $true
    ConnectorTokenStored = $true
    GatewaySecretsReady = $true
    CanaryFingerprintPresent = $true
    CloudflareSyncTokenPresent = $true
    EnvironmentFile = $envPath
    SecretDirectory = $secretDir
    SecretsPrinted = $false
}
