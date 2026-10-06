[CmdletBinding()]
param(
    [switch]$OpenDashboard,
    [switch]$NoOpen,
    [ValidateRange(0, 300)]
    [int]$WaitSeconds = 90,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$monitoringDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $monitoringDirectory '..'))
$composePath = [IO.Path]::GetFullPath((Join-Path $monitoringDirectory 'compose.yaml'))
$localEnvPath = [IO.Path]::GetFullPath((Join-Path $monitoringDirectory '.env.local'))
$logsDirectory = [IO.Path]::GetFullPath((Join-Path $repoRoot 'logs'))
$tokenPath = [IO.Path]::GetFullPath((Join-Path $repoRoot 'self-host\secrets\cloudflare-read-token.txt'))
$dashboardUrl = 'http://127.0.0.1:3000/d/tubepulse-operations/tubepulse-operations'

function Invoke-Native([string[]]$Arguments) {
    $previous = $ErrorActionPreference
    try {
        # Windows PowerShell can promote ordinary Docker progress on stderr to
        # NativeCommandError when Stop is active. The process exit code is the
        # authoritative success signal for Docker CLI calls.
        $ErrorActionPreference = 'Continue'
        & $docker.Source @Arguments 2>&1 | ForEach-Object { Write-Host $_ }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($exitCode -ne 0) { throw "Docker command failed with exit code $exitCode." }
}

function Assert-ChildPath([string]$Parent, [string]$Child) {
    $prefix = $Parent.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $Child.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Resolved path escaped the repository: $Child"
    }
}

foreach ($path in @($monitoringDirectory, $composePath, $localEnvPath, $logsDirectory, $tokenPath)) {
    Assert-ChildPath -Parent $repoRoot -Child $path
}
if (-not (Test-Path -LiteralPath $composePath -PathType Leaf)) { throw 'Monitoring Compose file is missing.' }

$grafanaBindAddress = '127.0.0.1'
if (Test-Path -LiteralPath $localEnvPath -PathType Leaf) {
    $bindLine = Get-Content -LiteralPath $localEnvPath | Where-Object { $_ -match '^\s*TUBEPULSE_MONITORING_GRAFANA_BIND_ADDRESS\s*=' } | Select-Object -Last 1
    if ($bindLine) { $grafanaBindAddress = ($bindLine -split '=', 2)[1].Trim() }
}
if ($grafanaBindAddress -notin @('127.0.0.1', '0.0.0.0')) {
    throw 'Grafana bind address must be 127.0.0.1 or 0.0.0.0.'
}
$composeArguments = @('compose')
if (Test-Path -LiteralPath $localEnvPath -PathType Leaf) {
    $composeArguments += @('--env-file', $localEnvPath)
}
$composeArguments += @('-f', $composePath)

if ($DryRun) {
    [pscustomobject]@{
        DryRun = $true
        ComposeFile = $composePath
        LogsDirectory = $logsDirectory
        TokenPresent = (Test-Path -LiteralPath $tokenPath -PathType Leaf)
        DashboardUrl = $dashboardUrl
        GrafanaBindAddress = $grafanaBindAddress
        LoopbackOnly = ($grafanaBindAddress -eq '127.0.0.1')
        MutatedHost = $false
    } | ConvertTo-Json -Compress
    exit 0
}

if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    throw 'The ignored Account Analytics Read token file is missing.'
}
$docker = Get-Command docker.exe -ErrorAction SilentlyContinue
if ($null -eq $docker) { $docker = Get-Command docker -ErrorAction SilentlyContinue }
if ($null -eq $docker) { throw 'Docker CLI was not found on PATH.' }

[IO.Directory]::CreateDirectory((Join-Path $logsDirectory 'prometheus')) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $logsDirectory 'grafana')) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $logsDirectory 'snapshots')) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $logsDirectory 'collector')) | Out-Null

try {
    Invoke-Native -Arguments @('info', '--format', '{{.ServerVersion}}')
} catch {
    throw 'Docker engine is not ready.'
}
Invoke-Native -Arguments ($composeArguments + @('up', '-d', '--build'))

$shouldOpen = $OpenDashboard -and -not $NoOpen
if ($shouldOpen) {
    $deadline = [DateTimeOffset]::Now.AddSeconds($WaitSeconds)
    do {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -Method Get -TimeoutSec 5
            if ([string]$health.database -eq 'ok') { break }
        } catch {}
        if ([DateTimeOffset]::Now -lt $deadline) { Start-Sleep -Seconds 2 }
    } while ([DateTimeOffset]::Now -lt $deadline)
    Start-Process $dashboardUrl | Out-Null
}

[pscustomobject]@{
    Started = $true
    DashboardUrl = $dashboardUrl
    Opened = $shouldOpen
} | ConvertTo-Json -Compress
