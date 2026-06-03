#!/bin/bash
set -e

sudo install -d -m 755 /usr/local/sbin /etc/systemd/system/wg-quick@wg0.service.d

sudo tee /usr/local/sbin/wg0-up > /dev/null <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

CONF=/etc/wireguard/wg0.conf
IFACE=wg0

if ip link show "$IFACE" >/dev/null 2>&1; then
  exit 0
fi

ADDR=$(awk -F= 'tolower($1) ~ /^[[:space:]]*address[[:space:]]*$/ {gsub(/[[:space:]]/, "", $2); print $2; exit}' "$CONF")
MTU=$(awk -F= 'tolower($1) ~ /^[[:space:]]*mtu[[:space:]]*$/ {gsub(/[[:space:]]/, "", $2); print $2; exit}' "$CONF")
MTU=${MTU:-1280}

ip link add dev "$IFACE" type wireguard
wg setconf "$IFACE" <(wg-quick strip "$CONF")
ip -4 address add "$ADDR" dev "$IFACE"
ip link set mtu "$MTU" up dev "$IFACE"

while read -r _ allowed; do
  for cidr in $allowed; do
    [[ "$cidr" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]] || continue
    if ! ip -4 route show dev "$IFACE" match "$cidr" | grep -q .; then
      ip -4 route add "$cidr" dev "$IFACE"
    fi
  done
done < <(wg show "$IFACE" allowed-ips)

DEFAULT_IFACE=$(ip route get 1.1.1.1 | awk '/dev/ {for(i=1;i<=NF;i++) if($i=="dev") print $(i+1); exit}')
iptables -I FORWARD 1 -o "$IFACE" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
iptables -I FORWARD 1 -i "$IFACE" -j ACCEPT
iptables -t nat -A POSTROUTING -s 10.20.0.0/24 -o "$DEFAULT_IFACE" -j MASQUERADE
SCRIPT

sudo tee /usr/local/sbin/wg0-down > /dev/null <<'SCRIPT'
#!/usr/bin/env bash
set +e

IFACE=wg0
DEFAULT_IFACE=$(ip route get 1.1.1.1 | awk '/dev/ {for(i=1;i<=NF;i++) if($i=="dev") print $(i+1); exit}')

iptables -D FORWARD -o "$IFACE" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null
iptables -D FORWARD -i "$IFACE" -j ACCEPT 2>/dev/null
iptables -t nat -D POSTROUTING -s 10.20.0.0/24 -o "$DEFAULT_IFACE" -j MASQUERADE 2>/dev/null
ip link delete "$IFACE" 2>/dev/null
exit 0
SCRIPT

sudo chmod 755 /usr/local/sbin/wg0-up /usr/local/sbin/wg0-down

sudo tee /etc/systemd/system/wg-quick@wg0.service.d/override.conf > /dev/null <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/local/sbin/wg0-up
ExecStop=
ExecStop=/usr/local/sbin/wg0-down
ExecReload=
ExecReload=/usr/local/sbin/wg0-down
ExecReload=/usr/local/sbin/wg0-up
EOF

sudo systemctl daemon-reload
