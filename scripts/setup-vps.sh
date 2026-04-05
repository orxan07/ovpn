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
sudo tee /etc/sudoers.d/wg-admin > /dev/null <<EOF
$SERVICE_USER ALL=(ALL) NOPASSWD: /usr/bin/wg, /usr/bin/wg-quick, /usr/bin/qrencode, /usr/bin/bash, /bin/bash, /bin/rm, /usr/bin/tee, /bin/cat
EOF
sudo chmod 440 /etc/sudoers.d/wg-admin

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
sudo apt-get install -y nginx certbot python3-certbot-nginx

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

echo ""
echo "=== Готово! ==="
echo "Панель: https://$DOMAIN"
echo ""
echo "Чтобы обновить после git push:"
echo "  cd $APP_DIR && bash scripts/deploy.sh"
