#!/usr/bin/env bash
#
# Откатывает интеграцию SSTP↔sing-box: снимает nft-правила и systemd-юнит.
# После этого SSTP-трафик снова идёт напрямую (MASQUERADE через WAN).

set -euo pipefail

[ "$EUID" -eq 0 ] || { echo "Run as root."; exit 1; }

systemctl disable --now sstp-singbox-route 2>/dev/null || true
nft delete table inet sstp-singbox 2>/dev/null || true
rm -f /etc/nftables.d/sstp-singbox.nft /etc/systemd/system/sstp-singbox-route.service
systemctl daemon-reload

echo "Disabled. SSTP traffic now goes directly via WAN."
