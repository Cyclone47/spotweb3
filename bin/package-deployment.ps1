param([string]$OutputPath = '')
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputPath) { $OutputPath = Join-Path $sourceRoot 'dist/spotweb-install.tar.gz' }
$archivePath = [System.IO.Path]::GetFullPath($OutputPath)
$archiveParent = Split-Path -Parent $archivePath
New-Item -ItemType Directory -Path $archiveParent -Force | Out-Null
# Select top-level entries explicitly: tar implementations differ on whether an
# excluded "vendor" also matches the browser's required js/.../vendor assets.
$excludedNames = @('.git', 'vendor', 'dist', 'data', 'cache', 'node_modules', '.idea', '.rnd',
    'dbsettings.inc.php', 'ownsettings.php', 'reallymyownsettings.php')
$sourceEntries = @(Get-ChildItem -LiteralPath $sourceRoot -Force | Where-Object {
    $_.Name -notin $excludedNames -and $_.Name -notlike '.env*' -and
    $_.Name -notlike '*.sqlite*' -and $_.Name -notlike '*.bak'
} | ForEach-Object { './' + $_.Name })
& tar -czf $archivePath -C $sourceRoot -- @sourceEntries
if ($LASTEXITCODE -ne 0) { throw 'Deployment bundle creation failed.' }
$manifest = @(& tar -tzf $archivePath)
if ($LASTEXITCODE -ne 0) { throw 'Cannot read the deployment bundle.' }
foreach ($required in @('./proxmox/install-lxc.sh', './bin/retrieve-scheduler.php', './js/browser-download/vendor/7zz.wasm')) {
    if ($required -notin $manifest) { throw "Deployment bundle is missing $required" }
}
Get-Item -LiteralPath $archivePath | Select-Object FullName, Length
