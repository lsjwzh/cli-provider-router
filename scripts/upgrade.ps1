[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-Za-z][0-9A-Za-z._+-]*$')][string]$Version,
    [string]$Source = (Split-Path -Parent $PSScriptRoot),
    [string]$InstallRoot = $(if ($env:CPR_INSTALL_ROOT) { $env:CPR_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'cli-provider-router' }),
    [string]$BinDir = $(if ($env:CPR_BIN_DIR) { $env:CPR_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps' }),
    [string]$CprHome = $(if ($env:CPR_HOME) { $env:CPR_HOME } else { Join-Path $HOME '.cli-provider-router' }),
    [ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedSha256,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$CurrentFile = Join-Path $InstallRoot 'current.txt'
$InstallScript = Join-Path $PSScriptRoot 'install.ps1'
if (-not (Test-Path -LiteralPath $CurrentFile -PathType Leaf)) {
    throw "no existing immutable installation at $CurrentFile; run install.ps1 first"
}
$HomeFull = [IO.Path]::GetFullPath($CprHome)
if ($HomeFull -eq [IO.Path]::GetPathRoot($HomeFull)) { throw "unsafe CPR_HOME: $CprHome" }

$InstallParameters = @{
    Source = $Source; Version = $Version; InstallRoot = $InstallRoot
    BinDir = $BinDir; CprHome = $CprHome
}
if ($ExpectedSha256) { $InstallParameters.ExpectedSha256 = $ExpectedSha256 }
if ($DryRun) {
    & $InstallScript @InstallParameters -DryRun
    return
}

# Validate source, version, syntax and tools before creating a backup or
# touching the active service.
& $InstallScript @InstallParameters -DryRun | Out-Null

$OldTarget = (Get-Content -LiteralPath $CurrentFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($OldTarget)) { throw "empty active artifact pointer at $CurrentFile" }
$OldDir = [IO.Path]::GetFullPath($OldTarget)
$OldCpr = Join-Path $OldDir 'node_modules\.bin\cpr.cmd'
if (-not (Test-Path -LiteralPath $OldCpr -PathType Leaf)) { throw "previous cpr executable is missing at $OldCpr" }

$PreviousHome = $env:CPR_HOME
$PreviousDataFile = $env:CPR_DATA_FILE
$PreviousLifecycle = $env:CPR_LIFECYCLE_OPERATION
$env:CPR_HOME = $CprHome
$env:CPR_DATA_FILE = Join-Path $CprHome 'data\providers.json'
$env:CPR_LIFECYCLE_OPERATION = 'upgrade'

function Invoke-CprCapture([string]$Command, [string[]]$Arguments) {
    $Output = (& $Command @Arguments 2>&1 | Out-String).Trim()
    return @{ ExitCode = $LASTEXITCODE; Output = $Output }
}

function Write-AtomicText([string]$File, [string]$Value) {
    $Temp = "$File.$PID.tmp"
    [IO.File]::WriteAllText($Temp, $Value + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $Temp -Destination $File -Force
}

$Timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$BackupDir = Join-Path $InstallRoot "backups\upgrade-$Timestamp-$PID"
$HomeBackup = Join-Path $BackupDir 'cpr-home'
$HomeExisted = Test-Path -LiteralPath $CprHome -PathType Container
$WasRunning = $false
$ServicePort = 4567
$ServiceWebPort = 4568
$PointerSwitched = $false
$NewServiceStarted = $false
$OldServiceStopped = $false
$BackupReady = $false
$CandidateDir = $null

try {
    $Status = Invoke-CprCapture $OldCpr @('status')
    $WasRunning = $Status.ExitCode -eq 0
    if (-not $WasRunning -and $Status.Output -match 'unhealthy') {
        throw 'existing service is unhealthy; repair or stop it before upgrade'
    }

    $ServiceStateFile = Join-Path $CprHome 'run\service.json'
    if (Test-Path -LiteralPath $ServiceStateFile -PathType Leaf) {
        try {
            $ServiceState = Get-Content -LiteralPath $ServiceStateFile -Raw | ConvertFrom-Json
            if ([int]$ServiceState.port -gt 0) { $ServicePort = [int]$ServiceState.port }
            elseif ([int]$ServiceState.proxyPort -gt 0) { $ServicePort = [int]$ServiceState.proxyPort }
            if ([int]$ServiceState.webPort -gt 0) { $ServiceWebPort = [int]$ServiceState.webPort }
            else { $ServiceWebPort = $ServicePort + 1 }
        } catch { throw "cannot read existing service state ${ServiceStateFile}: $($_.Exception.Message)" }
    }

    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    if ($HomeExisted) { Copy-Item -LiteralPath $CprHome -Destination $HomeBackup -Recurse -Force }
    $OldManifest = Join-Path $OldDir 'release-manifest.json'
    if (Test-Path -LiteralPath $OldManifest -PathType Leaf) {
        Copy-Item -LiteralPath $OldManifest -Destination (Join-Path $BackupDir 'previous-release-manifest.json')
    }
    @(
        "previous=$OldTarget", "previousDir=$OldDir", "targetVersion=$Version",
        "createdAt=$Timestamp", "serviceWasRunning=$WasRunning",
        "ports=$ServicePort,$ServiceWebPort"
    ) | Set-Content -LiteralPath (Join-Path $BackupDir 'upgrade.txt') -Encoding UTF8
    $BackupReady = $true

    $ResultFile = Join-Path $BackupDir 'candidate.json'
    & $InstallScript @InstallParameters -NoActivate -ResultFile $ResultFile
    $Candidate = Get-Content -LiteralPath $ResultFile -Raw | ConvertFrom-Json
    $CandidateDir = [string]$Candidate.finalDir
    $CandidateCpr = Join-Path $CandidateDir 'node_modules\.bin\cpr.cmd'
    if (-not (Test-Path -LiteralPath $CandidateCpr -PathType Leaf)) { throw "candidate executable is missing at $CandidateCpr" }
    $CandidateVersion = ((& $CandidateCpr --version) | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $CandidateVersion -ne $Version) { throw "candidate version check failed ($CandidateVersion)" }
    & $CandidateCpr doctor | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'candidate cpr doctor failed' }

    if ($WasRunning) {
        & $OldCpr stop | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'previous service did not stop cleanly' }
        $OldServiceStopped = $true
    }

    Write-AtomicText $CurrentFile $CandidateDir
    $PointerSwitched = $true
    $Shim = Join-Path $BinDir 'cpr.cmd'
    $ActiveVersion = ((& $Shim --version) | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $ActiveVersion -ne $Version) { throw "active version check failed ($ActiveVersion)" }
    & $Shim doctor | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'active cpr doctor failed' }

    if ($WasRunning) {
        & $Shim start --port $ServicePort --web-port $ServiceWebPort | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'candidate service failed to start' }
        $NewServiceStarted = $true
        & $Shim status | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'candidate service failed its health check' }
    }

    # Deterministic, repository-only rollback test hook.
    if ($env:CPR_UPGRADE_TEST_FAIL_AFTER_HEALTH -eq '1') { throw 'test hook: failing after candidate health' }

    Write-Host "Upgrade to $Version completed"
    Write-Host "  from:    $OldDir"
    Write-Host "  to:      $CandidateDir"
    Write-Host "  backup:  $BackupDir"
    Write-Host "  service: $(if ($WasRunning) { 'restarted-and-healthy' } else { 'remained-stopped' })"
    Write-Host "  data:    $CprHome"
} catch {
    $OriginalError = $_
    $RollbackErrors = [System.Collections.Generic.List[string]]::new()
    try {
        if ($NewServiceStarted) {
            $Shim = Join-Path $BinDir 'cpr.cmd'
            & $Shim stop | Out-Null
        }
    } catch { $RollbackErrors.Add("stop candidate: $($_.Exception.Message)") }
    try {
        if ($PointerSwitched) { Write-AtomicText $CurrentFile $OldTarget }
    } catch { $RollbackErrors.Add("restore pointer: $($_.Exception.Message)") }
    if ($BackupReady) {
        try {
            if ($WasRunning -and -not $OldServiceStopped) {
                & $OldCpr stop | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'old service did not stop before data restore' }
                $OldServiceStopped = $true
            }
            Remove-Item -LiteralPath $CprHome -Recurse -Force -ErrorAction SilentlyContinue
            if ($HomeExisted) { Copy-Item -LiteralPath $HomeBackup -Destination $CprHome -Recurse -Force }
        } catch { $RollbackErrors.Add("restore CPR_HOME: $($_.Exception.Message)") }
    }
    try {
        if ($WasRunning -and $OldServiceStopped) {
            & $OldCpr start --port $ServicePort --web-port $ServiceWebPort | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'old service start returned non-zero' }
            & $OldCpr status | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'old service is not healthy' }
        }
    } catch { $RollbackErrors.Add("restart previous service: $($_.Exception.Message)") }

    if ($RollbackErrors.Count -gt 0) {
        throw "upgrade failed and rollback was incomplete; backup: ${BackupDir}; rollback errors: $($RollbackErrors -join '; '); original: $($OriginalError.Exception.Message)"
    }
    throw "upgrade failed; previous artifact, data and service state restored; backup: ${BackupDir}; original: $($OriginalError.Exception.Message)"
} finally {
    $env:CPR_HOME = $PreviousHome
    $env:CPR_DATA_FILE = $PreviousDataFile
    $env:CPR_LIFECYCLE_OPERATION = $PreviousLifecycle
}
