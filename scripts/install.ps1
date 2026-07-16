[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-Za-z][0-9A-Za-z._+-]*$')][string]$Version,
    [string]$Source = (Split-Path -Parent $PSScriptRoot),
    [string]$InstallRoot = $(if ($env:CPR_INSTALL_ROOT) { $env:CPR_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'cli-provider-router' }),
    [string]$BinDir = $(if ($env:CPR_BIN_DIR) { $env:CPR_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps' }),
    [string]$CprHome = $(if ($env:CPR_HOME) { $env:CPR_HOME } else { Join-Path $HOME '.cli-provider-router' }),
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path -LiteralPath $Source).Path
$PackageJson = Join-Path $Source 'package.json'
if (-not (Test-Path -LiteralPath $PackageJson -PathType Leaf)) { throw "package.json not found under $Source" }

foreach ($Command in @('node', 'npm')) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { throw "$Command is required" }
}
$NodeMajor = [int]((& node -p 'Number(process.versions.node.split(".")[0])').Trim())
if ($NodeMajor -lt 18) { throw "Node.js 18+ is required (found $(& node --version))" }

$Package = Get-Content -LiteralPath $PackageJson -Raw | ConvertFrom-Json
if ([string]$Package.version -ne $Version) {
    throw "requested version $Version does not match package.json version $($Package.version)"
}

foreach ($Relative in @('cli/index.js', 'lib/index.js', 'package-lock.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Source $Relative) -PathType Leaf)) { throw "required source file missing: $Relative" }
}
Get-ChildItem -LiteralPath (Join-Path $Source 'lib'), (Join-Path $Source 'cli') -Filter '*.js' -File -Recurse | ForEach-Object {
    & node --check $_.FullName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax check failed: $($_.FullName)" }
}

if ($DryRun) {
    Write-Host "dry-run ok: source=$Source version=$Version node=$(& node --version)"
    Write-Host "would install to $(Join-Path $InstallRoot "versions\$Version") and create $(Join-Path $BinDir 'cpr.cmd')"
    return
}

$VersionsDir = Join-Path $InstallRoot 'versions'
$FinalDir = Join-Path $VersionsDir $Version
if ((Test-Path -LiteralPath $FinalDir) -and -not $Force) {
    throw "$Version is already installed at $FinalDir (use -Force to rebuild it)"
}

foreach ($Directory in @($VersionsDir, $BinDir, (Join-Path $CprHome 'data'), (Join-Path $CprHome 'config'),
        (Join-Path $CprHome 'backups'), (Join-Path $CprHome 'logs'), (Join-Path $CprHome 'run'))) {
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
}

$Temp = Join-Path ([IO.Path]::GetTempPath()) ("cpr-install-" + [guid]::NewGuid().ToString('N'))
$Stage = Join-Path $VersionsDir (".$Version.stage." + $PID)
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
    Write-Host "Package SHA-256: $ArchiveSha256"

    Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $Stage | Out-Null
    & npm install --prefix $Stage --no-audit --no-fund --include=optional $Archive 'express@>=4'
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

    $CprCmd = Join-Path $Stage 'node_modules\.bin\cpr.cmd'
    if (-not (Test-Path -LiteralPath $CprCmd -PathType Leaf)) { throw 'installed cpr executable is missing' }
    $env:CPR_HOME = $CprHome
    $env:CPR_DATA_FILE = Join-Path $CprHome 'data\providers.json'
    $InstalledVersion = ((& $CprCmd --version) | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $InstalledVersion -ne $Version) { throw "installed version check failed ($InstalledVersion)" }
    & $CprCmd doctor | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'cpr doctor failed' }

    Remove-Item -LiteralPath $FinalDir -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $Stage -Destination $FinalDir

    $CurrentFile = Join-Path $InstallRoot 'current.txt'
    $CurrentTemp = "$CurrentFile.$PID.tmp"
    [IO.File]::WriteAllText($CurrentTemp, $FinalDir + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $CurrentTemp -Destination $CurrentFile -Force

    $Shim = Join-Path $BinDir 'cpr.cmd'
    $ShimTemp = "$Shim.$PID.tmp"
    $Lines = @(
        '@echo off',
        "if not defined CPR_HOME set `"CPR_HOME=$CprHome`"",
        'if not defined CPR_DATA_FILE set "CPR_DATA_FILE=%CPR_HOME%\data\providers.json"',
        "set /p CPR_CURRENT=<`"$CurrentFile`"",
        'node "%CPR_CURRENT%\node_modules\cli-provider-router\cli\index.js" %*'
    )
    [IO.File]::WriteAllLines($ShimTemp, $Lines, [Text.ASCIIEncoding]::new())
    Move-Item -LiteralPath $ShimTemp -Destination $Shim -Force

    & $Shim --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'installed command shim failed its version check' }
    & $Shim doctor | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'installed command shim failed cpr doctor' }

    Write-Host "Installed cli-provider-router $Version"
    Write-Host "  command: $Shim"
    Write-Host "  app:     $FinalDir"
    Write-Host "  data:    $CprHome"
    Write-Host "  sha256:  $ArchiveSha256"
} finally {
    Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
}
