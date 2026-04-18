#!/usr/bin/env bash
#
# Включает интеграцию SSTP↔sing-box: ставит nft-правила, которые заворачивают
# трафик SSTP-клиентов через sing-box (так же, как трафик WireGuard).
#
# Идемпотентно. Откат — disable-singbox-integration.sh.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
NFT_FILE="$REPO_DIR/sstp-singbox.nft"
SERVICE_FILE="$REPO_DIR/sstp-singbox-route.service"

[ "$EUID" -eq 0 ] || { echo "Run as root."; exit 1; }
[ -f "$NFT_FILE" ] || { echo "Missing $NFT_FILE"; exit 1; }
[ -f "$SERVICE_FILE" ] || { echo "Missing $SERVICE_FILE"; exit 1; }

# Pre-flight: нужный sing-box интерфейс и таблица должны существовать
if ! ip link show sbtun >/dev/null 2>&1; then
  echo "ERROR: интерфейс sbtun не найден — sing-box не запущен или не использует tun."
  exit 1
fi
if ! ip route show table 2022 2>/dev/null | grep -q '^default via'; then
  echo "WARN: таблица маршрутизации 2022 без default-маршрута. sing-box auto_route, кажется, не активен."
  echo "      Включаем правила всё равно, но проверь работоспособность."
fi

echo "Installing nftables rules to /etc/nftables.d/sstp-singbox.nft ..."
install -d /etc/nftables.d
install -m 644 "$NFT_FILE" /etc/nftables.d/sstp-singbox.nft

echo "Installing systemd unit ..."
install -m 644 "$SERVICE_FILE" /etc/systemd/system/sstp-singbox-route.service
systemctl daemon-reload

echo "Enabling and starting sstp-singbox-route ..."
systemctl enable --now sstp-singbox-route

echo
echo "=== Active rules ==="
nft list table inet sstp-singbox
echo
echo "Done. SSTP traffic now goes through sing-box."
