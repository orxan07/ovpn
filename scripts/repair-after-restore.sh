#!/bin/bash
set -euo pipefail

APP_DIR="/opt/wg-admin"
WG_CONF="/etc/wireguard/wg0.conf"

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
