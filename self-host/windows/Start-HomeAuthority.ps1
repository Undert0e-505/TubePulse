[CmdletBinding()]
param(
    [ValidateRange(0, 3600)]
    [int]$InitialDelaySeconds = 30,

    [ValidateRange(1, 100)]
    [int]$MaxAttempts = 12,

    [ValidateRange(1, 600)]
    [int]$InitialRetrySeconds = 10,

    [ValidateRange(1, 1800)]
    [int]$MaximumRetrySeconds = 120,

    [ValidateRange(2, 60)]
    [int]$ProgressMaximumAgeMinutes = 10,

    [ValidateRange(65536, 10485760)]
    [int]$MaximumLogBytes = 1048576,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$selfHostDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$composePath = [IO.Path]::GetFullPath((Join-Path $selfHostDirectory 'compose.authority.yaml'))
$environmentPath = [IO.Path]::GetFullPath((Join-Path $selfHostDirectory '.env.authority'))
$sourceDirectory = [IO.Path]::GetFullPath((Join-Path $selfHostDirectory 'src'))
$dataDirectory = [IO.Path]::GetFullPath((Join-Path $selfHostDirectory 'data-authority'))
$logPath = [IO.Path]::GetFullPath((Join-Path $dataDirectory 'startup-supervisor.log'))
$previousLogPath = [IO.Path]::GetFullPath((Join-Path $dataDirectory 'startup-supervisor.previous.log'))
$lockPath = [IO.Path]::GetFullPath((Join-Path $dataDirectory 'startup-supervisor.lock'))
$utf8NoBom = New-Object Text.UTF8Encoding($false)
$script:DockerCommand = $null
$script:DockerDesktopStarted = $false
$script:ContainerRestarted = $false

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child
    )
    $prefix = $Parent.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $Child.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Resolved path escaped the self-host directory: $Child"
    }
}

foreach ($path in @($composePath, $environmentPath, $sourceDirectory, $dataDirectory, $logPath, $previousLogPath, $lockPath)) {
    Assert-ChildPath -Parent $selfHostDirectory -Child $path
}
if (-not (Test-Path -LiteralPath $composePath -PathType Leaf)) {
    throw 'Tracked authority Compose file is missing.'
}
if ($DryRun) {
    [pscustomobject]@{
        DryRun = $true
        SelfHostDirectory = $selfHostDirectory
        ComposeFile = $composePath
        EnvironmentFile = $environmentPath
        EnvironmentPresent = (Test-Path -LiteralPath $environmentPath -PathType Leaf)
        DataDirectory = $dataDirectory
        InitialDelaySeconds = $InitialDelaySeconds
        MaxAttempts = $MaxAttempts
        MutatedHost = $false
    } | ConvertTo-Json -Compress
    exit 0
}

if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
    throw 'Ignored .env.authority is missing. Run Initialize-HomeAuthority.ps1 first.'
}

[IO.Directory]::CreateDirectory($dataDirectory) | Out-Null

function Rotate-LogIfNeeded {
    if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) { return }
    $length = (Get-Item -LiteralPath $logPath).Length
    if ($length -lt $MaximumLogBytes) { return }
    if (Test-Path -LiteralPath $previousLogPath) {
        Remove-Item -LiteralPath $previousLogPath -Force
    }
    Move-Item -LiteralPath $logPath -Destination $previousLogPath
}

function Write-SupervisorLog {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('INFO', 'WARN', 'ERROR')]
        [string]$Level,
        [Parameter(Mandatory = $true)][string]$Message
    )
    Rotate-LogIfNeeded
    $safe = ([string]$Message -replace '[\r\n]+', ' ').Trim()
    if ($safe.Length -gt 500) { $safe = $safe.Substring(0, 500) }
    $line = '{0} [{1}] {2}' -f [DateTimeOffset]::Now.ToString('o'), $Level, $safe
    [IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, $utf8NoBom)
}

function Get-DockerDesktopExecutable {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Docker\Docker\Docker Desktop.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    return $null
}

function Resolve-DockerCommand {
    $command = Get-Command docker.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) { $command = Get-Command docker -ErrorAction SilentlyContinue }
    if ($null -eq $command -or [string]::IsNullOrWhiteSpace([string]$command.Source)) {
        throw 'docker CLI was not found on PATH.'
    }
    return [string]$command.Source
}

function Invoke-Docker {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Docker/Compose writes ordinary progress messages to stderr. Capture them
        # and decide success from the native exit code instead of PowerShell's
        # ErrorRecord conversion.
        $ErrorActionPreference = 'Continue'
        $output = @(& $script:DockerCommand @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = @($output | ForEach-Object { [string]$_ }) }
}

function Test-DockerReady {
    $result = Invoke-Docker -Arguments @('info', '--format', '{{.ServerVersion}}')
    return $result.ExitCode -eq 0
}

function Start-DockerDesktopHidden {
    if ($script:DockerDesktopStarted) { return }
    $desktop = Get-DockerDesktopExecutable
    if ([string]::IsNullOrWhiteSpace($desktop)) {
        Write-SupervisorLog -Level 'ERROR' -Message 'Docker Desktop executable was not found.'
        return
    }
    Start-Process -FilePath $desktop -ArgumentList @('--minimized') -WindowStyle Hidden | Out-Null
    $script:DockerDesktopStarted = $true
    Write-SupervisorLog -Level 'INFO' -Message 'Requested minimized Docker Desktop startup.'
}

function Compose-Arguments {
    param([string[]]$Tail)
    return @('compose', '--env-file', $environmentPath, '-f', $composePath) + $Tail
}

function Invoke-ComposeUp {
    $result = Invoke-Docker -Arguments (Compose-Arguments -Tail @('up', '-d'))
    if ($result.ExitCode -ne 0) {
        Write-SupervisorLog -Level 'WARN' -Message 'Authority Compose up did not complete; Docker or a dependency may still be starting.'
        return $false
    }
    return $true
}

function Get-AuthorityContainerState {
    $ps = Invoke-Docker -Arguments (Compose-Arguments -Tail @('ps', '-q', 'home-authority'))
    if ($ps.ExitCode -ne 0 -or $ps.Output.Count -eq 0 -or [string]::IsNullOrWhiteSpace($ps.Output[0])) {
        return [pscustomobject]@{ Exists = $false; Running = $false; Health = 'missing' }
    }
    $containerId = $ps.Output[0].Trim()
    $inspect = Invoke-Docker -Arguments @(
        'inspect', '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', $containerId
    )
    if ($inspect.ExitCode -ne 0 -or $inspect.Output.Count -eq 0) {
        return [pscustomobject]@{ Exists = $true; Running = $false; Health = 'unknown' }
    }
    $parts = $inspect.Output[0].Trim().Split('|')
    return [pscustomobject]@{
        Exists = $true
        Running = $parts[0] -eq 'running'
        Health = if ($parts.Count -gt 1) { $parts[1] } else { 'none' }
    }
}

function Get-LocalAuthorityStatus {
    try {
        return Invoke-RestMethod -Uri 'http://127.0.0.1:8789/_tubepulse/status' -Method Get -TimeoutSec 10
    } catch {
        return $null
    }
}

function Get-RemoteAuthorityStatus {
    $sourceMount = '{0}:/app/self-host/src:ro' -f $sourceDirectory
    $result = Invoke-Docker -Arguments (Compose-Arguments -Tail @(
        'run', '--rm', '--no-deps', '--volume', $sourceMount,
        'home-authority', 'node', 'src/home-authority-cli.mjs', 'status'
    ))
    if ($result.ExitCode -ne 0 -or $result.Output.Count -eq 0) { return $null }
    $lines = @($result.Output)
    for ($index = $lines.Count - 1; $index -ge 0; $index--) {
        $line = $lines[$index]
        if ([string]::IsNullOrWhiteSpace($line) -or -not $line.Trim().StartsWith('{')) { continue }
        try { return ($line | ConvertFrom-Json) } catch { continue }
    }
    return $null
}

function Test-FreshTimestamp {
    param([object]$Value, [int]$MaximumAgeMinutes)
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $false }
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string]$Value, [ref]$parsed)) { return $false }
    $age = [DateTimeOffset]::Now - $parsed
    return $age.TotalMinutes -ge -1 -and $age.TotalMinutes -le $MaximumAgeMinutes
}

function Get-OptionalProperty {
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Evaluate-Authority {
    param([Parameter(Mandatory = $true)][object]$Local, [Parameter(Mandatory = $true)][object]$Remote)
    if ([string]$Local.service -ne 'unified-home-authority' -or [string]$Local.status -ne 'ready') {
        return [pscustomobject]@{ Success = $false; Category = 'local-liveness'; Message = 'Local authority status is not ready.' }
    }
    if ([string]$Local.authority.replication.status -ne 'current' -or $null -ne $Local.authority.transaction) {
        return [pscustomobject]@{ Success = $false; Category = 'authority-readiness'; Message = 'Local authority is stale or has an incomplete transaction.' }
    }
    if ($Remote.ok -ne $true -or [string]$Remote.backend.selected -ne 'd1' -or $Remote.backend.ready -ne $true) {
        return [pscustomobject]@{ Success = $false; Category = 'cloud-readiness'; Message = 'Remote D1 authority backend is not ready.' }
    }
    if ([string]$Remote.replication.status -ne 'current' -or $null -ne $Remote.transaction) {
        return [pscustomobject]@{ Success = $false; Category = 'coordinator-state'; Message = 'Remote authority is stale or has an incomplete transaction.' }
    }
    if ([int]$Remote.pendingBackupKeys -ne 0) {
        return [pscustomobject]@{ Success = $false; Category = 'coordinator-pending'; Message = 'Remote coordinator has pending backup keys; no automatic clearing is allowed.' }
    }
    if ([string]$Local.mode -eq 'standby') {
        return [pscustomobject]@{ Success = $true; Category = 'standby-current'; Message = 'Authority is current and intentionally in standby.' }
    }
    if ([string]$Local.mode -ne 'active' -or [string]$Local.scheduler.mode -ne 'active') {
        return [pscustomobject]@{ Success = $false; Category = 'scheduler-mode'; Message = 'Authority scheduler is not active.' }
    }
    $leaseHeld = [string](Get-OptionalProperty -Object $Local.scheduler.lease -Name 'state') -eq 'held'
    $minuteScheduledAt = Get-OptionalProperty -Object $Local.scheduler.lastMinuteJobs -Name 'scheduledAt'
    $sweepProgressAt = Get-OptionalProperty -Object $Local.scheduler.youtubeDataApi -Name 'lastGoodAt'
    if ($null -eq $sweepProgressAt) {
        $lastVideoCycle = Get-OptionalProperty -Object $Local.scheduler.youtubeDataApi -Name 'lastCycle'
        $sweepProgressAt = Get-OptionalProperty -Object $lastVideoCycle -Name 'finishedAt'
    }
    if ($null -eq $sweepProgressAt) {
        $sweepProgressAt = Get-OptionalProperty -Object $Local.scheduler.currentSweep -Name 'startedAt'
    }
    if ($null -eq $sweepProgressAt) {
        $sweepProgressAt = Get-OptionalProperty -Object $Local.scheduler.lastSweep -Name 'finishedAt'
    }
    $minuteFresh = Test-FreshTimestamp -Value $minuteScheduledAt -MaximumAgeMinutes $ProgressMaximumAgeMinutes
    $sweepFresh = Test-FreshTimestamp -Value $sweepProgressAt -MaximumAgeMinutes $ProgressMaximumAgeMinutes
    $recentStart = Test-FreshTimestamp -Value $Local.scheduler.startedAt -MaximumAgeMinutes $ProgressMaximumAgeMinutes
    if (-not $leaseHeld -or -not $minuteFresh -or (-not $sweepFresh -and -not $recentStart)) {
        return [pscustomobject]@{ Success = $false; Category = 'scheduler-progress'; Message = 'Scheduler lease or aligned-cycle progress is stale.' }
    }
    return [pscustomobject]@{ Success = $true; Category = 'active-current'; Message = 'Authority and scheduler are current and progressing.' }
}

$lockStream = $null
try {
    try {
        $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] {
        Write-SupervisorLog -Level 'INFO' -Message 'Another startup supervisor instance already owns the lock; exiting.'
        exit 0
    }

    $script:DockerCommand = Resolve-DockerCommand
    Write-SupervisorLog -Level 'INFO' -Message 'Home authority startup supervisor began.'
    if ($InitialDelaySeconds -gt 0) { Start-Sleep -Seconds $InitialDelaySeconds }

    $retrySeconds = $InitialRetrySeconds
    $lastCategory = 'not-started'
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        if (-not (Test-DockerReady)) {
            $lastCategory = 'docker-not-ready'
            Start-DockerDesktopHidden
            Write-SupervisorLog -Level 'WARN' -Message "Attempt ${attempt}: Docker engine is not ready."
        } elseif (-not (Invoke-ComposeUp)) {
            $lastCategory = 'compose-not-ready'
        } else {
            $container = Get-AuthorityContainerState
            if (-not $container.Exists -or -not $container.Running) {
                $lastCategory = 'container-not-running'
                Write-SupervisorLog -Level 'WARN' -Message "Attempt ${attempt}: authority container is not running."
            } elseif ($container.Health -eq 'unhealthy') {
                $lastCategory = 'container-unhealthy'
                Write-SupervisorLog -Level 'WARN' -Message "Attempt ${attempt}: authority liveness health is unhealthy."
                if (-not $script:ContainerRestarted -and $attempt -gt 1) {
                    $restart = Invoke-Docker -Arguments (Compose-Arguments -Tail @('restart', 'home-authority'))
                    $script:ContainerRestarted = $restart.ExitCode -eq 0
                    if ($script:ContainerRestarted) {
                        Write-SupervisorLog -Level 'WARN' -Message 'Performed one bounded restart for a proven container liveness failure.'
                    }
                }
            } else {
                $local = Get-LocalAuthorityStatus
                if ($null -eq $local) {
                    $lastCategory = 'local-status-unavailable'
                    Write-SupervisorLog -Level 'WARN' -Message "Attempt ${attempt}: local authority status is unavailable."
                } else {
                    $remote = Get-RemoteAuthorityStatus
                    if ($null -eq $remote) {
                        $lastCategory = 'cloudflare-not-ready'
                        Write-SupervisorLog -Level 'WARN' -Message "Attempt ${attempt}: signed coordinator status is unavailable; preserving containers and retrying."
                    } else {
                        $evaluation = Evaluate-Authority -Local $local -Remote $remote
                        $lastCategory = $evaluation.Category
                        if ($evaluation.Success) {
                            Write-SupervisorLog -Level 'INFO' -Message $evaluation.Message
                            exit 0
                        }
                        Write-SupervisorLog -Level 'WARN' -Message "Attempt ${attempt}: $($evaluation.Message)"
                    }
                }
            }
        }

        if ($attempt -lt $MaxAttempts) {
            Start-Sleep -Seconds $retrySeconds
            $retrySeconds = [Math]::Min($MaximumRetrySeconds, [Math]::Max($retrySeconds + 1, $retrySeconds * 2))
        }
    }
    Write-SupervisorLog -Level 'ERROR' -Message "Startup supervisor exhausted retries; last category: $lastCategory."
    exit 1
} catch {
    Write-SupervisorLog -Level 'ERROR' -Message ('Startup supervisor failed: ' + $_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $lockStream) { $lockStream.Dispose() }
}
