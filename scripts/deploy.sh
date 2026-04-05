#!/bin/bash
# Запускать на VPS после каждого git push
set -e

APP_DIR="/opt/wg-admin"

echo "=== Deploy ==="
cd "$APP_DIR"
git pull
cd server && npm install --production
sudo systemctl restart wg-admin
echo "Done. Status:"
sudo systemctl status wg-admin --no-pager
