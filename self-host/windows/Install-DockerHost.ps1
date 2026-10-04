[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$selfHostDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataDir = Join-Path $selfHostDir 'data'
$script:LogPath = Join-Path $dataDir 'docker-host-install.log'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

function Write-InstallLog {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('INFO', 'WARN', 'ERROR')]
        [string]$Level,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    $line = '{0} [{1}] {2}' -f [DateTimeOffset]::Now.ToString('o'), $Level, $Message
    [System.IO.File]::AppendAllText($script:LogPath, $line + [Environment]::NewLine, $utf8NoBom)
    Write-Host $line
}

function Get-DockerDesktopExecutable {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Docker\Docker\Docker Desktop.exe')
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [System.IO.Path]::GetFullPath($candidate)
        }
    }

    return $null
}

function Test-TrustedDockerInstaller {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.FileInfo]$File
    )

    if ($File.Name -notmatch '^Docker(?:%20| )Desktop(?:%20| )Installer\.exe$') {
        return $false
    }

    try {
        $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
    } catch {
        Write-InstallLog -Level 'WARN' -Message "Could not inspect installer signature at '$($File.FullName)': $($_.Exception.Message)"
        return $false
    }

    $signerSubject = if ($null -ne $signature.SignerCertificate) {
        [string]$signature.SignerCertificate.Subject
    } else {
        ''
    }
    $isDockerSigner = $signerSubject -match '(^|,\s*)(CN|O)=Docker Inc(,|$)'
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or -not $isDockerSigner) {
        Write-InstallLog -Level 'WARN' -Message "Rejected cached installer '$($File.FullName)' (signature status: $($signature.Status); Docker Inc signer: $isDockerSigner)."
        return $false
    }

    return $true
}

function Get-TrustedCachedDockerInstaller {
    $cacheRootCandidates = New-Object System.Collections.Generic.List[string]
    $cacheRootCandidates.Add((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp\WinGet'))
    if (-not [string]::IsNullOrWhiteSpace($env:TEMP)) {
        $cacheRootCandidates.Add((Join-Path $env:TEMP 'WinGet'))
    }

    # Elevation may use a different administrator account than the account
    # that populated winget's cache. Registered profile paths let the elevated
    # helper find that cache without trusting it: every executable still has
    # to pass the Docker Inc Authenticode check below.
    $profileListKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\*'
    $registeredProfiles = @(Get-ItemProperty -Path $profileListKey -ErrorAction SilentlyContinue |
        ForEach-Object { [Environment]::ExpandEnvironmentVariables([string]$_.ProfileImagePath) } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Sort-Object -Unique)
    foreach ($profilePath in $registeredProfiles) {
        $cacheRootCandidates.Add((Join-Path $profilePath 'AppData\Local\Temp\WinGet'))
    }

    $cacheRoots = @($cacheRootCandidates | Sort-Object -Unique)

    $candidates = New-Object System.Collections.Generic.List[System.IO.FileInfo]
    foreach ($cacheRoot in $cacheRoots) {
        if (-not (Test-Path -LiteralPath $cacheRoot -PathType Container -ErrorAction SilentlyContinue)) {
            continue
        }

        $packageDirectories = @(Get-ChildItem -LiteralPath $cacheRoot -Directory -Filter 'Docker.DockerDesktop.*' -ErrorAction SilentlyContinue)
        foreach ($packageDirectory in $packageDirectories) {
            $files = @(Get-ChildItem -LiteralPath $packageDirectory.FullName -File -Filter '*.exe' -ErrorAction SilentlyContinue)
            foreach ($file in $files) {
                if ($file.Name -match '^Docker(?:%20| )Desktop(?:%20| )Installer\.exe$') {
                    $candidates.Add($file)
                }
            }
        }
    }

    $uniqueCandidates = @($candidates | Sort-Object -Property FullName -Unique)
    foreach ($candidate in @($uniqueCandidates | Sort-Object LastWriteTimeUtc -Descending)) {
        if (Test-TrustedDockerInstaller -File $candidate) {
            return $candidate
        }
    }

    return $null
}

function Get-WingetExecutable {
    $command = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
        return $command.Source
    }

    $userAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
    if (Test-Path -LiteralPath $userAlias -PathType Leaf) {
        return $userAlias
    }

    return $null
}

function Invoke-SignedCachedInstaller {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.FileInfo]$Installer
    )

    $hash = (Get-FileHash -LiteralPath $Installer.FullName -Algorithm SHA256).Hash

    # Revalidate after reading the file and immediately before execution; the
    # cache path alone is never treated as a trust boundary.
    if (-not (Test-TrustedDockerInstaller -File $Installer)) {
        throw "Cached Docker installer failed signature revalidation: $($Installer.FullName)"
    }

    Write-InstallLog -Level 'INFO' -Message "Using Docker Inc-signed cached installer '$($Installer.FullName)' (SHA-256 $hash)."
    Write-InstallLog -Level 'INFO' -Message 'Starting Docker Desktop installer with accepted license, quiet mode, and the WSL 2 backend. No reboot command will be issued.'

    $process = Start-Process `
        -FilePath $Installer.FullName `
        -ArgumentList @('install', '--accept-license', '--quiet', '--backend=wsl-2') `
        -Wait `
        -PassThru
    $exitCode = $process.ExitCode
    Write-InstallLog -Level $(if ($exitCode -in @(0, 3010)) { 'INFO' } else { 'WARN' }) -Message "Docker Desktop installer exited with code $exitCode."

    return $exitCode
}

function Invoke-WingetInstall {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WingetPath
    )

    Write-InstallLog -Level 'INFO' -Message "Falling back to winget at '$WingetPath'."
    $output = @(& $WingetPath install `
        --id Docker.DockerDesktop `
        --exact `
        --source winget `
        --silent `
        --accept-package-agreements `
        --accept-source-agreements `
        --disable-interactivity 2>&1)
    $exitCode = $LASTEXITCODE
    foreach ($line in $output) {
        if (-not [string]::IsNullOrWhiteSpace([string]$line)) {
            Write-InstallLog -Level 'INFO' -Message ('winget: ' + [string]$line)
        }
    }
    Write-InstallLog -Level $(if ($exitCode -eq 0) { 'INFO' } else { 'WARN' }) -Message "winget exited with code $exitCode."

    return $exitCode
}

function Assert-OrCreateFirewallRule {
    $ruleName = 'TubePulse Self-Host 8788 (Private)'
    $existingRules = @(Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)
    if ($existingRules.Count -gt 1) {
        throw "More than one firewall rule named '$ruleName' exists; review them manually."
    }

    if ($existingRules.Count -eq 0) {
        New-NetFirewallRule `
            -DisplayName $ruleName `
            -Description 'Allow TubePulse self-host test API from this private LAN only.' `
            -Direction Inbound `
            -Action Allow `
            -Enabled True `
            -Profile Private `
            -Protocol TCP `
            -LocalPort 8788 `
            -RemoteAddress LocalSubnet | Out-Null
        Write-InstallLog -Level 'INFO' -Message "Created firewall rule '$ruleName' for Private-profile LocalSubnet TCP 8788 only."
        return
    }

    $rule = $existingRules[0]
    $portFilters = @($rule | Get-NetFirewallPortFilter)
    $addressFilters = @($rule | Get-NetFirewallAddressFilter)
    $remoteAddresses = if ($addressFilters.Count -eq 1) { @($addressFilters[0].RemoteAddress) } else { @() }
    $isExpected = (
        [string]$rule.Enabled -eq 'True' -and
        [string]$rule.Direction -eq 'Inbound' -and
        [string]$rule.Action -eq 'Allow' -and
        [string]$rule.Profile -eq 'Private' -and
        $portFilters.Count -eq 1 -and
        [string]$portFilters[0].Protocol -eq 'TCP' -and
        [string]$portFilters[0].LocalPort -eq '8788' -and
        $addressFilters.Count -eq 1 -and
        $remoteAddresses.Count -eq 1 -and
        [string]$remoteAddresses[0] -eq 'LocalSubnet'
    )
    if (-not $isExpected) {
        throw "Firewall rule '$ruleName' exists but is not the expected Private/LocalSubnet TCP 8788 rule."
    }

    Write-InstallLog -Level 'INFO' -Message "Verified existing firewall rule '$ruleName' is limited to Private-profile LocalSubnet TCP 8788."
}

try {
    Write-InstallLog -Level 'INFO' -Message 'TubePulse Docker host installation helper started.'
    Write-InstallLog -Level 'INFO' -Message "Detailed log: $script:LogPath"

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This helper must be launched with Run as administrator.'
    }

    $installerExitCode = $null
    $dockerDesktopPath = Get-DockerDesktopExecutable
    if ([string]::IsNullOrWhiteSpace($dockerDesktopPath)) {
        $trustedInstaller = Get-TrustedCachedDockerInstaller
        if ($null -ne $trustedInstaller) {
            try {
                $installerExitCode = Invoke-SignedCachedInstaller -Installer $trustedInstaller
            } catch {
                Write-InstallLog -Level 'WARN' -Message "Direct cached-installer attempt failed: $($_.Exception.Message)"
            }
        } else {
            Write-InstallLog -Level 'WARN' -Message 'No valid Docker Inc-signed installer was found in the local winget cache.'
        }

        $dockerDesktopPath = Get-DockerDesktopExecutable
        if ([string]::IsNullOrWhiteSpace($dockerDesktopPath) -or $installerExitCode -notin @(0, 3010)) {
            $winget = Get-WingetExecutable
            if ([string]::IsNullOrWhiteSpace($winget)) {
                throw "Docker Desktop is still absent and winget is unavailable. See '$script:LogPath'."
            }

            $wingetExitCode = Invoke-WingetInstall -WingetPath $winget
            $dockerDesktopPath = Get-DockerDesktopExecutable
            if ($wingetExitCode -ne 0 -and [string]::IsNullOrWhiteSpace($dockerDesktopPath)) {
                throw "Docker Desktop installation failed with winget exit code $wingetExitCode. See '$script:LogPath'."
            }
        }
    } else {
        Write-InstallLog -Level 'INFO' -Message "Docker Desktop is already installed at '$dockerDesktopPath'; installer steps were skipped."
    }

    $dockerDesktopPath = Get-DockerDesktopExecutable
    if ([string]::IsNullOrWhiteSpace($dockerDesktopPath)) {
        throw "Docker Desktop was not found after installation. See '$script:LogPath'."
    }

    Assert-OrCreateFirewallRule

    Write-InstallLog -Level 'INFO' -Message "Docker Desktop is installed at '$dockerDesktopPath'."
    if ($installerExitCode -eq 3010) {
        Write-InstallLog -Level 'WARN' -Message 'The installer reported that Windows should be restarted. This helper did not request a reboot.'
    } else {
        Write-InstallLog -Level 'INFO' -Message 'No reboot was requested by this helper.'
    }
    Write-Host "Installation log: $script:LogPath"
} catch {
    $position = if ($null -ne $_.InvocationInfo -and -not [string]::IsNullOrWhiteSpace($_.InvocationInfo.PositionMessage)) {
        ' ' + ($_.InvocationInfo.PositionMessage -replace '[\r\n]+', ' ')
    } else {
        ''
    }
    Write-InstallLog -Level 'ERROR' -Message ($_.Exception.Message + $position)
    Write-Error "Docker host setup failed. See '$script:LogPath'. $($_.Exception.Message)"
    exit 1
}
