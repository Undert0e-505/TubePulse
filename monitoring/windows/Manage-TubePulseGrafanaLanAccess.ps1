[CmdletBinding()]
param(
    [ValidateSet('Install', 'Inspect', 'Remove')]
    [string]$Mode = 'Inspect',
    [ValidateRange(3000, 3000)]
    [int]$LocalPort = 3000,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ruleName = 'TubePulse-Grafana-LAN'
$displayName = 'TubePulse Grafana LAN'
$excludedInterfaces = '(?i)(docker|wsl|vethernet|hyper-v|loopback|vpn|tailscale|wireguard|zerotier)'

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-PrivateLanContext {
    $routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.NextHop -ne '0.0.0.0' -and $_.InterfaceAlias -notmatch $excludedInterfaces } |
        Sort-Object RouteMetric, InterfaceMetric)
    foreach ($route in $routes) {
        $adapter = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue
        if ($null -eq $adapter -or $adapter.Status -ne 'Up' -or -not $adapter.HardwareInterface -or $adapter.Virtual) { continue }
        $profile = Get-NetConnectionProfile -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue
        $address = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' } |
            Select-Object -First 1
        if ($null -eq $profile -or $null -eq $address) { continue }
        return [pscustomobject]@{
            InterfaceAlias = [string]$route.InterfaceAlias
            InterfaceIndex = [int]$route.InterfaceIndex
            Address = [string]$address.IPAddress
            PrefixLength = [int]$address.PrefixLength
            NetworkCategory = [string]$profile.NetworkCategory
        }
    }
    throw 'No eligible physical default-route IPv4 LAN interface was found.'
}

function Get-RuleInspection {
    param([object]$Lan)
    $rules = @(Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)
    if ($rules.Count -eq 0) {
        return [pscustomobject]@{
            Installed = $false; Exact = $false; Enabled = $false; PrivateOnly = $false
            InboundAllow = $false; Tcp3000 = $false; LocalSubnetOnly = $false
            ActiveInterfaceOnly = $false; PublicRulePresent = $false
        }
    }
    $rule = $rules[0]
    $port = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule
    $address = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule
    $interface = Get-NetFirewallInterfaceFilter -AssociatedNetFirewallRule $rule
    $privateOnly = [string]$rule.Profile -eq 'Private'
    $tcp3000 = [string]$port.Protocol -eq 'TCP' -and [string]$port.LocalPort -eq [string]$LocalPort
    $localSubnetOnly = @($address.RemoteAddress).Count -eq 1 -and [string]@($address.RemoteAddress)[0] -eq 'LocalSubnet'
    $activeInterfaceOnly = @($interface.InterfaceAlias).Count -eq 1 -and [string]@($interface.InterfaceAlias)[0] -eq [string]$Lan.InterfaceAlias
    $inboundAllow = [string]$rule.Direction -eq 'Inbound' -and [string]$rule.Action -eq 'Allow'
    $enabled = [string]$rule.Enabled -eq 'True'
    return [pscustomobject]@{
        Installed = $true
        Exact = $rules.Count -eq 1 -and $enabled -and $privateOnly -and $inboundAllow -and $tcp3000 -and $localSubnetOnly -and $activeInterfaceOnly
        Enabled = $enabled
        PrivateOnly = $privateOnly
        InboundAllow = $inboundAllow
        Tcp3000 = $tcp3000
        LocalSubnetOnly = $localSubnetOnly
        ActiveInterfaceOnly = $activeInterfaceOnly
        PublicRulePresent = -not $privateOnly
    }
}

$lan = Get-PrivateLanContext
$inspection = Get-RuleInspection -Lan $lan

if ($DryRun) {
    [pscustomobject]@{
        DryRun = $true
        Mode = $Mode
        RuleName = $displayName
        LanUrl = "http://$($lan.Address):$LocalPort/d/tubepulse-operations/tubepulse-operations"
        NetworkCategory = $lan.NetworkCategory
        PlannedProfile = 'Private'
        PlannedRemoteAddress = 'LocalSubnet'
        PlannedInterface = $lan.InterfaceAlias
        ExistingRuleExact = $inspection.Exact
        MutatedHost = $false
    } | ConvertTo-Json -Compress
    exit 0
}

if ($Mode -eq 'Inspect') {
    [pscustomobject]@{
        Mode = $Mode
        RuleName = $displayName
        LanUrl = "http://$($lan.Address):$LocalPort/d/tubepulse-operations/tubepulse-operations"
        NetworkCategory = $lan.NetworkCategory
        Rule = $inspection
    } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}

if (-not (Test-IsAdministrator)) {
    throw 'Administrator elevation is required to install or remove the scoped Windows Firewall rule.'
}

if ($Mode -eq 'Remove') {
    if ($inspection.Installed) { Remove-NetFirewallRule -Name $ruleName }
    [pscustomobject]@{ Mode = $Mode; Removed = $inspection.Installed; RuleName = $displayName } | ConvertTo-Json -Compress
    exit 0
}

if ($lan.NetworkCategory -ne 'Private') {
    throw 'The active LAN connection is not Private. Refusing to create a firewall rule or change the network category.'
}
if (-not $inspection.Exact) {
    if ($inspection.Installed) { Remove-NetFirewallRule -Name $ruleName }
    New-NetFirewallRule -Name $ruleName -DisplayName $displayName -Description 'Allow aggregate-only TubePulse Grafana from this private LAN subnet.' `
        -Enabled True -Direction Inbound -Action Allow -Profile Private -InterfaceAlias $lan.InterfaceAlias `
        -Protocol TCP -LocalPort $LocalPort -LocalAddress Any -RemoteAddress LocalSubnet -EdgeTraversalPolicy Block | Out-Null
}
$after = Get-RuleInspection -Lan $lan
if (-not $after.Exact) { throw 'The TubePulse Grafana firewall rule did not match the required restricted scope.' }
[pscustomobject]@{
    Mode = $Mode
    Installed = $true
    Changed = -not $inspection.Exact
    RuleName = $displayName
    LanUrl = "http://$($lan.Address):$LocalPort/d/tubepulse-operations/tubepulse-operations"
    Rule = $after
} | ConvertTo-Json -Depth 4 -Compress
