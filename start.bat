@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title itransfer

rem Usage: start.bat [nobrowser]

where uv >nul 2>&1
if errorlevel 1 (
  echo uv is not installed. Run:  winget install astral-sh.uv
  echo Then run start.bat again.
  pause
  exit /b 1
)

rem Find cloudflared (winget may not have put it on PATH yet).
set "CF=cloudflared"
where cloudflared >nul 2>&1 && goto have_cf
set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if exist "!CF!" goto have_cf
set "CF=%ProgramFiles%\cloudflared\cloudflared.exe"
if exist "!CF!" goto have_cf
echo cloudflared is not installed. Run:  winget install Cloudflare.cloudflared
echo Then open a NEW terminal and run start.bat again.
pause
exit /b 1
:have_cf

if not defined PORT set PORT=8000

rem Refuse to start if something (e.g. another itransfer window) already uses the port.
curl -s -o nul "http://localhost:%PORT%/" && (
  echo Something is already running on port %PORT%. Close the other itransfer window first.
  pause
  exit /b 1
)

del public_url.txt >nul 2>&1
rem A fresh log name each run, so a stale log can never supply an old tunnel address.
set "LOG=tunnel-%RANDOM%%RANDOM%.log"

echo Starting server...
start "itransfer server" /min cmd /c "uv run main.py"
set UP=
for /l %%i in (1,1,30) do if not defined UP (
  curl -s -o nul "http://localhost:%PORT%/" && set UP=1
  if not defined UP ping -n 2 127.0.0.1 >nul
)
if not defined UP (
  echo Server did not start. Run "uv run main.py" in this folder to see the error.
  goto cleanup
)

echo Starting tunnel...
start "itransfer tunnel" /min cmd /c ""!CF!" tunnel --url http://localhost:%PORT% >!LOG! 2>&1"
set URL=
for /l %%i in (1,1,40) do if not defined URL (
  for /f "usebackq delims=" %%u in (`powershell -nop -c "$m = Select-String -Path '!LOG!' -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue; if ($m) { $m[0].Matches[0].Value }"`) do set "URL=%%u"
  if not defined URL ping -n 2 127.0.0.1 >nul
)
if not defined URL (
  echo Could not get a public address. See !LOG! for details.
  goto cleanup
)

rem The server puts this address in the links it creates.
>public_url.txt echo(!URL!

rem The address is printed before Cloudflare finishes routing it; give it a moment.
ping -n 6 127.0.0.1 >nul

echo.
echo   itransfer is running.
echo.
echo   Upload here (only works on this computer, no password needed):
echo     http://localhost:%PORT%
echo.
echo   Links you create will look like:
echo     !URL!/d/...
echo   Friends can only download with a link; they cannot upload.
echo.
echo   The public address changes every time you restart. Keep this window open.
echo.
if /i not "%~1"=="nobrowser" start "" "http://localhost:%PORT%"
echo Press any key to stop the server and tunnel.
pause >nul

:cleanup
taskkill /fi "WINDOWTITLE eq itransfer tunnel*" /t /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq itransfer server*" /t /f >nul 2>&1
del public_url.txt >nul 2>&1
if defined LOG del "!LOG!" >nul 2>&1
echo Stopped.
