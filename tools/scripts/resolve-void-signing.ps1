param(
  [string]$EnvPath = ".void-signing.env"
)

$ErrorActionPreference = "Stop"

function Test-VoidCodeSigningCertificate {
  param([System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)
  if (-not $Certificate) { throw "No certificate was supplied." }
  if (-not $Certificate.HasPrivateKey) { throw "The selected certificate does not have a private key." }
  if ($Certificate.NotAfter -le (Get-Date)) { throw "The selected certificate has expired." }
  if ($Certificate.NotBefore -gt (Get-Date)) { throw "The selected certificate is not valid yet." }
  if ($Certificate.Subject -notmatch '(?i)Void') { throw "The signing certificate subject must identify Void. Found: $($Certificate.Subject)" }

  $codeSigningOid = "1.3.6.1.5.5.7.3.3"
  $ekuOids = @($Certificate.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } | ForEach-Object { $_.EnhancedKeyUsages | ForEach-Object { $_.Value } })
  if ($ekuOids.Count -gt 0 -and $ekuOids -notcontains $codeSigningOid) {
    throw "The selected certificate is not valid for Code Signing. Subject: $($Certificate.Subject)"
  }
}

function Find-VoidCertificate {
  Get-ChildItem Cert:\CurrentUser\My |
    Where-Object {
      $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) -and $_.NotBefore -le (Get-Date) -and $_.Subject -match '(?i)Void'
    } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
}

$certificate = $null
$source = ""

if ($env:VOID_SIGN_THUMBPRINT) {
  $thumb = ($env:VOID_SIGN_THUMBPRINT -replace '\s','').ToUpperInvariant()
  $certificate = Get-Item "Cert:\CurrentUser\My\$thumb" -ErrorAction SilentlyContinue
  if (-not $certificate) { throw "VOID_SIGN_THUMBPRINT was set, but that certificate was not found in Cert:\CurrentUser\My." }
  $source = "thumbprint"
}
elseif ($env:VOID_SIGN_PFX) {
  if (-not (Test-Path -LiteralPath $env:VOID_SIGN_PFX)) { throw "VOID_SIGN_PFX points to a file that does not exist: $($env:VOID_SIGN_PFX)" }
  $securePassword = New-Object System.Security.SecureString
  if ($null -ne $env:VOID_SIGN_PASSWORD -and $env:VOID_SIGN_PASSWORD.Length -gt 0) {
    $securePassword = ConvertTo-SecureString $env:VOID_SIGN_PASSWORD -AsPlainText -Force
  }
  $imported = @(Import-PfxCertificate -FilePath $env:VOID_SIGN_PFX -CertStoreLocation Cert:\CurrentUser\My -Password $securePassword -Exportable)
  $certificate = $imported | Where-Object { $_.HasPrivateKey -and $_.Subject -match '(?i)Void' } | Sort-Object NotAfter -Descending | Select-Object -First 1
  if (-not $certificate) { throw "The PFX was imported, but it did not contain a private-key certificate whose subject identifies Void." }
  $source = "pfx"
}
else {
  $certificate = Find-VoidCertificate
  if ($certificate) { $source = "store" }
}

if (-not $certificate) {
  Write-Host "[SIGN] No existing Void code-signing certificate was found." -ForegroundColor Yellow
  Write-Host "[SIGN] Creating a local self-signed Code Signing certificate: CN=Void" -ForegroundColor Yellow
  $certificate = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=Void" `
    -FriendlyName "Void - NontHub Local Code Signing" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(3)
  $source = "generated-self-signed"
}

Test-VoidCodeSigningCertificate -Certificate $certificate
$thumbprint = ($certificate.Thumbprint -replace '\s','').ToUpperInvariant()
$isSelfSigned = $certificate.Subject -eq $certificate.Issuer

@(
  "VOID_SIGN_MODE=$source"
  "VOID_SIGN_THUMBPRINT_RESOLVED=$thumbprint"
  "VOID_SIGN_SELF_SIGNED=$($isSelfSigned.ToString().ToLowerInvariant())"
) | Set-Content -LiteralPath $EnvPath -Encoding ASCII

Write-Host "[SIGN] Signer: $($certificate.Subject)" -ForegroundColor Green
Write-Host "[SIGN] Thumbprint: $thumbprint"
Write-Host "[SIGN] PowerShell Authenticode mode selected; Microsoft SignTool.exe is NOT required." -ForegroundColor Green
if ($isSelfSigned) {
  Write-Host "[SIGN] Local self-signed Void certificate: other PCs will not trust it as Verified Publisher." -ForegroundColor Yellow
} else {
  Write-Host "[SIGN] Trusted-chain candidate selected; signatures will be timestamped." -ForegroundColor Green
}
