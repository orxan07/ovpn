#!/usr/bin/env bash
#
# Бэкап всего, что нужно для восстановления VPN на другом VPS.
# Складывает один tar.gz файл, который можно увезти scp-ом.
#
# Запускать на VPS под root (или с sudo).
#
# Использование:
#   sudo bash backup.sh                     -> /root/vpn-backup-YYYYMMDD-HHMM.tar.gz
#   sudo bash backup.sh /custom/path.tar.gz -> по указанному пути
#
# После создания архива — забери его на локальную машину:
#   scp root@VPS:/root/vpn-backup-*.tar.gz ~/Downloads/

set -euo pipefail

[ "$EUID" -eq 0 ] || { echo "Run as root (sudo bash $0)"; exit 1; }

TS="$(date +%Y%m%d-%H%M)"
OUT="${1:-/root/vpn-backup-${TS}.tar.gz}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/etc" "$WORK/opt"

echo "[1/8] WireGuard (/etc/wireguard) ..."
[ -d /etc/wireguard ] && cp -a /etc/wireguard "$WORK/etc/" || echo "  (не найдено, пропуск)"

echo "[2/8] sing-box (/etc/sing-box) ..."
[ -d /etc/sing-box ] && cp -a /etc/sing-box "$WORK/etc/" || echo "  (не найдено, пропуск)"

echo "[3/8] accel-ppp / SSTP (/etc/accel-ppp*, /etc/accel-ppp.conf) ..."
[ -d /etc/accel-ppp ] && cp -a /etc/accel-ppp "$WORK/etc/" || true
[ -f /etc/accel-ppp.conf ] && cp -a /etc/accel-ppp.conf "$WORK/etc/" || true

echo "[4/8] nginx + Let's Encrypt (/etc/nginx, /etc/letsencrypt) ..."
[ -d /etc/nginx ] && cp -a /etc/nginx "$WORK/etc/" || true
[ -d /etc/letsencrypt ] && cp -a /etc/letsencrypt "$WORK/etc/" || true

echo "[5/8] Админка wg-admin (/opt/wg-admin/data, .env) ..."
if [ -d /opt/wg-admin ]; then
  mkdir -p "$WORK/opt/wg-admin/data" "$WORK/opt/wg-admin/server"
  [ -d /opt/wg-admin/data ] && cp -a /opt/wg-admin/data/. "$WORK/opt/wg-admin/data/" || true
  [ -f /opt/wg-admin/server/.env ] && cp -a /opt/wg-admin/server/.env "$WORK/opt/wg-admin/server/.env" || true
fi

echo "[6/8] Outline (/opt/outline) ..."
[ -d /opt/outline ] && cp -a /opt/outline "$WORK/opt/" || echo "  (не найдено, пропуск)"

echo "[7/8] systemd unit'ы (нестандартные) ..."
mkdir -p "$WORK/etc/systemd/system"
for u in accel-ppp.service sstp-singbox-route.service sing-box.service wg-admin.service outline.service; do
  if [ -f "/etc/systemd/system/$u" ]; then
    cp -a "/etc/systemd/system/$u" "$WORK/etc/systemd/system/"
  fi
done

# nftables.d тоже сохраним
[ -d /etc/nftables.d ] && cp -a /etc/nftables.d "$WORK/etc/" || true
[ -f /etc/nftables.conf ] && cp -a /etc/nftables.conf "$WORK/etc/" || true

# sudoers drop-in для wg-admin
[ -f /etc/sudoers.d/wg-admin ] && { mkdir -p "$WORK/etc/sudoers.d"; cp -a /etc/sudoers.d/wg-admin "$WORK/etc/sudoers.d/"; } || true

echo "[8/8] Метаданные системы (для справки) ..."
{
  echo "# vpn-backup metadata"
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host: $(hostname)"
  echo "kernel: $(uname -r)"
  echo "os: $(. /etc/os-release && echo "$PRETTY_NAME")"
  echo "external_ip: $(curl -s --max-time 3 https://ifconfig.me/ip || echo unknown)"
  echo
  echo "# installed VPN-related packages"
  dpkg -l 2>/dev/null | awk '/^ii/ {print $2,$3}' | grep -Ei 'wireguard|nginx|certbot|sing-box|nodejs|accel-ppp|nftables' || true
} > "$WORK/META.txt"

# Версия репо для воспроизводимости
if [ -d /opt/wg-admin/.git ]; then
  (cd /opt/wg-admin && git log -1 --pretty='%H %ci %s' > "$WORK/wg-admin.git-rev.txt") || true
fi

echo
echo "Packing -> $OUT"
tar --warning=no-file-changed -czf "$OUT" -C "$WORK" .
chmod 600 "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
echo
echo "==================================================="
echo "BACKUP OK"
echo "  file: $OUT"
echo "  size: $SIZE"
echo "==================================================="
echo
echo "Скачай локально:"
echo "  scp root@$(hostname -I | awk '{print $1}'):$OUT ~/Downloads/"
echo
echo "ВАЖНО: внутри лежат приватные ключи и пароли!"
echo "       Храни архив в безопасном месте, лучше зашифрованным."
