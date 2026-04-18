#!/usr/bin/env bash
#
# Идемпотентные iptables-правила для SSTP-туннеля.
# Вызывается setup-sstp.sh, но можно запускать отдельно после ребута,
# если правила не сохраняются (например, нет iptables-persistent).
#
# Параметры через env:
#   SSTP_PORT    порт (default: 14942)
#   SSTP_NET     подсеть пула (default: 10.27.0.0/24)
#   SSTP_WAN_IF  WAN-интерфейс (default: автоопределение)

set -euo pipefail

SSTP_PORT="${SSTP_PORT:-14942}"
SSTP_NET="${SSTP_NET:-10.27.0.0/24}"
SSTP_WAN_IF="${SSTP_WAN_IF:-$(ip route show default | awk '/default/ {print $5; exit}')}"

ensure() {
  local cmd_check="$1"
  local cmd_add="$2"
  if eval "$cmd_check" >/dev/null 2>&1; then
    echo "  exists: $cmd_add"
  else
    eval "$cmd_add"
    echo "  added : $cmd_add"
  fi
}

echo "Applying SSTP firewall rules (port=$SSTP_PORT net=$SSTP_NET wan=$SSTP_WAN_IF)..."

sysctl -w net.ipv4.ip_forward=1 >/dev/null

ensure \
  "iptables -C INPUT -p tcp --dport $SSTP_PORT -j ACCEPT" \
  "iptables -I INPUT 1 -p tcp --dport $SSTP_PORT -j ACCEPT"

ensure \
  "iptables -C FORWARD -i sstp+ -j ACCEPT" \
  "iptables -I FORWARD 1 -i sstp+ -j ACCEPT"

ensure \
  "iptables -C FORWARD -o sstp+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT" \
  "iptables -I FORWARD 1 -o sstp+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT"

ensure \
  "iptables -t nat -C POSTROUTING -s $SSTP_NET -o $SSTP_WAN_IF -j MASQUERADE" \
  "iptables -t nat -A POSTROUTING -s $SSTP_NET -o $SSTP_WAN_IF -j MASQUERADE"

echo "Done."
