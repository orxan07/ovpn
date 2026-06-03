#!/bin/bash
set -e

SERVICE_USER="${1:-${SUDO_USER:-$(whoami)}}"

sudo tee /etc/sudoers.d/wg-admin > /dev/null <<EOF
$SERVICE_USER ALL=(ALL) NOPASSWD: /usr/bin/wg, /usr/bin/wg-quick, /usr/bin/qrencode, /usr/bin/bash, /bin/bash, /bin/rm, /usr/bin/rm, /usr/bin/tee, /bin/cat, /usr/bin/cat, /usr/bin/systemctl, /bin/systemctl, /usr/bin/cp, /bin/cp, /usr/bin/chmod, /bin/chmod, /usr/bin/chown, /bin/chown, /usr/bin/mv, /bin/mv, /usr/bin/install, /usr/sbin/iptables, /usr/bin/iptables, /usr/sbin/nft, /usr/bin/nft, /usr/sbin/ss, /usr/bin/ss, /usr/bin/test, /bin/test, /usr/bin/tail, /usr/bin/journalctl, /bin/journalctl, /usr/bin/awk, /usr/bin/openssl, /usr/bin/env, /usr/bin/kill, /bin/kill, /usr/sbin/accel-cmd, /usr/bin/tcpdump, /usr/sbin/tcpdump
EOF

sudo chmod 440 /etc/sudoers.d/wg-admin
sudo visudo -cf /etc/sudoers.d/wg-admin >/dev/null
