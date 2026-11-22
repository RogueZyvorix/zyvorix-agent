#!/usr/bin/env bash
# zyvorix-agent installer untuk Ubuntu/Linux VPS
set -e

echo "==============================================="
echo "   zyvorix-agent installer (Linux / Ubuntu)"
echo "==============================================="

cd "$(dirname "$0")"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

# 1) Cek / install Node.js 20 LTS
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  MAJOR=$(node -p "process.versions.node.split('.')[0]")
  if [ "$MAJOR" -ge 18 ]; then NEED_NODE=0; fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
  echo "[*] Node.js 18+ belum ada. Menginstall Node.js 20 LTS..."
  if ! command -v curl >/dev/null 2>&1; then
    $SUDO apt-get update -y
    $SUDO apt-get install -y curl ca-certificates
  fi
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash -
  $SUDO apt-get install -y nodejs
fi
echo "[OK] Node.js $(node -v) terdeteksi"

# 2) npm install
echo "[*] Menjalankan npm install..."
npm install --no-audit --no-fund
echo "[OK] Dependencies terpasang"

# 3) Wizard konfigurasi
mkdir -p data
WRITE_CONFIG=1
if [ -f data/config.json ]; then
  read -r -p "data/config.json sudah ada. Timpa? (y/N): " OW
  if [[ ! "$OW" =~ ^[Yy]$ ]]; then WRITE_CONFIG=0; fi
fi

if [ "$WRITE_CONFIG" -eq 1 ]; then
  echo ""
  echo "=== Konfigurasi zyvorix-agent ==="
  read -r -p "Discord Bot Token: " ZV_TOKEN
  read -r -p "Discord User ID (pisah koma jika lebih dari satu): " ZV_USERS
  read -r -p "9Router URL [http://localhost:20128/v1]: " ZV_URL
  ZV_URL=${ZV_URL:-http://localhost:20128/v1}
  read -r -p "9Router API Key (kosongkan jika tidak ada): " ZV_KEY
  read -r -p "Model Name [zyvorix-combo]: " ZV_MODEL
  ZV_MODEL=${ZV_MODEL:-zyvorix-combo}
  read -r -s -p "Password Dashboard: " ZV_PASS
  echo ""
  ZV_PASS=${ZV_PASS:-admin}

  export ZV_TOKEN ZV_USERS ZV_URL ZV_KEY ZV_MODEL ZV_PASS
  node <<'EOF'
const fs = require('fs');
const e = process.env;
const cfg = {
  discordToken: (e.ZV_TOKEN || '').trim(),
  allowedUserIds: (e.ZV_USERS || '').split(',').map(s => s.trim()).filter(Boolean),
  baseUrl: e.ZV_URL,
  apiKey: e.ZV_KEY || '',
  model: e.ZV_MODEL,
  systemPrompt: '',
  toolsEnabled: true,
  dashboardPassword: e.ZV_PASS,
};
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/config.json', JSON.stringify(cfg, null, 2));
console.log('[OK] data/config.json dibuat');
EOF
  chmod 600 data/config.json
fi

# 4) Opsi menjalankan di background dengan pm2
echo ""
read -r -p "Jalankan agent di background sekarang dengan pm2? (Y/n): " RUN
if [[ ! "$RUN" =~ ^[Nn]$ ]]; then
  if ! command -v pm2 >/dev/null 2>&1; then
    echo "[*] Menginstall pm2..."
    $SUDO npm install -g pm2
  fi
  pm2 delete zyvorix-agent >/dev/null 2>&1 || true
  pm2 start npm --name zyvorix-agent -- start
  pm2 save
  echo "[OK] zyvorix-agent berjalan di background (pm2)"
  echo "Agar otomatis jalan saat VPS reboot, jalankan 'pm2 startup' lalu salin dan eksekusi perintah sudo yang ditampilkan."
  echo "Perintah berguna: pm2 logs zyvorix-agent | pm2 restart zyvorix-agent | pm2 stop zyvorix-agent"
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "==============================================="
echo " Selesai! Dashboard: http://${IP:-IP-SERVER}:3000"
echo "==============================================="
