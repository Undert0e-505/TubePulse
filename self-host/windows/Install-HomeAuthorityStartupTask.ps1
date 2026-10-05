[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [ValidatePattern('^[A-Za-z0-9 _.-]{1,100}$')]
    [string]$TaskName = 'TubePulse Home Authority',

    [Parameter(ParameterSetName = 'Install')]
    [ValidateRange(0, 3600)]
    [int]$StartupDelaySeconds = 30,

    [Parameter(ParameterSetName = 'Install')]
    [ValidateRange(1, 60)]
    [int]$FailureRetryMinutes = 5,

    [Parameter(ParameterSetName = 'Install')]
    [ValidateRange(1, 100)]
    [int]$FailureRetryCount = 12,

    [Parameter(ParameterSetName = 'Install')]
    [switch]$DryRun,

    [Parameter(Mandatory = $true, ParameterSetName = 'Disable')]
    [switch]$Disable,

    [Parameter(Mandatory = $true, ParameterSetName = 'Uninstall')]
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$selfHostDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$startupScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Start-HomeAuthority.ps1'))
$composePath = [IO.Path]::GetFullPath((Join-Path $selfHostDirectory 'compose.authority.yaml'))
$environmentPath = [IO.Path]::GetFullPath((Join-Path $selfHostDirectory '.env.authority'))
$powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this installer from an elevated PowerShell session.'
    }
}

if ($Disable) {
    Assert-Administrator
    Disable-ScheduledTask -TaskName $TaskName | Out-Null
    Write-Host "Disabled Scheduled Task '$TaskName'."
    exit 0
}
if ($Uninstall) {
    Assert-Administrator
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed Scheduled Task '$TaskName'. Repository and authority data were not changed."
    exit 0
}

foreach ($path in @($startupScript, $composePath, $powerShellPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required startup file is missing: $path"
    }
}
if (-not $DryRun -and -not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
    throw "Required startup file is missing: $environmentPath"
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$argument = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $startupScript
$plan = [pscustomobject]@{
    TaskName = $TaskName
    User = $identity
    Trigger = 'AtLogOn'
    DelaySeconds = $StartupDelaySeconds
    Executable = $powerShellPath
    Arguments = $argument
    Hidden = $true
    MultipleInstances = 'IgnoreNew'
    FailureRetryMinutes = $FailureRetryMinutes
    FailureRetryCount = $FailureRetryCount
    EnvironmentPresent = (Test-Path -LiteralPath $environmentPath -PathType Leaf)
}

if ($DryRun) {
    [pscustomobject]@{ DryRun = $true; MutatedHost = $false; Plan = $plan } | ConvertTo-Json -Compress -Depth 4
    exit 0
}

Assert-Administrator

$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $argument -WorkingDirectory $selfHostDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$trigger.Delay = 'PT{0}S' -f $StartupDelaySeconds
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -MultipleInstances IgnoreNew `
    -RestartCount $FailureRetryCount `
    -RestartInterval (New-TimeSpan -Minutes $FailureRetryMinutes) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Starts Docker Desktop minimized and restores the TubePulse Home authority with bounded readiness checks.' `
    -Force | Out-Null

Write-Host "Installed Scheduled Task '$TaskName'. It runs only in the interactive user session and does not modify authority data."
