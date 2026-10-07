[CmdletBinding()]
param(
    [switch]$Remove,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$expectedRepo = [System.IO.Path]::GetFullPath('D:\dev\TubePulse')
if (-not $repo.Equals($expectedRepo, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Build runner registration is restricted to $expectedRepo."
}

$taskSpecs = @(
    @{ Name = 'TubePulse Android Build Preflight'; Mode = 'Preflight' },
    @{ Name = 'TubePulse Android Build Official'; Mode = 'Official' },
    @{ Name = 'TubePulse Android Build Preview'; Mode = 'Preview' }
)
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$runner = Join-Path $repo 'scripts\Run-AndroidBuildTask.ps1'

if ($DryRun) {
    foreach ($spec in $taskSpecs) {
        Write-Output ("{0}: {1} -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"{2}`" -Mode {3}" -f $spec.Name, $powershell, $runner, $spec.Mode)
    }
    exit 0
}

$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')

if ($Remove) {
    foreach ($spec in $taskSpecs) {
        try { $folder.DeleteTask($spec.Name, 0) } catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
    }
    Write-Output 'TubePulse Android build tasks removed.'
    exit 0
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($spec in $taskSpecs) {
    $definition = $service.NewTask(0)
    $definition.RegistrationInfo.Description = "Bounded TubePulse Android $($spec.Mode) runner; current-user, on-demand, non-elevated."
    $definition.Principal.UserId = $identity
    $definition.Principal.LogonType = 3
    $definition.Principal.RunLevel = 0
    $definition.Settings.Enabled = $true
    $definition.Settings.Hidden = $true
    $definition.Settings.AllowDemandStart = $true
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $definition.Settings.ExecutionTimeLimit = 'PT30M'
    $definition.Settings.MultipleInstances = 2

    $action = $definition.Actions.Create(0)
    $action.Path = $powershell
    $action.Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Mode $($spec.Mode)"
    $action.WorkingDirectory = $repo

    $null = $folder.RegisterTaskDefinition($spec.Name, $definition, 6, $null, $null, 3, $null)
}

Write-Output "TubePulse Android build tasks registered for $identity at limited run level."
