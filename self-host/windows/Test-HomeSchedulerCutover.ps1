[CmdletBinding()]
param(
    [ValidateSet('Shadow', 'Cutover')]
    [string]$Phase = 'Shadow',
    [string]$RepositoryRoot
)

$ErrorActionPreference = 'Stop'
if (-not $RepositoryRoot) {
    $RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
$selfHost = Join-Path $RepositoryRoot 'self-host'
$compose = Join-Path $selfHost 'compose.scheduler.yaml'
$envFile = Join-Path $selfHost '.env.scheduler'
$dataDir = Join-Path $selfHost 'data-scheduler'
$ordinaryData = Join-Path $selfHost 'data'
$gatewayData = Join-Path $selfHost 'data-gateway'
$pilotData = Join-Path $selfHost 'data-pilot'

foreach ($required in @($compose, $envFile)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required scheduler configuration is missing: $required"
    }
}

$resolvedSelfHost = [IO.Path]::GetFullPath($selfHost)
$resolvedData = [IO.Path]::GetFullPath($dataDir)
if (-not $resolvedData.StartsWith($resolvedSelfHost + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Scheduler data directory resolves outside self-host.'
}
if ($resolvedData -in @([IO.Path]::GetFullPath($ordinaryData), [IO.Path]::GetFullPath($gatewayData), [IO.Path]::GetFullPath($pilotData))) {
    throw 'Scheduler data directory overlaps another TubePulse runtime.'
}

$dockerVersion = docker version --format '{{.Server.Version}}' 2>$null
if ($LASTEXITCODE -ne 0 -or -not $dockerVersion) {
    throw 'Docker engine is not reachable.'
}

docker compose --env-file $envFile -f $compose config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Scheduler Compose configuration is invalid.' }

$trackedSecrets = git -C $RepositoryRoot ls-files -- 'self-host/.env.scheduler' 'self-host/data-scheduler/**' 'self-host/secrets/**'
if ($trackedSecrets) { throw 'A scheduler environment, runtime-data, or secret path is tracked by Git.' }

$expected = @(
    @{ Name = 'tubepulse-rss-0'; Cron = '*/5 * * * *' },
    @{ Name = 'tubepulse-rss-1'; Cron = '*/5 * * * *' },
    @{ Name = 'tubepulse-rss-2'; Cron = '*/5 * * * *' },
    @{ Name = 'tubepulse-posts'; Cron = '* * * * *' },
    @{ Name = 'tubepulse-aux'; Cron = '* * * * *' }
)

[pscustomobject]@{
    Phase = $Phase
    DockerServer = $dockerVersion
    SchedulerData = $resolvedData
    ComposeValid = $true
    GitSecretPathsTracked = $false
    ExistingScheduledWorkers = ($expected | ForEach-Object { "$($_.Name)=$($_.Cron)" }) -join '; '
    LiveTriggerVerification = if ($Phase -eq 'Cutover') { 'REQUIRED: verify all five live trigger lists are empty and their final events have drained before activation' } else { 'Not required for read-only shadow' }
    ActivationAllowed = $false
} | Format-List

if ($Phase -eq 'Cutover') {
    Write-Warning 'This script is read-only. It does not disable triggers or activate Home.'
    Write-Warning 'Do not set the activation latch until live Cloudflare trigger removal and drain are independently verified.'
}
