[CmdletBinding()]
param(
    [int]$RestartDelaySeconds = 5
)

$ErrorActionPreference = 'Stop'
$selfHostDirectory = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $selfHostDirectory 'src\cli.mjs'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js was not found on PATH. Install Node.js 20 or newer first.'
}

Set-Location -LiteralPath $selfHostDirectory

while ($true) {
    Write-Host "[$(Get-Date -Format o)] Starting TubePulse self-host preview"
    & node $cliPath serve
    $exitCode = $LASTEXITCODE
    Write-Warning "TubePulse exited with code $exitCode; restarting in $RestartDelaySeconds seconds"
    Start-Sleep -Seconds $RestartDelaySeconds
}
