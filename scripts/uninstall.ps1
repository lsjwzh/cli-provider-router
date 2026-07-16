[CmdletBinding()]
param(
    [string]$InstallRoot = $(if ($env:CPR_INSTALL_ROOT) { $env:CPR_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'cli-provider-router' }),
    [string]$BinDir = $(if ($env:CPR_BIN_DIR) { $env:CPR_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps' }),
    [string]$CprHome = $(if ($env:CPR_HOME) { $env:CPR_HOME } else { Join-Path $HOME '.cli-provider-router' }),
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'

function Test-TakeoverActive([object]$State) {
    $Entries = @($State, $State.ccSwitch, $State.ccswitch, $State.takeover, $State.integration) | Where-Object { $null -ne $_ }
    foreach ($Entry in $Entries) {
        if ($Entry.takeoverActive -eq $true -or $Entry.active -eq $true) { return $true }
        if (@('active', 'applying', 'restoring') -contains ([string]$Entry.status).ToLowerInvariant()) { return $true }
    }
    return $false
}

foreach ($StateFile in @((Join-Path $CprHome 'data\integration-state.json'), (Join-Path $CprHome 'integration-state.json'))) {
    if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) { continue }
    try { $State = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json }
    catch { throw "cannot validate integration state ${StateFile}: $($_.Exception.Message)" }
    if (Test-TakeoverActive $State) {
        throw "CC-Switch takeover is active according to $StateFile. Restore CC-Switch endpoints before uninstalling."
    }
}

$Shim = Join-Path $BinDir 'cpr.cmd'
if (Test-Path -LiteralPath $Shim -PathType Leaf) {
    $Content = Get-Content -LiteralPath $Shim -Raw
    if ($Content.Contains($InstallRoot)) { Remove-Item -LiteralPath $Shim -Force }
}
Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Removed cli-provider-router application files from $InstallRoot"

if ($Purge) {
    Remove-Item -LiteralPath $CprHome -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Purged CPR data from $CprHome"
} else {
    Write-Host "Preserved CPR data at $CprHome"
    Write-Host 'Run again with -Purge only when you intentionally want to delete it.'
}
