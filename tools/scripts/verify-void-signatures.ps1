param(
  [string]$ProjectRoot = ".",
  [switch]$MsiOnly
)

$ErrorActionPreference = "Stop"
$releaseRoot = Join-Path $ProjectRoot "src-tauri\target\release"
$targets = @()

if (-not $MsiOnly) {
  $mainExe = Join-Path $releaseRoot "nonthub.exe"
  if (Test-Path -LiteralPath $mainExe) { $targets += Get-Item -LiteralPath $mainExe }
}

$msiRoot = Join-Path $releaseRoot "bundle\msi"
if (Test-Path -LiteralPath $msiRoot) {
  $targets += Get-ChildItem -LiteralPath $msiRoot -Filter *.msi -File -ErrorAction SilentlyContinue
}

$targets = @($targets | Sort-Object FullName -Unique)
if ($targets.Count -eq 0) {
  throw "No NontHub MSI build output was found to verify."
}

$bad = @()
foreach ($file in $targets) {
  $signature = Get-AuthenticodeSignature -FilePath $file.FullName
  $subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { "" }
  $isVoid = $subject -match '(?i)(^|,)\s*CN=Void(,|$)' -or $subject -match '(?i)Void'
  $allowed = if ($env:VOID_SIGN_SELF_SIGNED -eq 'true') { @('Valid','UnknownError','NotTrusted') } else { @('Valid') }
  $isAcceptable = $null -ne $signature.SignerCertificate -and $allowed -contains $signature.Status.ToString()

  if (-not $isAcceptable -or -not $isVoid) {
    $bad += $file.FullName
    Write-Host "[FAIL] $($file.Name) - $($signature.Status) - $subject" -ForegroundColor Red
  } else {
    $color = if ($signature.Status -eq 'Valid') { 'Green' } else { 'Yellow' }
    Write-Host "[OK]   $($file.Name) - signed by $subject - status: $($signature.Status)" -ForegroundColor $color
  }
}

if ($bad.Count -gt 0) {
  throw "One or more NontHub outputs were not Authenticode-signed by Void."
}

Write-Host "[OK] Void Authenticode verification passed." -ForegroundColor Green
