[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-Za-z][0-9A-Za-z._+-]*$')][string]$Version,
    [string]$Source = (Split-Path -Parent $PSScriptRoot),
    [string]$InstallRoot = $(if ($env:CPR_INSTALL_ROOT) { $env:CPR_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'cli-provider-router' }),
    [string]$BinDir = $(if ($env:CPR_BIN_DIR) { $env:CPR_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps' }),
    [string]$CprHome = $(if ($env:CPR_HOME) { $env:CPR_HOME } else { Join-Path $HOME '.cli-provider-router' }),
    [ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedSha256,
    [string]$ResultFile,
    [switch]$NoActivate,
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
if ($Force) { Write-Warning '-Force is deprecated; immutable artifacts are verified/reused and never overwritten' }
$Source = (Resolve-Path -LiteralPath $Source).Path
$PackageJson = Join-Path $Source 'package.json'
if (-not (Test-Path -LiteralPath $PackageJson -PathType Leaf)) { throw "package.json not found under $Source" }

foreach ($Command in @('node', 'npm')) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { throw "$Command is required" }
}
$NodeMajor = [int]((& node -p 'Number(process.versions.node.split(".")[0])').Trim())
if ($NodeMajor -lt 18) { throw "Node.js 18+ is required (found $(& node --version))" }
$NodeAbi = ((& node -p 'process.versions.modules') | Out-String).Trim()

$Package = Get-Content -LiteralPath $PackageJson -Raw | ConvertFrom-Json
if ([string]$Package.version -ne $Version) { throw "requested version $Version does not match package.json version $($Package.version)" }
foreach ($Relative in @('cli/index.js', 'lib/index.js', 'lib/api-metadata.js', 'package-lock.json', 'types/index.d.ts')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Source $Relative) -PathType Leaf)) { throw "required source file missing: $Relative" }
}
Get-ChildItem -LiteralPath (Join-Path $Source 'lib'), (Join-Path $Source 'cli'), (Join-Path $Source 'scripts') -Filter '*.js' -File -Recurse | ForEach-Object {
    & node --check $_.FullName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax check failed: $($_.FullName)" }
}

$SourceCommit = $env:CPR_SOURCE_COMMIT
if (-not $SourceCommit -and (Get-Command git -ErrorAction SilentlyContinue)) {
    $CommitOutput = (& git -C $Source rev-parse HEAD 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -eq 0) { $SourceCommit = $CommitOutput }
}
if ($SourceCommit -notmatch '^[0-9a-fA-F]{40}$') { $SourceCommit = 'unknown' }
$SourceDirty = $false
if ($SourceCommit -ne 'unknown') {
    $DirtyOutput = (& git -C $Source status --porcelain 2>$null | Out-String).Trim()
    $SourceDirty = [bool]$DirtyOutput
}
$LockSha256 = (Get-FileHash -LiteralPath (Join-Path $Source 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()

if ($DryRun) {
    Write-Host "dry-run ok: source=$Source version=$Version commit=$SourceCommit node=$(& node --version) ABI=$NodeAbi"
    Write-Host "would pack, verify, and install under $(Join-Path $InstallRoot 'versions\<version>-<commit>-<tar-sha>')"
    return
}

$VersionsDir = Join-Path $InstallRoot 'versions'
$ArtifactsDir = Join-Path $InstallRoot 'artifacts'
foreach ($Directory in @($VersionsDir, $ArtifactsDir, $BinDir, (Join-Path $CprHome 'data'), (Join-Path $CprHome 'config'),
        (Join-Path $CprHome 'backups'), (Join-Path $CprHome 'logs'), (Join-Path $CprHome 'run'))) {
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
}

$Temp = Join-Path ([IO.Path]::GetTempPath()) ("cpr-install-" + [guid]::NewGuid().ToString('N'))
$Stage = $null
New-Item -ItemType Directory -Force -Path $Temp | Out-Null
try {
    Push-Location $Source
    try {
        & npm pack --ignore-scripts --pack-destination $Temp | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }
    } finally { Pop-Location }
    $Archives = @(Get-ChildItem -LiteralPath $Temp -Filter '*.tgz' -File)
    if ($Archives.Count -ne 1) { throw 'npm pack did not produce exactly one archive' }
    $Archive = $Archives[0].FullName
    $ArchiveSha256 = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ExpectedSha256 -and $ArchiveSha256 -ne $ExpectedSha256.ToLowerInvariant()) {
        throw "package SHA-256 mismatch (expected $ExpectedSha256, got $ArchiveSha256)"
    }
    Write-Host "Package SHA-256: $ArchiveSha256"

    $CommitId = if ($SourceCommit -eq 'unknown') { 'unknown' } else { $SourceCommit.Substring(0, 12) }
    $ArtifactId = "$Version-$CommitId-$($ArchiveSha256.Substring(0, 12))"
    $FinalDir = Join-Path $VersionsDir $ArtifactId
    $ArchiveCopy = Join-Path $ArtifactsDir "$ArtifactId.tgz"
    $Stage = Join-Path $VersionsDir (".$ArtifactId.stage." + $PID)

    if (Test-Path -LiteralPath $FinalDir) {
        $ManifestFile = Join-Path $FinalDir 'release-manifest.json'
        $Existing = if (Test-Path -LiteralPath $ManifestFile) { Get-Content -LiteralPath $ManifestFile -Raw | ConvertFrom-Json } else { $null }
        if (-not $Existing -or [string]$Existing.tarSha256 -ne $ArchiveSha256) { throw "immutable artifact identity collision at $FinalDir" }
        Write-Host "Verified existing immutable artifact: $ArtifactId"
    } else {
        Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path $Stage | Out-Null
        & npm install --prefix $Stage --no-audit --no-fund --include=optional $Archive
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

        function Test-SqliteRuntime([string]$Prefix) {
            Push-Location $Prefix
            try {
                & node -e 'const r=require("./node_modules/cli-provider-router/lib/sqlite-runtime").sqliteRuntimeStatus(); process.exit(r.available ? 0 : 1)' *> $null
                return ($LASTEXITCODE -eq 0)
            } finally { Pop-Location }
        }
        if (-not (Test-SqliteRuntime $Stage)) {
            Write-Host "Rebuilding optional SQLite support for $(& node --version) ABI $NodeAbi ..."
            & npm rebuild --prefix $Stage better-sqlite3 *> $null
        }
        if (-not (Test-SqliteRuntime $Stage)) { Write-Warning 'SQLite unavailable; repair this exact install with: cpr doctor --repair' }

        $CprCmd = Join-Path $Stage 'node_modules\.bin\cpr.cmd'
        if (-not (Test-Path -LiteralPath $CprCmd -PathType Leaf)) { throw 'installed cpr executable is missing' }
        $OldHome = $env:CPR_HOME; $OldData = $env:CPR_DATA_FILE
        try {
            $env:CPR_HOME = $CprHome; $env:CPR_DATA_FILE = Join-Path $CprHome 'data\providers.json'
            $InstalledVersion = ((& $CprCmd --version) | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or $InstalledVersion -ne $Version) { throw "installed version check failed ($InstalledVersion)" }
            & $CprCmd doctor | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'cpr doctor failed' }
        } finally { $env:CPR_HOME = $OldHome; $env:CPR_DATA_FILE = $OldData }

        $Manifest = [ordered]@{
            schemaVersion = 1; package = 'cli-provider-router'; version = $Version; commit = $SourceCommit
            tarSha256 = $ArchiveSha256; lockSha256 = $LockSha256; nodeAbi = $NodeAbi
            nodeVersion = ((& node --version) | Out-String).Trim(); platform = 'win32'; arch = $env:PROCESSOR_ARCHITECTURE
            sourceDirty = $SourceDirty; artifactId = $ArtifactId; installedAt = (Get-Date).ToUniversalTime().ToString('o')
        }
        [IO.File]::WriteAllText((Join-Path $Stage 'release-manifest.json'), ($Manifest | ConvertTo-Json -Depth 5) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $Stage -Destination $FinalDir
        $Stage = $null
    }

    if (Test-Path -LiteralPath $ArchiveCopy) {
        $ExistingArchiveSha = (Get-FileHash -LiteralPath $ArchiveCopy -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($ExistingArchiveSha -ne $ArchiveSha256) { throw "archived package checksum conflict at $ArchiveCopy" }
    } else {
        Copy-Item -LiteralPath $Archive -Destination $ArchiveCopy
        [IO.File]::WriteAllText("$ArchiveCopy.sha256", "$ArchiveSha256  $([IO.Path]::GetFileName($ArchiveCopy))`n", [Text.UTF8Encoding]::new($false))
    }

    if (-not $NoActivate) {
        $CurrentFile = Join-Path $InstallRoot 'current.txt'
        $CurrentTemp = "$CurrentFile.$PID.tmp"
        [IO.File]::WriteAllText($CurrentTemp, $FinalDir + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $CurrentTemp -Destination $CurrentFile -Force

        $Shim = Join-Path $BinDir 'cpr.cmd'; $ShimTemp = "$Shim.$PID.tmp"
        $Lines = @('@echo off', "if not defined CPR_HOME set `"CPR_HOME=$CprHome`"", 'if not defined CPR_DATA_FILE set "CPR_DATA_FILE=%CPR_HOME%\data\providers.json"', "set /p CPR_CURRENT=<`"$CurrentFile`"", 'node "%CPR_CURRENT%\node_modules\cli-provider-router\cli\index.js" %*')
        [IO.File]::WriteAllLines($ShimTemp, $Lines, [Text.ASCIIEncoding]::new())
        Move-Item -LiteralPath $ShimTemp -Destination $Shim -Force
        & $Shim --version | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'installed command shim failed its version check' }
        & $Shim doctor | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'installed command shim failed cpr doctor' }
    }

    if ($ResultFile) {
        $Result = @{ finalDir = $FinalDir; artifactId = $ArtifactId; activated = -not $NoActivate } | ConvertTo-Json -Compress
        $ResultTemp = "$ResultFile.$PID.tmp"
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ResultFile) | Out-Null
        [IO.File]::WriteAllText($ResultTemp, $Result + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $ResultTemp -Destination $ResultFile -Force
    }

    Write-Host "Installed cli-provider-router $Version"
    Write-Host "  command: $(Join-Path $BinDir 'cpr.cmd')"
    Write-Host "  app:     $FinalDir"
    Write-Host "  data:    $CprHome"
    Write-Host "  sha256:  $ArchiveSha256"
    Write-Host "  commit:  $SourceCommit"
    Write-Host "  ABI:     $NodeAbi"
    if ($NoActivate) { Write-Host '  state:   staged (not active)' }
} finally {
    Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
    if ($Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue }
}
