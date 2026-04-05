#!/bin/bash
set -e

REPO="https://github.com/orxan07/ovpn.git"
APP_DIR="/opt/wg-admin"
SERVICE_USER="$(whoami)"
PORT=8080

echo "=== WireGuard Admin Panel: setup ==="

# 1. SSH ключ для деплоя (если нужен приватный репо — пока публичный, пропускаем)

# 2. Зависимости
echo "[1/5] Устанавливаем Node.js..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node: $(node -v), npm: $(npm -v)"

# 3. Клонируем репо
echo "[2/5] Клонируем репозиторий..."
if [ -d "$APP_DIR" ]; then
  echo "Директория уже существует, делаем git pull..."
  cd "$APP_DIR" && git pull
else
  sudo git clone "$REPO" "$APP_DIR"
  sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
fi

# 4. npm install
echo "[3/5] Устанавливаем зависимости..."
cd "$APP_DIR/server"
npm install --production

# 5. sudoers
echo "[4/5] Настраиваем sudoers..."
sudo tee /etc/sudoers.d/wg-admin > /dev/null <<EOF
$SERVICE_USER ALL=(ALL) NOPASSWD: /usr/bin/wg, /usr/bin/wg-quick, /usr/bin/qrencode, /usr/bin/bash, /bin/bash, /bin/rm, /usr/bin/tee, /bin/cat
EOF
sudo chmod 440 /etc/sudoers.d/wg-admin

# 6. .env файл с токеном
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

# 7. systemd сервис
echo "[5/5] Создаём systemd сервис..."
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
sudo systemctl status wg-admin --no-pager

echo ""
echo "=== Готово! ==="
echo "Панель доступна на http://171.22.75.104:$PORT"
echo "Но лучше открывать только внутри WireGuard туннеля: http://10.20.0.1:$PORT"
echo ""
echo "Чтобы обновить панель после git push:"
echo "  cd $APP_DIR && git pull && sudo systemctl restart wg-admin"
