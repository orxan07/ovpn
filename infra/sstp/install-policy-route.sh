#!/usr/bin/env bash
# Install without restarting sing-box, accel-ppp or the nftables integration.
set -euo pipefail
[ "$EUID" -eq 0 ] || { echo "Run as root."; exit 1; }
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
systemctl is-active --quiet sstp-singbox-route.service
install -o root -g root -m 755 "$REPO_DIR/ensure-policy-route.py" /usr/local/sbin/ensure-sstp-policy-route
for unit in sstp-policy-route.service sstp-policy-route.timer; do
  install -o root -g root -m 644 "$REPO_DIR/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl start sstp-policy-route.service
systemctl enable --now sstp-policy-route.timer
