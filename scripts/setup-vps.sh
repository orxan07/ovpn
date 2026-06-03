#!/bin/bash
set -e

REPO="https://github.com/orxan07/ovpn.git"
APP_DIR="/opt/wg-admin"
SERVICE_USER="$(whoami)"
PORT=8080
DOMAIN="vpn.rehimli.info"

echo "=== WireGuard Admin Panel: setup ==="

# 1. Зависимости: Node.js
echo "[1/6] Устанавливаем Node.js..."
sudo apt-get update
sudo apt-get install -y wireguard wireguard-tools qrencode jq iptables nftables nginx certbot python3-certbot-nginx

if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node: $(node -v), npm: $(npm -v)"

# 2. Клонируем репо
echo "[2/6] Клонируем репозиторий..."
if [ -d "$APP_DIR" ]; then
  echo "Директория уже существует, делаем git pull..."
  cd "$APP_DIR" && git pull
else
  sudo git clone "$REPO" "$APP_DIR"
  sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
fi

# 3. npm install
echo "[3/6] Устанавливаем зависимости..."
cd "$APP_DIR/server"
npm install --production

# 4. sudoers
echo "[4/6] Настраиваем sudoers..."
bash "$APP_DIR/scripts/install-sudoers.sh" "$SERVICE_USER"

sudo mkdir -p /etc/wireguard/clients
sudo chmod 750 /etc/wireguard
sudo chown root:"$SERVICE_USER" /etc/wireguard
sudo chmod 750 /etc/wireguard/clients
sudo chown root:"$SERVICE_USER" /etc/wireguard/clients
sudo find /etc/wireguard/clients \( -name "*.conf" -o -name "*.pub" \) -exec sudo chmod 640 {} \;
sudo find /etc/wireguard/clients \( -name "*.conf" -o -name "*.pub" \) -exec sudo chown root:"$SERVICE_USER" {} \;

# 5. .env файл с токеном
if [ ! -f "$APP_DIR/server/.env" ]; then
  TOKEN=$(openssl rand -hex 16)
  echo "AUTH_TOKEN=$TOKEN" | sudo tee "$APP_DIR/server/.env" > /dev/null
  sudo chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/server/.env"
  echo ""
  echo ">>> AUTH TOKEN: $TOKEN <<<"
  echo ">>> Сохрани его — он нужен для входа в панель! <<<"
  echo ""
else
  echo "Файл .env уже существует, токен не меняем."
  echo "Текущий токен: $(grep AUTH_TOKEN $APP_DIR/server/.env | cut -d= -f2)"
fi

SERVER_IP="$(curl -4 -s --max-time 3 https://ifconfig.me/ip || hostname -I | awk '{print $1}')"
ensure_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$APP_DIR/server/.env"; then
    sudo sed -i "s|^${key}=.*|${key}=${value}|" "$APP_DIR/server/.env"
  else
    echo "${key}=${value}" | sudo tee -a "$APP_DIR/server/.env" > /dev/null
  fi
}
ensure_env SERVER_ENDPOINT "$DOMAIN:443"
ensure_env SINGBOX_WG_SERVER "$SERVER_IP"
ensure_env SINGBOX_ROUTE_EXCLUDE "$SERVER_IP/32"
sudo chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/server/.env"

# 6. systemd сервис
echo "[5/6] Создаём systemd сервис..."
sudo tee /etc/systemd/system/wg-admin.service > /dev/null <<EOF
[Unit]
Description=WireGuard Admin Panel
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR/server
EnvironmentFile=$APP_DIR/server/.env
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable wg-admin
sudo systemctl restart wg-admin

# 7. nginx + certbot
echo "[6/6] Настраиваем nginx + HTTPS..."

sudo tee /etc/nginx/sites-available/wg-admin > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/wg-admin /etc/nginx/sites-enabled/wg-admin
sudo nginx -t
sudo systemctl reload nginx

# Получаем сертификат
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m admin@rehimli.info --redirect

sudo systemctl reload nginx

# 8. Глобальные команды управления
echo "[+] Устанавливаем глобальные команды..."
bash "$APP_DIR/scripts/install-app-command.sh"

echo ""
echo "=== Готово! ==="
echo "Панель: https://$DOMAIN"
echo ""
echo "Команды управления:"
echo "  app start / stop / restart / status / logs / deploy / token"
