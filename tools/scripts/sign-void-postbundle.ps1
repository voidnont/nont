param([string]$ProjectRoot = ".")
$ErrorActionPreference = "Stop"

$releaseRoot = Join-Path $ProjectRoot "src-tauri\target\release"
if (-not (Test-Path -LiteralPath $releaseRoot)) {
  throw "Tauri release output was not found: $releaseRoot"
}

$targets = @()
$mainExe = Join-Path $releaseRoot "nonthub.exe"
if (Test-Path -LiteralPath $mainExe) {
  $targets += (Resolve-Path -LiteralPath $mainExe).Path
}

$msiRoot = Join-Path $releaseRoot "bundle\msi"
if (Test-Path -LiteralPath $msiRoot) {
  $targets += Get-ChildItem -LiteralPath $msiRoot -Filter *.msi -File -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty FullName
}

$targets = @($targets | Sort-Object -Unique)
if ($targets.Count -eq 0) {
  throw "No NontHub Windows EXE/MSI outputs were found to sign."
}

$signer = Join-Path $ProjectRoot "tools\scripts\sign-void-file.ps1"
if (-not (Test-Path -LiteralPath $signer)) {
  throw "Void signing helper was not found: $signer"
}

& $signer -Path $targets
