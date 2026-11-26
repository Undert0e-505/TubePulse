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

    [ValidateRange(30, 180)]
    [int]$StabilityIntervalSeconds = 60,

    [ValidateRange(60, 1800)]
    [int]$SchedulerCycleTimeoutSeconds = 300,

    [ValidateRange(15, 300)]
    [int]$StabilityMarginSeconds = 30,

    [ValidateRange(65536, 10485760)]
    [int]$MaximumLogBytes = 1048576,

    [switch]$DryRun,

    [string]$SimulationFile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$selfHostDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $selfHostDirectory '..'))
$deploymentTool = [IO.Path]::GetFullPath((Join-Path $repoRoot 'scripts\manage-production-deployment.mjs'))
$deploymentManifest = [IO.Path]::GetFullPath((Join-Path $repoRoot 'logs\deployments\production\current.json'))
$composePath = $null
$environmentPath = [IO.Path]::GetFullPath((Join-Path $selfHostDirectory '.env.authority'))
$sourceDirectory = [IO.Path]::GetFullPath((Join-Path $selfHostDirectory 'src'))
$dataDirectory = [IO.Path]::GetFullPath((Join-Path $selfHostDirectory 'data-authority'))
$logPath = [IO.Path]::GetFullPath((Join-Path $dataDirectory 'startup-supervisor.log'))
$previousLogPath = [IO.Path]::GetFullPath((Join-Path $dataDirectory 'startup-supervisor.previous.log'))
$lockPath = [IO.Path]::GetFullPath((Join-Path $dataDirectory 'startup-supervisor.lock'))
$tunnelBootMarkerPath = [IO.Path]::GetFullPath((Join-Path $dataDirectory 'startup-cloudflared-boot.json'))
$recoveryTimelinePath = [IO.Path]::GetFullPath((Join-Path $dataDirectory 'startup-recovery-timeline.json'))
$syncStatePath = [IO.Path]::GetFullPath((Join-Path $dataDirectory 'home-scheduler-sync-state.json'))
$utf8NoBom = New-Object Text.UTF8Encoding($false)
$script:DockerCommand = $null
$script:DockerDesktopStarted = $false
$script:verification = $null
$script:ContainerRestarted = $false
$script:CloudflaredRestartAttempted = $false
$script:CloudflaredRestartedAt = $null
$script:RecoveryRunId = $null
$monitoringLauncher = [IO.Path]::GetFullPath((Join-Path $selfHostDirectory '..\monitoring\windows\Start-TubePulseMonitoring.ps1'))
$stabilityDeadlineSeconds = $SchedulerCycleTimeoutSeconds + $StabilityIntervalSeconds + $StabilityMarginSeconds

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

foreach ($path in @($environmentPath, $sourceDirectory, $dataDirectory, $logPath, $previousLogPath, $lockPath, $tunnelBootMarkerPath, $recoveryTimelinePath, $syncStatePath)) {
    Assert-ChildPath -Parent $selfHostDirectory -Child $path
}
if ($DryRun) {
    [pscustomobject]@{
        DryRun = $true
        SelfHostDirectory = $selfHostDirectory
        DeploymentManifest = $deploymentManifest
        DeploymentManifestPresent = (Test-Path -LiteralPath $deploymentManifest -PathType Leaf)
        EnvironmentFile = $environmentPath
        EnvironmentPresent = (Test-Path -LiteralPath $environmentPath -PathType Leaf)
        DataDirectory = $dataDirectory
        TunnelBootMarker = $tunnelBootMarkerPath
        RecoveryTimeline = $recoveryTimelinePath
        InitialDelaySeconds = $InitialDelaySeconds
        MaxAttempts = $MaxAttempts
        StabilityIntervalSeconds = $StabilityIntervalSeconds
        SchedulerCycleTimeoutSeconds = $SchedulerCycleTimeoutSeconds
        StabilityMarginSeconds = $StabilityMarginSeconds
        StabilityDeadlineSeconds = $stabilityDeadlineSeconds
        MutatedHost = $false
    } | ConvertTo-Json -Compress
    exit 0
}

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

function Read-RecoveryTimeline {
    if (-not (Test-Path -LiteralPath $recoveryTimelinePath -PathType Leaf)) {
        return [pscustomobject]@{ schemaVersion = 1; current = $null; history = @() }
    }
    try { return (Get-Content -LiteralPath $recoveryTimelinePath -Raw | ConvertFrom-Json) } catch {
        return [pscustomobject]@{ schemaVersion = 1; current = $null; history = @() }
    }
}

function Write-RecoveryTimelineFile {
    param([Parameter(Mandatory = $true)][object]$Timeline)
    $temporaryPath = $recoveryTimelinePath + '.tmp'
    [IO.File]::WriteAllText($temporaryPath, ($Timeline | ConvertTo-Json -Depth 12 -Compress), $utf8NoBom)
    Move-Item -LiteralPath $temporaryPath -Destination $recoveryTimelinePath -Force
}

function Start-RecoveryTimeline {
    param([Parameter(Mandatory = $true)][string]$BootIdentity)
    $timeline = Read-RecoveryTimeline
    $cutoff = [DateTimeOffset]::UtcNow.AddDays(-7)
    $history = @($timeline.history | Where-Object {
        $completed = [DateTimeOffset]::MinValue
        [DateTimeOffset]::TryParse([string]$_.finishedAt, [ref]$completed) -and $completed -ge $cutoff
    } | Select-Object -Last 20)
    $script:RecoveryRunId = [Guid]::NewGuid().ToString('N')
    $timeline = [pscustomobject]@{
        schemaVersion = 1
        retentionDays = 7
        current = [pscustomobject]@{
            runId = $script:RecoveryRunId
            bootIdentity = $BootIdentity
            startedAt = [DateTimeOffset]::UtcNow.ToString('o')
            finishedAt = $null
            outcome = 'running'
            phase = 'startup-began'
            events = @([pscustomobject]@{ at = [DateTimeOffset]::UtcNow.ToString('o'); phase = 'startup-began'; outcome = 'ok' })
        }
        history = $history
    }
    Write-RecoveryTimelineFile -Timeline $timeline
}

function Add-RecoveryTimelineEvent {
    param(
        [Parameter(Mandatory = $true)][string]$Phase,
        [Parameter(Mandatory = $true)][string]$Outcome,
        [object]$Details = $null
    )
    if ([string]::IsNullOrWhiteSpace($script:RecoveryRunId)) { return }
    $timeline = Read-RecoveryTimeline
    if ([string]$timeline.current.runId -ne $script:RecoveryRunId) { return }
    $event = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToString('o'); phase = $Phase; outcome = $Outcome }
    if ($null -ne $Details) { $event.details = $Details }
    $timeline.current.phase = $Phase
    $timeline.current.events = @($timeline.current.events) + [pscustomobject]$event
    Write-RecoveryTimelineFile -Timeline $timeline
}

function Complete-RecoveryTimeline {
    param([Parameter(Mandatory = $true)][string]$Outcome, [Parameter(Mandatory = $true)][string]$Phase)
    if ([string]::IsNullOrWhiteSpace($script:RecoveryRunId)) { return }
    $timeline = Read-RecoveryTimeline
    if ([string]$timeline.current.runId -ne $script:RecoveryRunId) { return }
    $timeline.current.outcome = $Outcome
    $timeline.current.phase = $Phase
    $timeline.current.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $summary = [pscustomobject]@{
        runId = $timeline.current.runId
        startedAt = $timeline.current.startedAt
        finishedAt = $timeline.current.finishedAt
        outcome = $timeline.current.outcome
        phase = $timeline.current.phase
    }
    $updatedHistory = @($timeline.history) + @($summary)
    $timeline.history = @($updatedHistory | Select-Object -Last 20)
    Write-RecoveryTimelineFile -Timeline $timeline
}

function Get-ReconciliationEvidence {
    if (-not (Test-Path -LiteralPath $syncStatePath -PathType Leaf)) { return $null }
    try {
        $sync = Get-Content -LiteralPath $syncStatePath -Raw | ConvertFrom-Json
        $pull = $sync.lastPull
        if ($null -eq $pull) { return $null }
        return [pscustomobject]@{
            direction = 'canonical-to-home'
            at = $pull.at
            status = $pull.status
            imported = [int]$pull.imported
            updated = [int]$pull.updated
            deleted = [int]$pull.deleted
            unchanged = [int]$pull.unchanged
            conflicts = [int]$pull.conflicts
            pendingLocal = [int]$pull.pendingLocal
        }
    } catch { return $null }
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

function Resolve-PromotedHomeDeployment {
    if ($null -ne $script:verification -and -not [string]::IsNullOrWhiteSpace($script:composePath)) {
        return $true
    }

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # The verifier also inspects the pinned Docker image. It must therefore
        # run only after the engine is available during boot recovery.
        $ErrorActionPreference = 'Continue'
        $verificationText = @(& node $deploymentTool verify --component home --manifest $deploymentManifest 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        Write-SupervisorLog -Level 'WARN' -Message 'Promoted Home deployment could not yet be verified.'
        return $false
    }

    try {
        $candidate = ($verificationText -join "`n") | ConvertFrom-Json
        $candidateComposePath = [IO.Path]::GetFullPath([string]$candidate.composeFile)
        Assert-ChildPath -Parent $repoRoot -Child $candidateComposePath
        if (-not (Test-Path -LiteralPath $candidateComposePath -PathType Leaf)) {
            throw 'Promoted Home Compose file is missing.'
        }
        $script:verification = $candidate
        $script:composePath = $candidateComposePath
        return $true
    } catch {
        Write-SupervisorLog -Level 'ERROR' -Message ('Promoted Home deployment metadata is invalid: ' + $_.Exception.Message)
        return $false
    }
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
    $result = Invoke-Docker -Arguments (Compose-Arguments -Tail @('up', '-d', '--no-build', '--pull', 'never'))
    if ($result.ExitCode -ne 0) {
        Write-SupervisorLog -Level 'WARN' -Message 'Authority Compose up did not complete; Docker or a dependency may still be starting.'
        return $false
    }
    $verified = Invoke-Docker -Arguments @('image', 'inspect', [string]$verification.expectedImageId, '--format', '{{.Id}}')
    if ($verified.ExitCode -ne 0) {
        Write-SupervisorLog -Level 'ERROR' -Message 'Pinned authority image is unavailable after Compose startup.'
        return $false
    }
    $runningText = @(& node $deploymentTool verify-running --component home --manifest $deploymentManifest 2>&1)
    if ($LASTEXITCODE -ne 0) {
        Write-SupervisorLog -Level 'ERROR' -Message ('Running authority does not match the promoted deployment: ' + ($runningText -join ' '))
        return $false
    }
    return $true
}

function Get-CurrentBootIdentity {
    $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    # Persist decimal UTC ticks rather than an ISO timestamp. PowerShell 7
    # auto-converts ISO JSON strings to DateTime while Windows PowerShell 5
    # leaves them as strings, which would make the same boot compare unequal.
    return ([DateTimeOffset]$operatingSystem.LastBootUpTime).UtcDateTime.Ticks.ToString(
        [Globalization.CultureInfo]::InvariantCulture
    )
}

function Read-TunnelBootMarker {
    if (-not (Test-Path -LiteralPath $tunnelBootMarkerPath -PathType Leaf)) { return $null }
    try {
        return (Get-Content -LiteralPath $tunnelBootMarkerPath -Raw | ConvertFrom-Json)
    } catch {
        Write-SupervisorLog -Level 'WARN' -Message 'Tunnel boot marker is unreadable; one bounded recovery will be attempted.'
        return $null
    }
}

function Write-TunnelBootMarker {
    param(
        [Parameter(Mandatory = $true)][string]$BootIdentity,
        [Parameter(Mandatory = $true)][DateTimeOffset]$RestartedAt,
        [Nullable[DateTimeOffset]]$RegisteredAt = $null,
        [Nullable[DateTimeOffset]]$GatePassedAt = $null
    )
    $temporaryPath = $tunnelBootMarkerPath + '.tmp'
    $payload = [pscustomobject]@{
        schemaVersion = 2
        bootIdentity = $BootIdentity
        restartedAt = $RestartedAt.ToUniversalTime().ToString('o')
        registeredAt = if ($null -ne $RegisteredAt) { $RegisteredAt.ToUniversalTime().ToString('o') } else { $null }
        gatePassedAt = if ($null -ne $GatePassedAt) { $GatePassedAt.ToUniversalTime().ToString('o') } else { $null }
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($temporaryPath, $payload, $utf8NoBom)
    Move-Item -LiteralPath $temporaryPath -Destination $tunnelBootMarkerPath -Force
}

function Get-CloudflaredRegistrationState {
    param([Parameter(Mandatory = $true)][DateTimeOffset]$Since)
    $ps = Invoke-Docker -Arguments (Compose-Arguments -Tail @('ps', '-q', 'cloudflared'))
    if ($ps.ExitCode -ne 0 -or $ps.Output.Count -eq 0 -or [string]::IsNullOrWhiteSpace($ps.Output[0])) {
        return [pscustomobject]@{ Running = $false; RegisteredConnections = 0 }
    }
    $containerId = $ps.Output[0].Trim()
    $inspect = Invoke-Docker -Arguments @('inspect', '--format', '{{.State.Status}}', $containerId)
    $logs = Invoke-Docker -Arguments @('logs', '--since', $Since.ToUniversalTime().ToString('o'), $containerId)
    $registered = if ($logs.ExitCode -eq 0) {
        @($logs.Output | Where-Object { $_ -like '*Registered tunnel connection*' }).Count
    } else { 0 }
    return [pscustomobject]@{
        Running = $inspect.ExitCode -eq 0 -and $inspect.Output.Count -gt 0 -and $inspect.Output[0].Trim() -eq 'running'
        RegisteredConnections = $registered
    }
}

function Ensure-CloudflaredBootRecovery {
    $bootIdentity = Get-CurrentBootIdentity
    $marker = Read-TunnelBootMarker
    if ($null -ne $marker -and [string]$marker.bootIdentity -eq $bootIdentity) {
        $restartTime = [DateTimeOffset]::MinValue
        $markerRestartedAt = Get-OptionalProperty -Object $marker -Name 'restartedAt'
        $markerRegisteredAt = Get-OptionalProperty -Object $marker -Name 'registeredAt'
        $markerGatePassedAt = Get-OptionalProperty -Object $marker -Name 'gatePassedAt'
        $legacyRecoveredAt = Get-OptionalProperty -Object $marker -Name 'recoveredAt'
        $legacyMarker = [string]::IsNullOrWhiteSpace([string]$markerRestartedAt) -and `
            -not [string]::IsNullOrWhiteSpace([string]$legacyRecoveredAt)
        if ($legacyMarker) {
            return [pscustomobject]@{ Ready = $true; Restarted = $false; RestartedAt = $null; GatePassed = $true }
        }
        if ([DateTimeOffset]::TryParse([string]$markerRestartedAt, [ref]$restartTime)) {
            $script:CloudflaredRestartedAt = $restartTime
        }
        return [pscustomobject]@{
            Ready = -not [string]::IsNullOrWhiteSpace([string]$markerRegisteredAt)
            Restarted = $false
            RestartedAt = $script:CloudflaredRestartedAt
            GatePassed = -not [string]::IsNullOrWhiteSpace([string]$markerGatePassedAt)
        }
    }

    if (-not $script:CloudflaredRestartAttempted) {
        $script:CloudflaredRestartAttempted = $true
        $script:CloudflaredRestartedAt = [DateTimeOffset]::UtcNow
        $restart = Invoke-Docker -Arguments (Compose-Arguments -Tail @('restart', 'cloudflared'))
        if ($restart.ExitCode -ne 0) {
            Write-SupervisorLog -Level 'WARN' -Message 'Boot recovery could not restart the tunnel sidecar; authority remains untouched.'
            return [pscustomobject]@{ Ready = $false; Restarted = $false }
        }
        Write-TunnelBootMarker -BootIdentity $bootIdentity -RestartedAt $script:CloudflaredRestartedAt
        Add-RecoveryTimelineEvent -Phase 'tunnel-restarted' -Outcome 'ok' -Details ([pscustomobject]@{
            restartedAt = $script:CloudflaredRestartedAt.ToUniversalTime().ToString('o')
        })
        Write-SupervisorLog -Level 'INFO' -Message 'Performed the once-per-boot tunnel restart after authority readiness.'
    }

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(45)
    do {
        $registration = Get-CloudflaredRegistrationState -Since $script:CloudflaredRestartedAt
        if ($registration.Running -and $registration.RegisteredConnections -gt 0) {
            $registeredAt = [DateTimeOffset]::UtcNow
            Write-TunnelBootMarker -BootIdentity $bootIdentity -RestartedAt $script:CloudflaredRestartedAt -RegisteredAt $registeredAt
            Write-SupervisorLog -Level 'INFO' -Message 'Tunnel sidecar registered after boot recovery.'
            Add-RecoveryTimelineEvent -Phase 'tunnel-registered' -Outcome 'ok' -Details ([pscustomobject]@{
                registeredConnections = [int]$registration.RegisteredConnections
            })
            return [pscustomobject]@{ Ready = $true; Restarted = $true; RestartedAt = $script:CloudflaredRestartedAt; GatePassed = $false }
        }
        Start-Sleep -Seconds 2
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    Write-SupervisorLog -Level 'WARN' -Message 'Tunnel sidecar did not register within the bounded boot-recovery window.'
    return [pscustomobject]@{ Ready = $false; Restarted = $false; RestartedAt = $script:CloudflaredRestartedAt; GatePassed = $false }
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
    if ($Value -is [DateTimeOffset]) {
        $parsed = [DateTimeOffset]$Value
    } elseif ($Value -is [DateTime]) {
        $parsed = [DateTimeOffset]([DateTime]$Value)
    } else {
        $parsed = [DateTimeOffset]::MinValue
        if (-not [DateTimeOffset]::TryParse([string]$Value, [ref]$parsed)) { return $false }
    }
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
    param(
        [Parameter(Mandatory = $true)][object]$Local,
        [Parameter(Mandatory = $true)][object]$Remote,
        [Parameter(Mandatory = $true)][DateTimeOffset]$RestartedAt,
        [Parameter(Mandatory = $true)][DateTimeOffset]$Now
    )
    $startupRecovery = Get-OptionalProperty -Object $Local -Name 'startupRecovery'
    $startupStatus = [string](Get-OptionalProperty -Object $startupRecovery -Name 'status')
    $runtimeReady = [string]$Local.status -eq 'ready' -or `
        ([string]$Local.status -eq 'starting' -and $startupStatus -eq 'in-progress')
    if ([string]$Local.service -ne 'unified-home-authority' -or -not $runtimeReady) {
        return [pscustomobject]@{ Success = $false; Category = 'local-liveness'; Message = 'Local authority status is not ready.' }
    }
    if ([string]$Local.authority.replication.status -ne 'current') {
        return [pscustomobject]@{ Success = $false; Category = 'authority-readiness'; Message = 'Local authority is stale.' }
    }
    if ($Remote.ok -ne $true -or [string]$Remote.backend.selected -ne 'd1' -or $Remote.backend.ready -ne $true) {
        return [pscustomobject]@{ Success = $false; Category = 'cloud-readiness'; Message = 'Remote D1 authority backend is not ready.' }
    }
    if ([string]$Remote.replication.status -ne 'current') {
        return [pscustomobject]@{ Success = $false; Category = 'coordinator-state'; Message = 'Remote authority is stale.' }
    }
    if ([int]$Remote.pendingBackupKeys -ne 0) {
        return [pscustomobject]@{ Success = $false; Category = 'coordinator-pending'; Message = 'Remote coordinator has pending backup keys; no automatic clearing is allowed.' }
    }
    $localLease = Get-OptionalProperty -Object $Local.authority -Name 'lease'
    $localTransaction = Get-OptionalProperty -Object $Local.authority -Name 'transaction'
    $remoteLease = Get-OptionalProperty -Object $Remote -Name 'lease'
    $remoteTransaction = Get-OptionalProperty -Object $Remote -Name 'transaction'
    if ($null -ne $localLease -or $null -ne $localTransaction -or $null -ne $remoteLease -or $null -ne $remoteTransaction) {
        $localLeaseKind = [string](Get-OptionalProperty -Object $localLease -Name 'kind')
        $localTransactionKind = [string](Get-OptionalProperty -Object $localTransaction -Name 'kind')
        $leaseKind = [string](Get-OptionalProperty -Object $remoteLease -Name 'kind')
        $transactionKind = [string](Get-OptionalProperty -Object $remoteTransaction -Name 'kind')
        $localLeaseExpiry = [long](Get-OptionalProperty -Object $localLease -Name 'expiresAt')
        $leaseExpiry = [long](Get-OptionalProperty -Object $remoteLease -Name 'expiresAt')
        $localLeaseUnexpired = $null -eq $localLease -or $localLeaseExpiry -gt $Now.ToUnixTimeMilliseconds()
        $leaseUnexpired = $null -eq $remoteLease -or $leaseExpiry -gt $Now.ToUnixTimeMilliseconds()
        $schedulerOwned = ($null -eq $localLease -or $localLeaseKind -eq 'scheduler') -and `
            ($null -eq $localTransaction -or $localTransactionKind -eq 'scheduler') -and `
            ($null -eq $remoteLease -or $leaseKind -eq 'scheduler') -and `
            ($null -eq $remoteTransaction -or $transactionKind -eq 'scheduler')
        $transactionsHaveLeases = ($null -eq $localTransaction -or $null -ne $localLease) -and `
            ($null -eq $remoteTransaction -or $null -ne $remoteLease)
        $schedulerStartedAt = [DateTimeOffset]::MinValue
        $schedulerStarted = [DateTimeOffset]::TryParse([string]$Local.scheduler.startedAt, [ref]$schedulerStartedAt)
        $activeCycle = Get-OptionalProperty -Object $Local.scheduler -Name 'activeCycle'
        $activeScheduledAt = [DateTimeOffset]::MinValue
        $activeStartedAt = [DateTimeOffset]::MinValue
        $activeScheduled = [DateTimeOffset]::TryParse(
            [string](Get-OptionalProperty -Object $activeCycle -Name 'scheduledAt'), [ref]$activeScheduledAt
        )
        $activeStarted = [DateTimeOffset]::TryParse(
            [string](Get-OptionalProperty -Object $activeCycle -Name 'startedAt'), [ref]$activeStartedAt
        )
        $postRestartCycleActive = $activeScheduled -and $activeStarted -and `
            $activeScheduledAt -gt $RestartedAt -and $activeStartedAt -gt $RestartedAt -and `
            $activeStartedAt -le $Now
        $localLeaseHeld = [string](Get-OptionalProperty -Object $Local.scheduler.lease -Name 'state') -eq 'held'
        if ($schedulerOwned -and $transactionsHaveLeases -and $localLeaseUnexpired -and $leaseUnexpired -and `
            $schedulerStarted -and $postRestartCycleActive -and $localLeaseHeld) {
            return [pscustomobject]@{
                Success = $false; Pending = $true; Category = 'scheduler-cycle-active'
                Message = 'The post-restart scheduler cycle is actively publishing; wait for it to settle.'
            }
        }
        return [pscustomobject]@{ Success = $false; Pending = $false; Category = 'coordinator-state'; Message = 'Authority has a foreign, expired or unverifiable coordinator owner.' }
    }
    $localRecordCount = [int](Get-OptionalProperty -Object $Local.authority.manifest -Name 'recordCount')
    $remoteRecordCount = [int](Get-OptionalProperty -Object $Remote.replication -Name 'recordCount')
    if ($localRecordCount -le 0 -or $localRecordCount -ne $remoteRecordCount) {
        return [pscustomobject]@{ Success = $false; Category = 'authority-disagreement'; Message = 'Local and remote canonical record counts do not agree.' }
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
    return [pscustomobject]@{ Success = $true; Pending = $false; Category = 'active-current'; Message = 'Authority and scheduler are current and progressing.' }
}

function Invoke-CoordinatorVerification {
    param([Parameter(Mandatory = $true)][DateTimeOffset]$RestartedAt)
    $sourceMount = '{0}:/app/self-host/src:ro' -f $sourceDirectory
    $result = Invoke-Docker -Arguments (Compose-Arguments -Tail @(
        'run', '--rm', '--no-deps', '--volume', $sourceMount,
        'home-authority', 'node', 'src/home-authority-cli.mjs', 'verify-coordinator',
        $RestartedAt.ToUniversalTime().ToString('o')
    ))
    if ($result.ExitCode -ne 0 -or $result.Output.Count -eq 0) { return $null }
    for ($index = $result.Output.Count - 1; $index -ge 0; $index--) {
        $line = [string]$result.Output[$index]
        if ([string]::IsNullOrWhiteSpace($line) -or -not $line.Trim().StartsWith('{')) { continue }
        try {
            $proof = $line | ConvertFrom-Json
            $proofAt = [DateTimeOffset]::MinValue
            $proofTimeValid = [DateTimeOffset]::TryParse([string]$proof.releasedAt, [ref]$proofAt)
            if ($proof.ok -eq $true -and $proofTimeValid -and $proofAt -gt $RestartedAt) { return $proof }
        } catch { continue }
    }
    return $null
}

function Invoke-PostTunnelStabilityGate {
    param(
        [Parameter(Mandatory = $true)][DateTimeOffset]$RestartedAt,
        [scriptblock]$StatusProvider = $null,
        [scriptblock]$ProofProvider = $null,
        [scriptblock]$NowProvider = $null,
        [scriptblock]$SleepProvider = $null
    )
    if ($null -eq $StatusProvider) { $StatusProvider = { [pscustomobject]@{ Local = Get-LocalAuthorityStatus; Remote = Get-RemoteAuthorityStatus } } }
    if ($null -eq $ProofProvider) { $ProofProvider = { param($restart) Invoke-CoordinatorVerification -RestartedAt $restart } }
    if ($null -eq $NowProvider) { $NowProvider = { [DateTimeOffset]::UtcNow } }
    if ($null -eq $SleepProvider) { $SleepProvider = { param($seconds) Start-Sleep -Seconds $seconds } }

    $beganAt = & $NowProvider
    $deadline = $beganAt.AddSeconds($stabilityDeadlineSeconds)
    $consecutive = 0
    $firstPassedAt = $null
    $proof = $null
    $checks = 0
    do {
        $now = & $NowProvider
        $sample = & $StatusProvider
        $checks++
        if ($null -eq $sample -or $null -eq $sample.Local -or $null -eq $sample.Remote) {
            $consecutive = 0
            $firstPassedAt = $null
            Add-RecoveryTimelineEvent -Phase 'signed-stability-check' -Outcome 'unavailable' -Details ([pscustomobject]@{ check = $checks })
        } else {
            $evaluation = Evaluate-Authority -Local $sample.Local -Remote $sample.Remote -RestartedAt $RestartedAt -Now $now
            if (-not $evaluation.Success) {
                if ((Get-OptionalProperty -Object $evaluation -Name 'Pending') -eq $true) {
                    # A signed, current scheduler-owned coordinator lease is normal
                    # during an aligned publication. Preserve an earlier idle proof
                    # and wait for the cycle to settle; a stuck lease still reaches
                    # the bounded derived deadline and fails nonzero.
                    $proof = $null
                    Add-RecoveryTimelineEvent -Phase 'signed-stability-check' -Outcome 'pending' -Details ([pscustomobject]@{
                        check = $checks; category = $evaluation.Category; preservedConsecutive = $consecutive
                    })
                } else {
                    $consecutive = 0
                    $firstPassedAt = $null
                    $proof = $null
                    Add-RecoveryTimelineEvent -Phase 'signed-stability-check' -Outcome 'failed' -Details ([pscustomobject]@{
                        check = $checks; category = $evaluation.Category
                    })
                }
            } else {
                if ($consecutive -eq 0) { $firstPassedAt = $now }
                $consecutive++
                Add-RecoveryTimelineEvent -Phase 'signed-stability-check' -Outcome 'ok' -Details ([pscustomobject]@{
                    check = $checks
                    consecutive = $consecutive
                    localGeneration = [int]$sample.Local.authority.replication.generation
                    remoteGeneration = [int]$sample.Remote.replication.generation
                    recordCount = [int]$sample.Remote.replication.recordCount
                })
                if ($null -eq $proof) {
                    $proof = & $ProofProvider $RestartedAt
                    if ($null -eq $proof) {
                        Add-RecoveryTimelineEvent -Phase 'coordinator-proof' -Outcome 'failed'
                        return [pscustomobject]@{ Success = $false; Category = 'coordinator-proof'; Checks = $checks }
                    }
                    Add-RecoveryTimelineEvent -Phase 'coordinator-proof' -Outcome 'ok' -Details ([pscustomobject]@{
                        releasedAt = $proof.releasedAt; recordCount = [int]$proof.recordCount
                    })
                }
                if ($consecutive -ge 2 -and (($now - $firstPassedAt).TotalSeconds -ge $StabilityIntervalSeconds)) {
                    $cycleAt = [DateTimeOffset]::MinValue
                    $cycleFinishedAt = [DateTimeOffset]::MinValue
                    $videoCycle = Get-OptionalProperty -Object $sample.Local.scheduler.youtubeDataApi -Name 'lastCycle'
                    $cycleText = [string](Get-OptionalProperty -Object $videoCycle -Name 'scheduledAt')
                    $cycleFinishedText = [string](Get-OptionalProperty -Object $videoCycle -Name 'finishedAt')
                    $cycleValid = [DateTimeOffset]::TryParse($cycleText, [ref]$cycleAt) -and `
                        [DateTimeOffset]::TryParse($cycleFinishedText, [ref]$cycleFinishedAt) -and `
                        $cycleAt -gt $RestartedAt -and $cycleFinishedAt -gt $RestartedAt
                    if (-not $cycleValid) {
                        Add-RecoveryTimelineEvent -Phase 'post-restart-cycle' -Outcome 'pending'
                        & $SleepProvider ([Math]::Min(5, $StabilityIntervalSeconds))
                        continue
                    }
                    Add-RecoveryTimelineEvent -Phase 'post-restart-cycle' -Outcome 'ok' -Details ([pscustomobject]@{
                        scheduledAt = $cycleAt.ToUniversalTime().ToString('o')
                        finishedAt = $cycleFinishedAt.ToUniversalTime().ToString('o')
                    })
                    return [pscustomobject]@{
                        Success = $true; Category = 'stable'; Checks = $checks
                        FirstPassedAt = $firstPassedAt; FinalPassedAt = $now; Proof = $proof
                        FirstPostRestartCycleAt = $cycleAt
                    }
                }
            }
        }
        $remaining = ($deadline - (& $NowProvider)).TotalSeconds
        if ($remaining -le 0) { break }
        & $SleepProvider ([Math]::Min($StabilityIntervalSeconds, [Math]::Max(1, [int]$remaining)))
    } while ((& $NowProvider) -le $deadline)
    return [pscustomobject]@{
        Success = $false; Category = 'stability-timeout'; Checks = $checks
        DeadlineSeconds = $stabilityDeadlineSeconds
    }
}

function Start-MonitoringBestEffort {
    if (-not (Test-Path -LiteralPath $monitoringLauncher -PathType Leaf)) { return }
    try {
        Start-Process -FilePath 'powershell.exe' -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $monitoringLauncher), '-NoOpen', '-WaitSeconds', '0'
        ) -WindowStyle Hidden | Out-Null
        Write-SupervisorLog -Level 'INFO' -Message 'Requested best-effort aggregate monitoring startup.'
    } catch {
        Write-SupervisorLog -Level 'WARN' -Message 'Aggregate monitoring startup could not be requested; production authority remains unaffected.'
    }
}

function Invoke-StartupSimulation {
    param([Parameter(Mandatory = $true)][string]$Path)
    $scenario = Get-Content -LiteralPath ([IO.Path]::GetFullPath($Path)) -Raw | ConvertFrom-Json
    $script:SimulationClock = [DateTimeOffset]::UtcNow
    $restart = $script:SimulationClock.AddSeconds(-1)
    $script:SimulationIndex = 0
    $states = @($scenario.checks)
    $statusProvider = {
        $kind = if ($script:SimulationIndex -lt $states.Count) { [string]$states[$script:SimulationIndex] } else { 'unavailable' }
        $script:SimulationIndex++
        if ($kind -eq 'unavailable') { return $null }
        $current = [DateTimeOffset]::UtcNow.ToString('o')
        $local = [pscustomobject]@{
            service = 'unified-home-authority'; status = 'ready'; mode = 'active'
            authority = [pscustomobject]@{
                replication = [pscustomobject]@{ status = if ($kind -eq 'fail') { 'stale' } else { 'current' }; generation = 10 }
                transaction = if ($kind -eq 'local-busy') { [pscustomobject]@{ kind = 'scheduler'; nextIndex = 1; count = 2 } } else { $null }
                lease = if ($kind -eq 'local-busy') {
                    [pscustomobject]@{ kind = 'scheduler'; expiresAt = $script:SimulationClock.AddMinutes(3).ToUnixTimeMilliseconds() }
                } else { $null }
                manifest = [pscustomobject]@{ recordCount = 100 }
            }
            scheduler = [pscustomobject]@{
                mode = 'active'; lease = [pscustomobject]@{ state = 'held' }; startedAt = $current
                lastMinuteJobs = [pscustomobject]@{ scheduledAt = $current }
                activeCycle = if ($kind -in @('busy', 'stuck', 'local-busy')) {
                    [pscustomobject]@{ kind = 'minute'; scheduledAt = $current; startedAt = $current; aligned = $true }
                } else { $null }
                youtubeDataApi = [pscustomobject]@{
                    lastGoodAt = $current
                    lastCycle = [pscustomobject]@{ scheduledAt = $current; finishedAt = $current }
                }
            }
        }
        $remote = [pscustomobject]@{
            ok = $true; backend = [pscustomobject]@{ selected = 'd1'; ready = $true }
            replication = [pscustomobject]@{ status = 'current'; generation = 20; recordCount = 100 }
            transaction = if ($kind -eq 'foreign') { [pscustomobject]@{ kind = 'api'; nextIndex = 0; count = 1 } } else { $null }
            lease = if ($kind -eq 'busy' -or $kind -eq 'stuck') {
                [pscustomobject]@{ kind = 'scheduler'; expiresAt = $script:SimulationClock.AddMinutes(3).ToUnixTimeMilliseconds() }
            } elseif ($kind -eq 'foreign') {
                [pscustomobject]@{ kind = 'api'; expiresAt = $script:SimulationClock.AddMinutes(3).ToUnixTimeMilliseconds() }
            } else { $null }
            pendingBackupKeys = if ($kind -eq 'pending') { 1 } else { 0 }
        }
        return [pscustomobject]@{ Local = $local; Remote = $remote }
    }
    $proofProvider = {
        param($restartAt)
        if ([string]$scenario.proof -ne 'ok') { return $null }
        $proofAt = if ([string]$scenario.proof -eq 'stale') { $restartAt.AddSeconds(-1) } else { $script:SimulationClock.AddMilliseconds(1) }
        if ($proofAt -le $restartAt) { return $null }
        return [pscustomobject]@{ ok = $true; releasedAt = $proofAt.ToString('o'); recordCount = 100 }
    }
    $nowProvider = { $script:SimulationClock }
    $sleepProvider = { param($seconds) $script:SimulationClock = $script:SimulationClock.AddSeconds($seconds) }
    $result = Invoke-PostTunnelStabilityGate -RestartedAt $restart -StatusProvider $statusProvider `
        -ProofProvider $proofProvider -NowProvider $nowProvider -SleepProvider $sleepProvider
    [pscustomobject]@{
        Simulation = $true
        Success = $result.Success
        Category = $result.Category
        Checks = $result.Checks
        RestartAttempts = 0
        ElapsedSeconds = [int]($script:SimulationClock - $restart.AddSeconds(1)).TotalSeconds
        DeadlineSeconds = $stabilityDeadlineSeconds
    } | ConvertTo-Json -Compress
}

if (-not [string]::IsNullOrWhiteSpace($SimulationFile)) {
    Invoke-StartupSimulation -Path $SimulationFile
    exit 0
}

if (-not (Test-Path -LiteralPath $deploymentTool -PathType Leaf)) { throw 'Managed deployment verifier is missing.' }
if (-not (Test-Path -LiteralPath $deploymentManifest -PathType Leaf)) {
    throw 'Promoted deployment manifest is missing; authority startup refuses mutable workspace configuration.'
}
if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
    throw 'Ignored .env.authority is missing. Run Initialize-HomeAuthority.ps1 first.'
}
[IO.Directory]::CreateDirectory($dataDirectory) | Out-Null

$lockStream = $null
try {
    try {
        $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] {
        Write-SupervisorLog -Level 'INFO' -Message 'Another startup supervisor instance already owns the lock; exiting.'
        exit 0
    }

    $script:DockerCommand = Resolve-DockerCommand
    $bootIdentity = Get-CurrentBootIdentity
    Start-RecoveryTimeline -BootIdentity $bootIdentity
    Write-SupervisorLog -Level 'INFO' -Message 'Home authority startup supervisor began.'
    if ($InitialDelaySeconds -gt 0) { Start-Sleep -Seconds $InitialDelaySeconds }

    $retrySeconds = $InitialRetrySeconds
    $lastCategory = 'not-started'
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        if (-not (Test-DockerReady)) {
            $lastCategory = 'docker-not-ready'
            Start-DockerDesktopHidden
            Write-SupervisorLog -Level 'WARN' -Message "Attempt ${attempt}: Docker engine is not ready."
        } elseif (-not (Resolve-PromotedHomeDeployment)) {
            $lastCategory = 'deployment-not-ready'
        } elseif (-not (Invoke-ComposeUp)) {
            $lastCategory = 'compose-not-ready'
        } else {
            Add-RecoveryTimelineEvent -Phase 'docker-ready' -Outcome 'ok'
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
                        $evaluationNow = [DateTimeOffset]::UtcNow
                        $evaluation = Evaluate-Authority -Local $local -Remote $remote `
                            -RestartedAt $evaluationNow.AddDays(-1) -Now $evaluationNow
                        $lastCategory = $evaluation.Category
                        if ($evaluation.Success) {
                            Add-RecoveryTimelineEvent -Phase 'home-ready' -Outcome 'ok' -Details ([pscustomobject]@{
                                recordCount = [int]$local.authority.manifest.recordCount
                                replicationGeneration = [int]$local.authority.replication.generation
                            })
                            $tunnel = Ensure-CloudflaredBootRecovery
                            if (-not $tunnel.Ready) {
                                $lastCategory = 'tunnel-not-ready'
                                Write-SupervisorLog -Level 'WARN' -Message "Attempt ${attempt}: tunnel boot recovery is not ready; preserving authority and retrying."
                            } else {
                                if (-not $tunnel.GatePassed) {
                                    if ($null -eq $tunnel.RestartedAt) {
                                        $lastCategory = 'post-tunnel-restart-time-missing'
                                        Write-SupervisorLog -Level 'ERROR' -Message 'Tunnel marker lacks the restart timestamp required for stable verification.'
                                        Complete-RecoveryTimeline -Outcome 'failed' -Phase $lastCategory
                                        exit 1
                                    }
                                    Write-SupervisorLog -Level 'INFO' -Message "Beginning bounded post-tunnel stability gate: ${SchedulerCycleTimeoutSeconds}s configured cycle timeout + ${StabilityIntervalSeconds}s stability interval + ${StabilityMarginSeconds}s margin = ${stabilityDeadlineSeconds}s deadline."
                                    $stable = Invoke-PostTunnelStabilityGate -RestartedAt $tunnel.RestartedAt
                                    if (-not $stable.Success) {
                                        $lastCategory = $stable.Category
                                        Write-SupervisorLog -Level 'ERROR' -Message "Post-tunnel stability gate failed: $lastCategory."
                                        Complete-RecoveryTimeline -Outcome 'failed' -Phase $lastCategory
                                        exit 1
                                    }
                                    $marker = Read-TunnelBootMarker
                                    $registeredAt = [DateTimeOffset]::MinValue
                                    [void][DateTimeOffset]::TryParse([string]$marker.registeredAt, [ref]$registeredAt)
                                    $gatePassedAt = [DateTimeOffset]::UtcNow
                                    Write-TunnelBootMarker -BootIdentity $bootIdentity -RestartedAt $tunnel.RestartedAt `
                                        -RegisteredAt $registeredAt -GatePassedAt $gatePassedAt
                                    Add-RecoveryTimelineEvent -Phase 'stability-gate' -Outcome 'ok' -Details ([pscustomobject]@{
                                        checks = [int]$stable.Checks
                                        intervalSeconds = $StabilityIntervalSeconds
                                        firstPassedAt = $stable.FirstPassedAt.ToUniversalTime().ToString('o')
                                        finalPassedAt = $stable.FinalPassedAt.ToUniversalTime().ToString('o')
                                    })
                                }
                                $reconciliation = Get-ReconciliationEvidence
                                if ($null -ne $reconciliation) {
                                    Add-RecoveryTimelineEvent -Phase 'reconciliation-evidence' -Outcome 'ok' -Details $reconciliation
                                }
                                Write-SupervisorLog -Level 'INFO' -Message $evaluation.Message
                                Complete-RecoveryTimeline -Outcome 'succeeded' -Phase 'ready'
                                Start-MonitoringBestEffort
                                exit 0
                            }
                        }
                        if (-not $evaluation.Success) {
                            Write-SupervisorLog -Level 'WARN' -Message "Attempt ${attempt}: $($evaluation.Message)"
                        }
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
    Complete-RecoveryTimeline -Outcome 'failed' -Phase $lastCategory
    exit 1
} catch {
    Write-SupervisorLog -Level 'ERROR' -Message ('Startup supervisor failed: ' + $_.Exception.Message)
    Complete-RecoveryTimeline -Outcome 'failed' -Phase 'exception'
    exit 1
} finally {
    if ($null -ne $lockStream) { $lockStream.Dispose() }
}
