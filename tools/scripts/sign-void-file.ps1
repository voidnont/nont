param(
  [Parameter(Mandatory=$true)][string[]]$Path
)

$ErrorActionPreference = "Stop"
$thumb = ($env:VOID_SIGN_THUMBPRINT_RESOLVED -replace '\s','').ToUpperInvariant()
if (-not $thumb) { throw "VOID_SIGN_THUMBPRINT_RESOLVED is missing. Run resolve-void-signing.ps1 first." }
$certificate = Get-Item "Cert:\CurrentUser\My\$thumb" -ErrorAction SilentlyContinue
if (-not $certificate) { throw "Void signing certificate $thumb was not found in Cert:\CurrentUser\My." }
if ($certificate.Subject -notmatch '(?i)Void') { throw "Refusing to sign with a certificate that does not identify Void: $($certificate.Subject)" }

foreach ($item in $Path) {
  if (-not (Test-Path -LiteralPath $item)) { throw "Signing target was not found: $item" }
  $params = @{
    FilePath = $item
    Certificate = $certificate
    HashAlgorithm = 'SHA256'
  }
  if ($env:VOID_SIGN_SELF_SIGNED -ne 'true') {
    $params.TimestampServer = 'http://timestamp.digicert.com'
  }
  $result = Set-AuthenticodeSignature @params
  if (-not $result.SignerCertificate) { throw "PowerShell could not Authenticode-sign $item" }
  if ($result.SignerCertificate.Subject -notmatch '(?i)Void') { throw ("Unexpected signer for {0}: {1}" -f $item, $result.SignerCertificate.Subject) }
  $allowed = if ($env:VOID_SIGN_SELF_SIGNED -eq 'true') { @('Valid','UnknownError','NotTrusted') } else { @('Valid') }
  if ($allowed -notcontains $result.Status.ToString()) {
    throw ("Invalid Authenticode result for {0}: {1} - {2}" -f $item, $result.Status, $result.StatusMessage)
  }
  Write-Host "[SIGN] $([System.IO.Path]::GetFileName($item)) -> $($result.SignerCertificate.Subject) [$($result.Status)]" -ForegroundColor Green
}
