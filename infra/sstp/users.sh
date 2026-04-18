#!/usr/bin/env bash
#
# Управление SSTP-пользователями (chap-secrets).
#
# Использование:
#   sudo bash users.sh list
#   sudo bash users.sh add <user> [password]      # password не указан -> сгенерится
#   sudo bash users.sh remove <user>
#   sudo bash users.sh passwd <user> <new_pass>

set -euo pipefail

SECRETS=/etc/accel-ppp/chap-secrets

require_root() {
  [ "$EUID" -eq 0 ] || { echo "Run as root."; exit 1; }
}

reload_sessions() {
  # accel-ppp перечитывает chap-secrets автоматически при следующей попытке логина,
  # но можно мягко передёрнуть через accel-cmd
  if command -v accel-cmd >/dev/null 2>&1; then
    accel-cmd reload >/dev/null 2>&1 || true
  fi
}

cmd_list() {
  echo "user            password (hidden)         ip"
  echo "-----------------------------------------------"
  awk '!/^#/ && NF { printf "%-15s %-25s %s\n", $1, "************", $4 }' "$SECRETS"
}

cmd_add() {
  local user="$1"
  local pass="${2:-$(openssl rand -hex 8)}"
  if grep -qE "^[[:space:]]*$user[[:space:]]" "$SECRETS"; then
    echo "User '$user' already exists. Use 'passwd' to change password." >&2
    exit 1
  fi
  echo "$user  *  $pass  *" >> "$SECRETS"
  reload_sessions
  echo "Added: $user / $pass"
}

cmd_remove() {
  local user="$1"
  sed -i "/^[[:space:]]*$user[[:space:]]/d" "$SECRETS"
  if command -v accel-cmd >/dev/null 2>&1; then
    accel-cmd "terminate username $user soft" >/dev/null 2>&1 || true
  fi
  reload_sessions
  echo "Removed: $user"
}

cmd_passwd() {
  local user="$1"
  local pass="$2"
  if ! grep -qE "^[[:space:]]*$user[[:space:]]" "$SECRETS"; then
    echo "User '$user' not found." >&2
    exit 1
  fi
  sed -i -E "s|^([[:space:]]*$user[[:space:]]+\\*[[:space:]]+)[^[:space:]]+|\\1$pass|" "$SECRETS"
  reload_sessions
  echo "Password updated for: $user"
}

require_root
case "${1:-}" in
  list)    cmd_list ;;
  add)     shift; cmd_add "$@" ;;
  remove)  shift; cmd_remove "$@" ;;
  passwd)  shift; cmd_passwd "$@" ;;
  *)
    cat <<USG
Usage:
  sudo $0 list
  sudo $0 add <user> [password]
  sudo $0 remove <user>
  sudo $0 passwd <user> <new_pass>
USG
    exit 1
    ;;
esac
