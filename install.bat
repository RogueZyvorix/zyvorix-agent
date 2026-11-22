@echo off
setlocal
title zyvorix-agent installer
cd /d "%~dp0"

echo ===============================================
echo    zyvorix-agent installer (Windows)
echo ===============================================

REM 1) Cek Node.js 18+
node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto nodeold
echo [OK] Node.js terdeteksi

REM 2) npm install
echo [*] Menjalankan npm install...
call npm install --no-audit --no-fund
if errorlevel 1 goto installfail
echo [OK] Dependencies terpasang

REM 3) Wizard konfigurasi
if exist data\config.json (
  set "OW="
  set /p "OW=data\config.json sudah ada. Timpa? (y/N): "
  if /i not "%OW%"=="y" goto skipconfig
)

echo.
echo === Konfigurasi zyvorix-agent ===
set "ZV_TOKEN="
set "ZV_USERS="
set "ZV_URL="
set "ZV_KEY="
set "ZV_MODEL="
set "ZV_PASS="
set /p "ZV_TOKEN=Discord Bot Token: "
set /p "ZV_USERS=Discord User ID (pisah koma jika lebih dari satu): "
set /p "ZV_URL=9Router URL [Enter = http://localhost:20128/v1]: "
if "%ZV_URL%"=="" set "ZV_URL=http://localhost:20128/v1"
set /p "ZV_KEY=9Router API Key (kosongkan jika tidak ada): "
set /p "ZV_MODEL=Model Name [Enter = zyvorix-combo]: "
if "%ZV_MODEL%"=="" set "ZV_MODEL=zyvorix-combo"
set /p "ZV_PASS=Password Dashboard [Enter = admin]: "
if "%ZV_PASS%"=="" set "ZV_PASS=admin"

if not exist data mkdir data
node -e "const fs=require('fs');const e=process.env;const c={discordToken:(e.ZV_TOKEN||'').trim(),allowedUserIds:(e.ZV_USERS||'').split(',').map(s=>s.trim()).filter(Boolean),baseUrl:e.ZV_URL,apiKey:e.ZV_KEY||'',model:e.ZV_MODEL,systemPrompt:'',toolsEnabled:true,dashboardPassword:e.ZV_PASS};fs.mkdirSync('data',{recursive:true});fs.writeFileSync('data/config.json',JSON.stringify(c,null,2));console.log('[OK] data/config.json dibuat');"
if errorlevel 1 goto configfail

:skipconfig
echo.
echo ===============================================
echo  Setup selesai. Dashboard: http://localhost:3000
echo ===============================================
set "RUN="
set /p "RUN=Jalankan agent sekarang di jendela baru? (Y/N): "
if /i "%RUN%"=="y" start "zyvorix-agent" cmd /k "npm start"
pause
exit /b 0

:nodeold
echo [!] Node.js 18+ tidak ditemukan.
echo     Install Node.js LTS dari https://nodejs.org lalu jalankan ulang file ini.
pause
exit /b 1

:installfail
echo [!] npm install gagal. Periksa koneksi internet lalu coba lagi.
pause
exit /b 1

:configfail
echo [!] Gagal membuat data/config.json.
pause
exit /b 1
