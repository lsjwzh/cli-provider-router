[CmdletBinding()]
param(
    [string]$InstallRoot = $(if ($env:CPR_INSTALL_ROOT) { $env:CPR_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'cli-provider-router' }),
    [string]$BinDir = $(if ($env:CPR_BIN_DIR) { $env:CPR_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps' }),
    [string]$CprHome = $(if ($env:CPR_HOME) { $env:CPR_HOME } else { Join-Path $HOME '.cli-provider-router' }),
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'

function Test-TakeoverActive([object]$State) {
    if ($null -eq $State -or $State -isnot [PSCustomObject]) { return $true }
    $Phase = ([string]$State.status).ToLowerInvariant()
    return -not (@('inactive', 'restored', 'full-restored') -contains $Phase)
}

function Test-DirectCliTakeoverActive([object]$State) {
    if ($null -eq $State -or $State -isnot [PSCustomObject]) { return $true }
    if ($State.active -eq $false) { return $false }
    $Phase = ([string]$State.status).ToLowerInvariant()
    if (@('inactive', 'restored', 'full-restored') -contains $Phase) { return $false }
    return $true
}

foreach ($StateFile in @((Join-Path $CprHome 'ccswitch\state.json'))) {
    if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) { continue }
    try { $State = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json }
    catch { throw "cannot validate integration state ${StateFile}: $($_.Exception.Message)" }
    if (Test-TakeoverActive $State) {
        throw "CC-Switch takeover is active according to $StateFile. Restore CC-Switch endpoints before uninstalling."
    }
}

$DirectStateDir = Join-Path $CprHome 'direct-cli-config\state'
if (Test-Path -LiteralPath $DirectStateDir -PathType Container) {
    foreach ($StateFile in Get-ChildItem -LiteralPath $DirectStateDir -Filter '*.json' -File) {
        try { $State = Get-Content -LiteralPath $StateFile.FullName -Raw | ConvertFrom-Json }
        catch { throw "cannot validate direct CLI takeover state $($StateFile.FullName): $($_.Exception.Message)" }
        if (Test-DirectCliTakeoverActive $State) {
            $Cli = if ([string]::IsNullOrWhiteSpace([string]$State.cli)) { 'native CLI' } else { [string]$State.cli }
            throw "Direct $Cli configuration takeover is active according to $($StateFile.FullName). Run 'cpr cli-config restore --cli $Cli --yes' before uninstalling. CPR will not restore or delete native CLI configuration automatically."
        }
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
