@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0\..\.."

title NontHub Builder - MSI Only - Void Signed
color 0F

echo.
echo ==========================================================
echo          NONTHUB - VOID SIGNED MSI BUILD
echo ==========================================================
echo.

where node >nul 2>nul || (echo [ERROR] Node.js was not found.& goto :fail)
where npm >nul 2>nul || (echo [ERROR] npm was not found.& goto :fail)
where cargo >nul 2>nul || (echo [ERROR] Rust/Cargo was not found.& goto :fail)
where powershell.exe >nul 2>nul || (echo [ERROR] Windows PowerShell was not found.& goto :fail)

for %%S in ("resolve-void-signing.ps1" "configure-windows-signing.ps1" "sign-void-file.ps1" "sign-void-postbundle.ps1" "verify-void-signatures.ps1") do (
  if not exist "tools\scripts\%%~S" (
    echo [ERROR] Missing signing helper: tools\scripts\%%~S
    goto :fail
  )
)

echo [OK] Release publisher identity: Void

echo.
set "NONTHUB_VERSION="
if exist ".nonthub-version.tmp" del /q ".nonthub-version.tmp" >nul 2>nul
node "tools\scripts\check-version.cjs" > ".nonthub-version.tmp"
if errorlevel 1 (
  type ".nonthub-version.tmp" 2>nul
  if exist ".nonthub-version.tmp" del /q ".nonthub-version.tmp" >nul 2>nul
  echo [ERROR] NontHub version consistency check failed.
  goto :fail
)
set /p "NONTHUB_VERSION="<".nonthub-version.tmp"
del /q ".nonthub-version.tmp" >nul 2>nul
if not defined NONTHUB_VERSION (
  echo [ERROR] NontHub version checker returned no version.
  goto :fail
)
echo [OK] Version consistency verified: v!NONTHUB_VERSION!

echo.
echo [1/7] Checking JavaScript dependencies...
if exist "node_modules\@tauri-apps\cli\tauri.js" if exist "node_modules\react\package.json" if exist "node_modules\vite\package.json" goto :deps_ready
if exist package-lock.json (
  call npm ci --include=dev
) else (
  call npm install --include=dev --no-audit --no-fund
)
if errorlevel 1 goto :fail
:deps_ready
if not exist "node_modules\@tauri-apps\cli\tauri.js" (
  echo [ERROR] Local Tauri CLI is missing after dependency setup.
  goto :fail
)

if not exist "public\brand\nonthub.png" (
  echo [ERROR] NontHub master icon is missing: public\brand\nonthub.png
  goto :fail
)

echo.
echo [2/7] Regenerating the complete Windows icon set...
node "node_modules\@tauri-apps\cli\tauri.js" icon "public\brand\nonthub.png"
if errorlevel 1 goto :fail

for %%I in ("32x32.png" "128x128.png" "128x128@2x.png" "icon.png" "icon.ico") do (
  if not exist "src-tauri\icons\%%~I" (
    echo [ERROR] Generated Windows app icon is missing: src-tauri\icons\%%~I
    goto :fail
  )
)

powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing; $checks=@(@('32x32.png',32),@('128x128.png',128),@('128x128@2x.png',256)); foreach($c in $checks){$p=Join-Path 'src-tauri\icons' $c[0]; $img=[System.Drawing.Image]::FromFile($p); try { if($img.Width -ne [int]$c[1] -or $img.Height -ne [int]$c[1]){ throw ($c[0] + ' must be ' + $c[1] + 'x' + $c[1] + ', got ' + $img.Width + 'x' + $img.Height) } } finally { $img.Dispose() }}; $ico=Get-Item 'src-tauri\icons\icon.ico'; if($ico.Length -lt 1024){ throw 'icon.ico is unexpectedly small or invalid' }; $h1=(Get-FileHash 'src-tauri\icons\128x128.png').Hash; $h2=(Get-FileHash 'src-tauri\icons\128x128@2x.png').Hash; if($h1 -eq $h2){ throw '128x128@2x.png incorrectly duplicates 128x128.png' }; Write-Host '[OK] NontHub Windows icon dimensions and ICO output verified.'"
if errorlevel 1 goto :fail

echo [OK] NontHub Windows icon set regenerated from the master brand icon.

echo.
echo [3/7] Resolving Void code-signing certificate...
if exist ".void-signing.env" del /q ".void-signing.env" >nul 2>nul
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "tools\scripts\resolve-void-signing.ps1" -EnvPath ".void-signing.env"
if errorlevel 1 goto :fail
if not exist ".void-signing.env" (
  echo [ERROR] Signing identity resolution did not create its status file.
  goto :fail
)
for /f "usebackq tokens=1,* delims==" %%A in (".void-signing.env") do set "%%A=%%B"
if not defined VOID_SIGN_THUMBPRINT_RESOLVED (
  echo [ERROR] No Void signing thumbprint was resolved.
  goto :fail
)
echo [OK] Void signing certificate is ready.
if /I "!VOID_SIGN_MODE!"=="generated-self-signed" echo [OK] Created a reusable self-signed CN=Void certificate in CurrentUser\My.

echo.
echo [4/7] Configuring MSI-only Tauri signing...
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "tools\scripts\configure-windows-signing.ps1" -ProjectRoot "%CD%"
if errorlevel 1 goto :fail

if exist "src-tauri\target\release\bundle\nsis" rmdir /s /q "src-tauri\target\release\bundle\nsis"
if exist "src-tauri\target\release\bundle\msi" rmdir /s /q "src-tauri\target\release\bundle\msi"
if exist "release-upload" rmdir /s /q "release-upload"

echo.
echo [5/7] Building NontHub MSI...
node "node_modules\@tauri-apps\cli\tauri.js" build --bundles msi
if errorlevel 1 goto :fail

echo.
echo [6/7] Signing the Windows app and MSI as Void...
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "tools\scripts\sign-void-postbundle.ps1" -ProjectRoot "%CD%"
if errorlevel 1 goto :fail

echo.
echo [7/7] Verifying Void Authenticode signatures...
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "tools\scripts\verify-void-signatures.ps1" -ProjectRoot "%CD%"
if errorlevel 1 goto :fail

mkdir "release-upload" >nul 2>nul
set /a MSI_COUNT=0
for %%F in ("src-tauri\target\release\bundle\msi\*.msi") do (
  if exist "%%~fF" (
    set /a MSI_COUNT+=1
    copy /Y "%%~fF" "release-upload\%%~nxF" >nul
  )
)
if not "!MSI_COUNT!"=="1" (
  echo [ERROR] Expected exactly one MSI output, found !MSI_COUNT!.
  goto :fail
)

set /a RELEASE_COUNT=0
for %%F in ("release-upload\*") do if exist "%%~fF" set /a RELEASE_COUNT+=1
if not "!RELEASE_COUNT!"=="1" (
  echo [ERROR] release-upload must contain exactly one file, found !RELEASE_COUNT!.
  goto :fail
)

for %%F in ("release-upload\*.msi") do if exist "%%~fF" (
  powershell.exe -NoProfile -NonInteractive -Command "$s=Get-AuthenticodeSignature -LiteralPath '%%~fF'; if(-not $s.SignerCertificate -or $s.SignerCertificate.Subject -notmatch '(?i)Void'){ throw 'release-upload MSI is not signed by Void' }; Write-Host ('[OK] Release MSI signer: ' + $s.SignerCertificate.Subject)"
  if errorlevel 1 goto :fail
)

echo.
echo ==========================================================
echo BUILD COMPLETE - MSI ONLY - SIGNED AS VOID
echo ==========================================================
echo Version: !NONTHUB_VERSION!
echo Output:
for %%F in ("release-upload\*.msi") do if exist "%%~fF" echo   %%~fF
if /I "!VOID_SIGN_SELF_SIGNED!"=="true" (
  echo.
  echo [NOTICE] The MSI is Authenticode-signed by the local self-signed CN=Void certificate.
  echo          Other PCs will see the signature but will not trust the publisher automatically.
  echo          A public CA-issued certificate is required for universal Verified Publisher trust.
)
echo ==========================================================
if exist ".void-signing.env" del /q ".void-signing.env" >nul 2>nul
if /I not "%NONTHUB_CI%"=="1" pause
exit /b 0

:fail
echo.
echo ==========================================================
echo BUILD FAILED - no unsigned public MSI was accepted.
echo NontHub release builds must produce exactly one Void-signed MSI.
echo ==========================================================
if exist ".void-signing.env" del /q ".void-signing.env" >nul 2>nul
if /I not "%NONTHUB_CI%"=="1" pause
exit /b 1
