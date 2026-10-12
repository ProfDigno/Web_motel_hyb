#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" -eq 0
test ! -e /etc/motel-web.env || { echo 'Environment already exists; refusing to replace secrets' >&2; exit 1; }
useradd --system --home-dir /opt/motel-web --shell /usr/sbin/nologin motel-web 2>/dev/null || true
useradd --create-home --shell /bin/bash motel-sync 2>/dev/null || true
install -d -m 700 -o motel-sync -g motel-sync /home/motel-sync/.ssh
report_password=$(openssl rand -hex 24)
auth_password=$(openssl rand -hex 24)
session_secret=$(openssl rand -hex 48)
sudo -u postgres psql -v ON_ERROR_STOP=1 -qc "CREATE ROLE motel_report LOGIN PASSWORD '$report_password'"
sudo -u postgres psql -v ON_ERROR_STOP=1 -qc "CREATE ROLE motel_auth LOGIN PASSWORD '$auth_password'"
sudo -u postgres createdb -O motel_auth motel_web_auth
PGPASSWORD="$auth_password" psql -h 127.0.0.1 -U motel_auth -d motel_web_auth -v ON_ERROR_STOP=1 -f /opt/motel-web/scripts/auth.sql
umask 077
printf 'PORT=3000\nNODE_ENV=production\nPUBLIC_ORIGIN=https://163.245.222.236\nREPORT_DATABASE_URL=postgresql://motel_report:%s@127.0.0.1:5432/bddaomotelkm8_23_live\nAUTH_DATABASE_URL=postgresql://motel_auth:%s@127.0.0.1:5432/motel_web_auth\nAUTH_DB_PASSWORD=%s\nSESSION_SECRET=%s\n' "$report_password" "$auth_password" "$auth_password" "$session_secret" > /etc/motel-web.env
chmod 600 /etc/motel-web.env
printf 'motel-sync ALL=(root) NOPASSWD: /opt/motel-web/scripts/import-report.sh, /opt/motel-web/scripts/import-occupancy.sh\n' > /etc/sudoers.d/motel-sync
chmod 440 /etc/sudoers.d/motel-sync
visudo -cf /etc/sudoers.d/motel-sync
install -m 644 /opt/motel-web/scripts/motel-web.service /etc/systemd/system/motel-web.service
chmod 755 /opt/motel-web/scripts/import-report.sh
chmod 755 /opt/motel-web/scripts/import-occupancy.sh
systemctl daemon-reload
echo 'Motel web provisioned'
