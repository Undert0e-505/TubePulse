[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [ValidatePattern('^[A-Za-z0-9 _.-]{1,100}\.lnk$')]
    [string]$ShortcutName = 'TubePulse Home Authority.lnk',

    [Parameter(ParameterSetName = 'Install')]
    [switch]$DryRun,

    [Parameter(Mandatory = $true, ParameterSetName = 'Inspect')]
    [switch]$Inspect,

    [Parameter(Mandatory = $true, ParameterSetName = 'Uninstall')]
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$selfHostDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$startupScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Start-HomeAuthority.ps1'))
$startupDirectory = [IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::Startup))
$shortcutPath = [IO.Path]::GetFullPath((Join-Path $startupDirectory $ShortcutName))
$powerShellPath = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $startupScript

function Assert-ChildPath {
    param([string]$Parent, [string]$Child)
    $prefix = $Parent.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $Child.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Resolved shortcut path escaped the per-user Startup directory: $Child"
    }
}

Assert-ChildPath -Parent $startupDirectory -Child $shortcutPath
foreach ($path in @($startupScript, $powerShellPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required startup file is missing: $path"
    }
}

function Get-ShortcutState {
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
        return [pscustomobject]@{ Installed = $false; Valid = $false; Path = $shortcutPath }
    }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    return [pscustomobject]@{
        Installed = $true
        Valid = $shortcut.TargetPath -eq $powerShellPath -and
            $shortcut.Arguments -eq $arguments -and
            $shortcut.WorkingDirectory -eq $selfHostDirectory
        Path = $shortcutPath
        TargetPath = $shortcut.TargetPath
        Arguments = $shortcut.Arguments
        WorkingDirectory = $shortcut.WorkingDirectory
        WindowStyle = $shortcut.WindowStyle
    }
}

if ($Inspect) {
    Get-ShortcutState | ConvertTo-Json -Compress
    exit 0
}

if ($Uninstall) {
    if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
        Remove-Item -LiteralPath $shortcutPath -Force
    }
    [pscustomobject]@{ Installed = $false; Removed = $true; Path = $shortcutPath } | ConvertTo-Json -Compress
    exit 0
}

$plan = [pscustomobject]@{
    ShortcutPath = $shortcutPath
    TargetPath = $powerShellPath
    Arguments = $arguments
    WorkingDirectory = $selfHostDirectory
    RequiresAdministrator = $false
}
if ($DryRun) {
    [pscustomobject]@{ DryRun = $true; MutatedHost = $false; Plan = $plan } | ConvertTo-Json -Compress -Depth 3
    exit 0
}

[IO.Directory]::CreateDirectory($startupDirectory) | Out-Null
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powerShellPath
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $selfHostDirectory
$shortcut.WindowStyle = 7
$shortcut.Description = 'Starts and verifies the TubePulse Home authority after interactive sign-in.'
$shortcut.Save()

$state = Get-ShortcutState
if (-not $state.Valid) {
    throw 'The per-user Home authority Startup shortcut failed post-write verification.'
}
$state | ConvertTo-Json -Compress
