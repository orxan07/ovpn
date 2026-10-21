#!/usr/bin/env bash
#
# Откатывает интеграцию SSTP↔sing-box: снимает nft-правила и systemd-юнит.
# После этого SSTP-трафик снова идёт напрямую (MASQUERADE через WAN).

set -euo pipefail

[ "$EUID" -eq 0 ] || { echo "Run as root."; exit 1; }

systemctl disable --now sstp-policy-route.timer 2>/dev/null || true
systemctl stop sstp-policy-route.service 2>/dev/null || true
ip -4 rule del pref 8999 from 10.27.0.0/24 fwmark 0x2023 lookup 2022 2>/dev/null || true
systemctl disable --now sstp-singbox-route 2>/dev/null || true
nft delete table inet sstp-singbox 2>/dev/null || true
rm -f /etc/nftables.d/sstp-singbox.nft /etc/systemd/system/sstp-singbox-route.service
rm -f /usr/local/sbin/ensure-sstp-policy-route /etc/systemd/system/sstp-policy-route.service /etc/systemd/system/sstp-policy-route.timer
systemctl daemon-reload

echo "Disabled. SSTP traffic now goes directly via WAN."
