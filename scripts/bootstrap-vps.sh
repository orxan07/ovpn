#!/usr/bin/env bash
#
# Bootstrap нового VPS «с нуля» под весь VPN-стек:
#   - системные пакеты (node, nginx, certbot, wireguard, sing-box, build-deps для accel-ppp, nftables)
#   - клонирование репо
#   - запуск setup-vps.sh (wg-admin + WG + nginx + LE)
#   - запуск setup-sstp.sh (SSTP-сервер)
#
# Не накатывает sing-box-конфиг и пользовательские данные — для этого есть
# scripts/restore.sh с архивом из backup.sh.
#
# Идемпотентно — можно перезапускать.
#
# Использование:
#   sudo bash bootstrap-vps.sh [--domain vpn.example.com] [--branch main]

set -euo pipefail

DOMAIN="vpn.rehimli.info"
BRANCH="main"
REPO="https://github.com/orxan07/ovpn.git"
APP_DIR="/opt/wg-admin"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --repo)   REPO="$2";   shift 2 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

[ "$EUID" -eq 0 ] || { echo "Run as root (sudo bash $0)"; exit 1; }

echo "=== bootstrap-vps: $DOMAIN ($BRANCH) ==="

echo "[1/6] System update + base packages ..."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  curl wget git ca-certificates gnupg lsb-release \
  build-essential cmake pkg-config \
  libssl-dev libpcre3-dev liblua5.1-0-dev \
  iptables nftables \
  wireguard wireguard-tools \
  qrencode jq \
  ufw \
  unzip

echo "[2/6] Node.js 20.x ..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v && npm -v

echo "[3/6] sing-box ..."
if ! command -v sing-box >/dev/null 2>&1; then
  # официальный install-скрипт
  bash -c "$(curl -fsSL https://sing-box.app/install.sh)"
fi
sing-box version || true

echo "[4/6] Sysctl: ip_forward + nf_conntrack ..."
cat > /etc/sysctl.d/99-vpn.conf <<EOF
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
net.netfilter.nf_conntrack_max = 262144
EOF
sysctl --system >/dev/null

echo "[5/6] Clone repo + run setup-vps.sh ..."
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
git fetch --all
git checkout "$BRANCH"
git pull

# setup-vps.sh подставляет $(whoami), но мы под root — это норм для systemd-юнита
sed -i "s|^DOMAIN=.*|DOMAIN=\"$DOMAIN\"|" "$APP_DIR/scripts/setup-vps.sh" || true
bash "$APP_DIR/scripts/setup-vps.sh"

echo "[6/6] SSTP server (accel-ppp) ..."
if ! systemctl is-active --quiet accel-ppp; then
  cd "$APP_DIR/infra/sstp"
  bash setup-sstp.sh
else
  echo "  accel-ppp уже активен, пропуск."
fi

echo
echo "================================================================"
echo "BOOTSTRAP OK"
echo "  Домен:     https://$DOMAIN"
echo "  Токен:     $(grep AUTH_TOKEN $APP_DIR/server/.env | cut -d= -f2-)"
echo "  SSTP:      tcp/14942 (см. вывод setup-sstp.sh выше)"
echo
echo "Дальше:"
echo "  1) Если есть бэкап со старого VPS — раскатай его:"
echo "       sudo bash $APP_DIR/scripts/restore.sh /path/to/vpn-backup.tar.gz"
echo "  2) Если нет — настрой sing-box руками или через UI на /vpn.rehimli.info"
echo "  3) В ДНС-провайдере направь $DOMAIN на этот VPS"
echo "================================================================"
