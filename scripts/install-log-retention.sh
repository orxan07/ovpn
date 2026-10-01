#!/usr/bin/env bash
# Bound journal, syslog and VPN logs without deleting application data.
# Run with: sudo bash scripts/install-log-retention.sh
set -euo pipefail
umask 077

if [[ "$EUID" -ne 0 ]]; then
  echo 'Run this installer as root: sudo bash scripts/install-log-retention.sh' >&2
  exit 1
fi

LOGROTATE=$(command -v logrotate || true)
if [[ -z "$LOGROTATE" ]]; then
  echo 'logrotate is required. Install it with apt-get install logrotate, then retry.' >&2
  exit 1
fi
for tool in systemctl systemd-analyze awk install mktemp; do
  if ! command -v "$tool" >/dev/null; then
    echo "Required command is unavailable: $tool" >&2
    exit 1
  fi
done
if [[ ! -f /etc/logrotate.d/rsyslog || ! -f /etc/logrotate.conf ]]; then
  echo 'Expected Ubuntu rsyslog and global logrotate configuration files are missing.' >&2
  exit 1
fi

BACKUP_DIR=/var/lib/wg-admin/log-retention
install -d -m 700 -o root -g root "$BACKUP_DIR"
if [[ ! -e "$BACKUP_DIR/rsyslog.original" ]]; then
  install -m 600 -o root -g root /etc/logrotate.d/rsyslog "$BACKUP_DIR/rsyslog.original"
fi

WORK_DIR=$(mktemp -d /tmp/wg-admin-retention.XXXXXXXX)
ACTIVATING=0
declare -a TARGETS=(
  /etc/systemd/journald.conf.d/wg-admin-retention.conf
  /etc/logrotate.d/rsyslog
  /etc/logrotate.d/wg-admin-vpn
  /etc/systemd/system/wg-admin-logrotate.service
  /etc/systemd/system/wg-admin-logrotate.timer
)

# If configuration preflight fails, restore the files from before this invocation.
cleanup() {
  local result=$? i
  trap - EXIT
  if [[ "$result" -ne 0 && "$ACTIVATING" -eq 0 ]]; then
    for i in "${!TARGETS[@]}"; do
      if [[ -e "$WORK_DIR/$i.original" ]]; then
        cp -a -- "$WORK_DIR/$i.original" "${TARGETS[$i]}"
      elif [[ -e "$WORK_DIR/$i.absent" ]]; then
        rm -f -- "${TARGETS[$i]}"
      fi
    done
    echo 'Preflight failed; previous configuration files were restored.' >&2
  fi
  rm -rf -- "$WORK_DIR"
  exit "$result"
}
trap cleanup EXIT

for i in "${!TARGETS[@]}"; do
  if [[ -e "${TARGETS[$i]}" ]]; then
    cp -a -- "${TARGETS[$i]}" "$WORK_DIR/$i.original"
  else
    touch "$WORK_DIR/$i.absent"
  fi
done

cat > "$WORK_DIR/journald.conf" <<'EOF'
[Journal]
SystemMaxUse=256M
SystemMaxFileSize=32M
SystemKeepFree=1G
RuntimeMaxUse=64M
MaxRetentionSec=7day
EOF

# Preserve log paths, ownership directives and the distro's postrotate scripts.
# Skip shell script bodies so their commands are never treated as rotate options.
awk '
  /^[[:space:]]*(postrotate|prerotate|firstaction|lastaction|preremove)[[:space:]]*$/ {
    script = 1; print; next
  }
  script {
    print
    if ($0 ~ /^[[:space:]]*endscript[[:space:]]*$/) script = 0
    next
  }
  /\{[[:space:]]*$/ { block = 1; blocks++; print; next }
  block && /^[[:space:]]*(hourly|daily|weekly|monthly|yearly|size|minsize|maxsize|rotate|compress|nocompress|delaycompress|nodelaycompress)([[:space:]]|$)/ {
    next
  }
  block && /^[[:space:]]*\}[[:space:]]*$/ {
    print "    daily"
    print "    maxsize 20M"
    print "    rotate 4"
    print "    compress"
    print "    nodelaycompress"
    block = 0
  }
  { print }
  END { if (!blocks || block || script) exit 1 }
' /etc/logrotate.d/rsyslog > "$WORK_DIR/rsyslog"

cat > "$WORK_DIR/vpn" <<'EOF'
/var/log/accel-ppp/*.log {
    daily
    maxsize 10M
    rotate 4
    compress
    nodelaycompress
    copytruncate
    missingok
    notifempty
    su root root
}

/var/log/openvpn.log {
    daily
    maxsize 10M
    rotate 4
    compress
    nodelaycompress
    copytruncate
    missingok
    notifempty
    su root root
}
EOF

cat > "$WORK_DIR/logrotate.service" <<EOF
[Unit]
Description=Hourly size and retention check for system and VPN logs
Documentation=man:logrotate(8)

[Service]
Type=oneshot
ExecStart=$LOGROTATE --wait-for-state-lock /etc/logrotate.conf
TimeoutStartSec=30min
EOF

cat > "$WORK_DIR/logrotate.timer" <<'EOF'
[Unit]
Description=Check system and VPN log retention every hour

[Timer]
OnCalendar=hourly
RandomizedDelaySec=5m
Persistent=true
Unit=wg-admin-logrotate.service

[Install]
WantedBy=timers.target
EOF

install -d -m 755 -o root -g root /etc/systemd/journald.conf.d

atomic_install() {
  local source=$1 target=$2 temporary
  temporary=$(mktemp "${target}.XXXXXXXX.tmp")
  if ! install -m 644 -o root -g root "$source" "$temporary" ||
     ! mv -f -- "$temporary" "$target"; then
    rm -f -- "$temporary"
    return 1
  fi
}

atomic_install "$WORK_DIR/journald.conf" "${TARGETS[0]}"
atomic_install "$WORK_DIR/rsyslog" "${TARGETS[1]}"
atomic_install "$WORK_DIR/vpn" "${TARGETS[2]}"
atomic_install "$WORK_DIR/logrotate.service" "${TARGETS[3]}"
atomic_install "$WORK_DIR/logrotate.timer" "${TARGETS[4]}"

# Debug mode checks the entire include tree and never rotates or truncates logs.
"$LOGROTATE" --wait-for-state-lock --debug /etc/logrotate.conf
systemd-analyze verify "${TARGETS[3]}" "${TARGETS[4]}"

ACTIVATING=1
systemctl daemon-reload
systemctl restart systemd-journald
systemctl enable --now wg-admin-logrotate.timer

echo 'Log retention installed. The hourly timer enforces size limits; no forced rotation or explicit vacuum was performed.'
