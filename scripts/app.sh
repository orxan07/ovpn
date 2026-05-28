#!/bin/bash
APP_DIR="/opt/wg-admin"

case "$1" in
  start)   sudo systemctl start wg-admin ;;
  stop)    sudo systemctl stop wg-admin ;;
  restart) cd "$APP_DIR" && git pull && sudo systemctl restart wg-admin ;;
  kill)    sudo systemctl stop wg-admin ;;
  status)  sudo systemctl status wg-admin --no-pager ;;
  logs)    sudo journalctl -u wg-admin -f --no-pager ;;
  deploy)  bash "$APP_DIR/scripts/deploy.sh" ;;
  token)   grep AUTH_TOKEN "$APP_DIR/server/.env" | cut -d= -f2 ;;
  *)
    echo "Использование: app <команда>"
    echo ""
    echo "  start    — запустить"
    echo "  stop     — остановить"
    echo "  restart  — git pull + перезапустить"
    echo "  kill     — остановить"
    echo "  status   — статус сервиса"
    echo "  logs     — логи в реальном времени"
    echo "  deploy   — git pull + npm install + sync presets + перезапустить"
    echo "  token    — показать auth token"
    ;;
esac
