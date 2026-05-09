#!/usr/bin/env bash
#
# Освободить место, занятое логами VPN-стека:
# - accel-ppp/SSTP file logs
# - nginx access/error logs и rotated-файлы
# - временные build-логи accel-ppp
# - systemd-journal с ограничением размера
#
# Не трогает /var/log/auth.log, /var/log/syslog и другие системные текстовые логи.

set -euo pipefail

truncate_or_create() {
  local file="$1"
  install -d "$(dirname "$file")"
  : > "$file"
}

clear_log_glob() {
  local dir="$1"
  install -d "$dir"

  for f in "$dir"/*.log*; do
    [ -e "$f" ] || continue
    case "$f" in
      *.log) : > "$f" ;;
      *) rm -f "$f" ;;
    esac
  done
}

echo "[clear-vpn-logs] accel-ppp logs"
clear_log_glob /var/log/accel-ppp
truncate_or_create /var/log/accel-ppp/accel-ppp.log
truncate_or_create /var/log/accel-ppp/core.log
truncate_or_create /var/log/accel-ppp/emerg.log
truncate_or_create /var/log/accel-ppp/auth-fail.log

echo "[clear-vpn-logs] nginx logs"
if [ -d /var/log/nginx ]; then
  clear_log_glob /var/log/nginx
  truncate_or_create /var/log/nginx/access.log
  truncate_or_create /var/log/nginx/error.log
fi

echo "[clear-vpn-logs] temporary accel-ppp build logs"
rm -f /tmp/accel-cmake.log /tmp/accel-build.log

echo "[clear-vpn-logs] systemd journal vacuum"
if command -v journalctl >/dev/null 2>&1; then
  journalctl --rotate >/dev/null 2>&1 || true
  journalctl --vacuum-size=50M >/dev/null 2>&1 || true
fi

echo "[clear-vpn-logs] done"
