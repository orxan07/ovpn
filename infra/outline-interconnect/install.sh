#!/bin/bash
set -euo pipefail
case "${1:-}" in
    gateway) outer=10.10.0.4; remote=156.67.63.163; local_ip=10.253.201.1; peer=10.253.201.2; allow='ct state established,related accept' ;;
    exit) outer=156.67.63.163; remote=171.22.75.104; local_ip=10.253.201.2; peer=10.253.201.1; allow='meta l4proto { tcp, udp } th dport 25235 accept' ;;
    *) echo 'Usage: install.sh gateway|exit' >&2; exit 2 ;;
esac
cd "$(dirname "$0")"
umask 022
ip -4 addr show | grep -Fq "inet ${outer}/" || { echo 'Unexpected host address' >&2; exit 1; }
install -m 0755 ensure.sh /usr/local/sbin/outline-interconnect-ensure
printf 'OUTER_LOCAL=%s\nOUTER_REMOTE=%s\nINNER_LOCAL=%s\n' "$outer" "$remote" "$local_ip" >/etc/outline-interconnect.env
cat >/etc/outline-interconnect.nft <<NFT
table inet olpath_guard {
 chain input {
  type filter hook input priority -50; policy accept;
  iifname "olpath0" ip saddr $peer ip daddr $local_ip icmp type { echo-request, echo-reply } accept
  iifname "olpath0" ip saddr $peer ip daddr $local_ip $allow
  iifname "olpath0" drop
 }
 chain forward {
  type filter hook forward priority -50; policy accept;
  iifname "olpath0" drop
  oifname "olpath0" drop
 }
}
NFT
install -m 0644 outline-interconnect-ensure.service /etc/systemd/system/
install -m 0644 outline-interconnect-ensure.timer /etc/systemd/system/
if [[ $1 == gateway ]]; then
    install -m 0755 probe.py /usr/local/sbin/outline-interconnect-probe
    install -m 0644 outline-interconnect-probe.service /etc/systemd/system/
fi
systemctl daemon-reload
systemctl enable --now outline-interconnect-ensure.timer
systemctl start outline-interconnect-ensure.service
