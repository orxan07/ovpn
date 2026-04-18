#!/usr/bin/env bash
#
# Восстановление состояния из архива, созданного scripts/backup.sh.
# Запускается ПОСЛЕ bootstrap-vps.sh (когда уже есть базовая инсталляция).
#
# Использование:
#   sudo bash restore.sh /path/to/vpn-backup-YYYYMMDD-HHMM.tar.gz
#
# Что делает:
#   - распаковывает архив в /tmp
#   - копирует /etc/wireguard, /etc/sing-box, /etc/accel-ppp*, /etc/nginx,
#     /etc/letsencrypt, /etc/nftables.d, sudoers drop-in, systemd unit'ы
#   - копирует /opt/wg-admin/data + .env
#   - перезагружает systemd и поднимает все сервисы
#
# Архив содержит ПРИВАТНЫЕ КЛЮЧИ — обращайся бережно.

set -euo pipefail

[ "$EUID" -eq 0 ] || { echo "Run as root (sudo bash $0)"; exit 1; }
ARCHIVE="${1:-}"
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || { echo "Usage: sudo bash $0 /path/to/vpn-backup.tar.gz"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[1/8] Unpack $ARCHIVE -> $WORK"
tar -xzf "$ARCHIVE" -C "$WORK"

if [ -f "$WORK/META.txt" ]; then
  echo
  echo "===== Backup metadata ====="
  cat "$WORK/META.txt"
  echo "==========================="
  echo
  read -p "Продолжить восстановление? [y/N] " ANS
  [ "$ANS" = "y" ] || [ "$ANS" = "Y" ] || { echo "Отменено."; exit 0; }
fi

restore_dir() {
  local src="$1" dst="$2"
  if [ -d "$src" ]; then
    echo "  -> $dst"
    mkdir -p "$dst"
    cp -a "$src"/. "$dst"/
  fi
}

restore_file() {
  local src="$1" dst="$2"
  if [ -f "$src" ]; then
    echo "  -> $dst"
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
  fi
}

echo "[2/8] /etc/wireguard ..."
restore_dir "$WORK/etc/wireguard" /etc/wireguard
chmod 750 /etc/wireguard 2>/dev/null || true

echo "[3/8] /etc/sing-box ..."
restore_dir "$WORK/etc/sing-box" /etc/sing-box

echo "[4/8] /etc/accel-ppp* ..."
restore_dir "$WORK/etc/accel-ppp" /etc/accel-ppp
restore_file "$WORK/etc/accel-ppp.conf" /etc/accel-ppp.conf

echo "[5/8] nginx + Let's Encrypt ..."
restore_dir "$WORK/etc/nginx" /etc/nginx
restore_dir "$WORK/etc/letsencrypt" /etc/letsencrypt

echo "[6/8] /opt/wg-admin (data + .env) ..."
if [ -d "$WORK/opt/wg-admin/data" ]; then
  mkdir -p /opt/wg-admin/data
  cp -a "$WORK/opt/wg-admin/data"/. /opt/wg-admin/data/
fi
if [ -f "$WORK/opt/wg-admin/server/.env" ]; then
  cp -a "$WORK/opt/wg-admin/server/.env" /opt/wg-admin/server/.env
fi

echo "[7/8] systemd unit'ы / sudoers / nftables.d ..."
restore_dir "$WORK/etc/systemd/system" /etc/systemd/system
restore_dir "$WORK/etc/sudoers.d" /etc/sudoers.d
restore_dir "$WORK/etc/nftables.d" /etc/nftables.d
restore_file "$WORK/etc/nftables.conf" /etc/nftables.conf

# Outline по желанию
restore_dir "$WORK/opt/outline" /opt/outline

echo "[8/8] Reload systemd + start services ..."
systemctl daemon-reload

# Подымаем по очереди и не падаем если какого-то юнита нет
for svc in nginx wg-quick@wg0 wg-quick@wg1 sing-box accel-ppp wg-admin sstp-singbox-route outline; do
  if systemctl list-unit-files | grep -q "^${svc}\."; then
    echo "  enable+restart $svc"
    systemctl enable "$svc" 2>/dev/null || true
    systemctl restart "$svc" 2>/dev/null || echo "    (не стартовал — проверь journalctl -u $svc)"
  fi
done

echo
echo "================================================================"
echo "RESTORE OK"
echo
echo "Проверь:"
echo "  systemctl status wg-admin sing-box accel-ppp nginx"
echo "  curl -k https://localhost/api/system | jq ."
echo "  sudo wg show"
echo "  sudo accel-cmd show sessions"
echo
echo "Не забудь обновить DNS-запись домена на новый IP VPS!"
echo "================================================================"
