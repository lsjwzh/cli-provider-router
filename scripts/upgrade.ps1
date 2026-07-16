[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-Za-z][0-9A-Za-z._+-]*$')][string]$Version,
    [string]$Source = (Split-Path -Parent $PSScriptRoot),
    [string]$InstallRoot = $(if ($env:CPR_INSTALL_ROOT) { $env:CPR_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'cli-provider-router' }),
    [string]$BinDir = $(if ($env:CPR_BIN_DIR) { $env:CPR_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps' }),
    [string]$CprHome = $(if ($env:CPR_HOME) { $env:CPR_HOME } else { Join-Path $HOME '.cli-provider-router' }),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$CurrentFile = Join-Path $InstallRoot 'current.txt'
if (-not (Test-Path -LiteralPath $CurrentFile -PathType Leaf)) {
    throw "no existing source-script installation at $CurrentFile; run install.ps1 first"
}

$InstallScript = Join-Path $PSScriptRoot 'install.ps1'
if ($DryRun) {
    & $InstallScript -Source $Source -Version $Version -InstallRoot $InstallRoot -BinDir $BinDir -CprHome $CprHome -DryRun
    return
}

$Timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$BackupDir = Join-Path $InstallRoot "backups\upgrade-$Timestamp"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$OldTarget = (Get-Content -LiteralPath $CurrentFile -Raw).Trim()

if (Test-Path -LiteralPath $CprHome -PathType Container) {
    $Items = @(Get-ChildItem -LiteralPath $CprHome -Force)
    if ($Items.Count -gt 0) {
        Compress-Archive -Path (Join-Path $CprHome '*') -DestinationPath (Join-Path $BackupDir 'cpr-home.zip') -Force
    }
}
@("previous=$OldTarget", "targetVersion=$Version", "createdAt=$Timestamp") |
    Set-Content -LiteralPath (Join-Path $BackupDir 'upgrade.txt') -Encoding UTF8

function Restore-PreviousPointer {
    $Temp = "$CurrentFile.$PID.rollback"
    [IO.File]::WriteAllText($Temp, $OldTarget + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $Temp -Destination $CurrentFile -Force
    Write-Warning "Restored previous application pointer: $OldTarget"
}

try {
    & $InstallScript -Source $Source -Version $Version -InstallRoot $InstallRoot -BinDir $BinDir -CprHome $CprHome -Force
    $Shim = Join-Path $BinDir 'cpr.cmd'
    & $Shim --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'post-upgrade version health check failed' }
    & $Shim doctor | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'post-upgrade cpr doctor failed' }
} catch {
    Restore-PreviousPointer
    throw "upgrade failed; data backup retained at ${BackupDir}: $($_.Exception.Message)"
}

Write-Host "Upgrade to $Version completed"
Write-Host "  backup: $BackupDir"
Write-Host "  data was preserved at: $CprHome"
