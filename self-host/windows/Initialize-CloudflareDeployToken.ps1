[CmdletBinding()]
param(
    [string]$DestinationName = 'cloudflare-authority-deploy-token.txt'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$selfHostDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $selfHostDir '..'))
$secretDir = [IO.Path]::GetFullPath((Join-Path $selfHostDir 'secrets'))
$destination = [IO.Path]::GetFullPath((Join-Path $secretDir $DestinationName))

if ([IO.Path]::GetDirectoryName($destination).TrimEnd('\') -ne $secretDir.TrimEnd('\')) {
    throw 'Deploy-token destination escaped self-host/secrets.'
}
if ([IO.Path]::GetFileName($destination) -ne $DestinationName) {
    throw 'Deploy-token destination must be a file directly inside self-host/secrets.'
}
if (Test-Path -LiteralPath $destination) {
    throw 'Deploy-token destination already exists; rotate it explicitly instead of overwriting it.'
}

$result = $null
$clipboardText = Get-Clipboard -Raw
try {
    $token = if ($null -eq $clipboardText) { '' } else { [string]$clipboardText }
    $token = $token.Trim()
    # Cloudflare API tokens are opaque printable strings. Reject whitespace,
    # shell metacharacters, implausibly short/long values, and multi-line input
    # without ever echoing the candidate.
    if ($token.Length -lt 32 -or $token.Length -gt 512 -or
        $token -notmatch '^[A-Za-z0-9._~-]+$') {
        throw 'Clipboard does not contain a plausible single Cloudflare API token.'
    }

    [IO.Directory]::CreateDirectory($secretDir) | Out-Null
    [IO.File]::WriteAllText($destination, $token, (New-Object Text.UTF8Encoding($false)))

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $destination '/inheritance:r' '/grant:r' `
        "${identity}:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
        throw 'Unable to apply a restrictive ACL to the deploy-token file.'
    }

    & git -C $repoRoot check-ignore --no-index --quiet -- $destination
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
        throw 'Deploy-token file is not ignored by Git.'
    }

    $result = [pscustomobject]@{
        TokenStored = $true
        ClipboardCleared = $true
        Destination = $destination
        SecretPrinted = $false
    }
} finally {
    # Clear even rejected input so a copied credential cannot remain available
    # to unrelated applications. This never writes the value to stdout.
    Set-Clipboard -Value ' '
}

$result
