param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
$signer = Join-Path $root "tools\scripts\sign-void-file.ps1"
$configPath = Join-Path $root "src-tauri\tauri.windows.conf.json"

if (-not (Test-Path -LiteralPath $signer)) {
  throw "Windows signing script was not found: $signer"
}

$config = [ordered]@{
  bundle = [ordered]@{
    targets = @("msi")
    windows = [ordered]@{
      signCommand = [ordered]@{
        cmd = "powershell.exe"
        args = @(
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          $signer,
          "-Path",
          "%1"
        )
      }
    }
  }
}

$json = $config | ConvertTo-Json -Depth 8
$utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
[System.IO.File]::WriteAllText($configPath, $json, $utf8NoBom)
Write-Host "[OK] Tauri is configured for MSI-only Void signing." -ForegroundColor Green
