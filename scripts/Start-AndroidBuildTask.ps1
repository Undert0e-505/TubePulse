[CmdletBinding()]
param(
    [ValidateSet('Preflight', 'Official', 'Preview')]
    [string]$Mode = 'Official'
)

$taskName = "TubePulse Android Build $Mode"
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$statusPath = Join-Path $repo ("logs\build-runner\{0}.status.json" -f $Mode.ToLowerInvariant())
$started = [DateTimeOffset]::UtcNow

Start-ScheduledTask -TaskName $taskName
Write-Output "Started $taskName at $($started.ToString('o'))."
Write-Output "Status: $statusPath"
