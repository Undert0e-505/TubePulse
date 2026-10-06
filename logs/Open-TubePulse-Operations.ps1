[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcher = [IO.Path]::GetFullPath((Join-Path $repoRoot 'monitoring\windows\Start-TubePulseMonitoring.ps1'))
$prefix = $repoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $launcher.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw 'Tracked monitoring launcher was not found inside the repository.'
}
& $launcher -OpenDashboard
