#!/bin/bash
set -euo pipefail

APP_DIR="/opt/wg-admin"
WG_CONF="/etc/wireguard/wg0.conf"
ENV_FILE="$APP_DIR/server/.env"
SSTP_CERT_DIR="/etc/accel-ppp/sstp"

SERVICE_USER="$(awk -F= '/^User=/{print $2; exit}' /etc/systemd/system/wg-admin.service 2>/dev/null || true)"
SERVICE_USER="${SERVICE_USER:-root}"

if [ "$SERVICE_USER" != "root" ] && ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$SERVICE_USER"
fi

if [ -d "$APP_DIR" ] && [ "$SERVICE_USER" != "root" ]; then
  chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
fi

if [ -f "$APP_DIR/scripts/install-sudoers.sh" ]; then
  bash "$APP_DIR/scripts/install-sudoers.sh" "$SERVICE_USER"
fi

if [ -f "$WG_CONF" ]; then
  WAN_IF="$(ip route get 1.1.1.1 | awk '/dev/ {for(i=1;i<=NF;i++) if($i=="dev") print $(i+1); exit}')"
  if [ -n "$WAN_IF" ]; then
    python3 - "$WG_CONF" "$WAN_IF" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
wan_if = sys.argv[2]
text = path.read_text()

def fix_masquerade(line: str) -> str:
    if "POSTROUTING" in line and "MASQUERADE" in line:
        return re.sub(r"-o\s+\S+", f"-o {wan_if}", line)
    return line

path.write_text("\n".join(fix_masquerade(line) for line in text.splitlines()) + "\n")
PY
  fi
fi

repair_sstp_cert() {
  [ -d "$SSTP_CERT_DIR" ] || return 0

  local host=""
  if [ -f "$ENV_FILE" ]; then
    host="$(awk -F= '/^SSTP_HOST=/{print $2; exit}' "$ENV_FILE")"
    if [ -z "$host" ]; then
      host="$(awk -F= '/^SERVER_ENDPOINT=/{print $2; exit}' "$ENV_FILE")"
    fi
  fi

  if [ -z "$host" ]; then
    host="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  fi

  host="${host#*://}"
  host="${host%%/*}"
  host="${host#[}"
  host="${host%]}"
  host="${host%:*}"
  [ -n "$host" ] || return 0

  local san_type="DNS"
  if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    san_type="IP"
  fi

  cd "$SSTP_CERT_DIR"
  if [ -f server.crt ] && [ -f server.key ] && openssl x509 -in server.crt -noout -ext subjectAltName 2>/dev/null | grep -Eq "${san_type}( Address)?:${host}([,[:space:]]|$)"; then
    return 0
  fi

  local backup_dir="backup-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$backup_dir"
  [ -f server.crt ] && cp -a server.crt "$backup_dir/"
  [ -f server.key ] && cp -a server.key "$backup_dir/"
  [ -f server.pem ] && cp -a server.pem "$backup_dir/"

  openssl req -new -newkey rsa:2048 -days 3650 -nodes -x509 \
    -subj "/C=RU/ST=Moscow/L=Moscow/O=ovpn/CN=$host" \
    -addext "subjectAltName=${san_type}:$host" \
    -keyout server.key -out server.crt 2>/dev/null
  chmod 600 server.key
  cat server.crt server.key > server.pem
  chmod 600 server.pem
  echo "Regenerated SSTP TLS cert for ${san_type}:${host}; old cert backed up to $SSTP_CERT_DIR/$backup_dir."
}

repair_sstp_cert

mkdir -p /etc/wireguard/clients
chmod 750 /etc/wireguard /etc/wireguard/clients 2>/dev/null || true
if [ "$SERVICE_USER" != "root" ]; then
  chown root:"$SERVICE_USER" /etc/wireguard /etc/wireguard/clients 2>/dev/null || true
  find /etc/wireguard/clients \( -name "*.conf" -o -name "*.pub" \) -exec chown root:"$SERVICE_USER" {} \; 2>/dev/null || true
fi
find /etc/wireguard/clients \( -name "*.conf" -o -name "*.pub" \) -exec chmod 640 {} \; 2>/dev/null || true

systemctl daemon-reload

if systemctl list-unit-files | grep -q '^wg-quick@\.service'; then
  if ! systemctl restart wg-quick@wg0 2>/dev/null; then
    echo "wg-quick@wg0 failed, installing wg0 wrapper fallback..."
    bash "$APP_DIR/scripts/install-wg0-wrapper.sh"
    systemctl restart wg-quick@wg0
  fi
fi

if [ -f /etc/systemd/system/sstp-singbox-route.service ] && [ -f /etc/nftables.d/sstp-singbox.nft ]; then
  if ip -br link show sbtun >/dev/null 2>&1; then
    systemctl enable --now sstp-singbox-route
  else
    echo "sstp-singbox-route is installed, but sbtun is not ready; skipping enable."
  fi
fi
