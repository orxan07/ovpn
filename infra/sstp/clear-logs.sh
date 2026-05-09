#!/usr/bin/env bash
#
# Очистить логи accel-ppp/SSTP без удаления текущего открытого log-файла.
# Rotated-файлы удаляются, текущий accel-ppp.log обнуляется.

set -euo pipefail

LOG_DIR="/var/log/accel-ppp"
LOG_FILE="$LOG_DIR/accel-ppp.log"

install -d "$LOG_DIR"

for f in "$LOG_DIR"/*.log*; do
  [ -e "$f" ] || continue
  if [ "$f" = "$LOG_FILE" ]; then
    : > "$f"
  else
    rm -f "$f"
  fi
done

touch "$LOG_FILE"
