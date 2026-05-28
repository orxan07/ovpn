#!/bin/bash
set -e

APP_DIR="/opt/wg-admin"

sudo install -m 755 "$APP_DIR/scripts/app.sh" /usr/local/bin/app
