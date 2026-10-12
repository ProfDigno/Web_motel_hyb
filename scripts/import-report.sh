#!/usr/bin/env bash
set -euo pipefail
exec 9>/run/lock/motel-report-sync.lock
flock -n 9 || { echo 'Another sync is running' >&2; exit 1; }
set -a
source /etc/motel-web.env
set +a
dump=/home/motel-sync/incoming.dump
test -s "$dump"
restore_dump=/var/tmp/motel-report-incoming.dump
install -m 600 -o postgres -g postgres "$dump" "$restore_dump"
stage=bddaomotelkm8_23_stage
live=bddaomotelkm8_23_live
previous=bddaomotelkm8_23_previous
cleanup() {
  rm -f -- "$restore_dump"
  if sudo -u postgres psql -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname='$stage'" | grep -q 1; then
    sudo -u postgres dropdb --if-exists "$stage"
  fi
}
trap cleanup EXIT
sudo -u postgres dropdb --if-exists "$stage"
sudo -u postgres createdb -O motel_report "$stage"
sudo -u postgres pg_restore --exit-on-error --no-owner --no-acl -d "$stage" "$restore_dump"
sudo -u postgres psql -d "$stage" -v ON_ERROR_STOP=1 -qc "UPDATE usuario SET password=''"
sudo -u postgres psql -d "$stage" -v ON_ERROR_STOP=1 -qc "GRANT USAGE ON SCHEMA public TO motel_report; GRANT SELECT ON ALL TABLES IN SCHEMA public TO motel_report"
source_count=$(sudo -u postgres psql -d "$stage" -Atqc 'SELECT count(*) FROM caja_cierre')
test "$source_count" -gt 0
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -qc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$live','$previous') AND pid<>pg_backend_pid()"
sudo -u postgres dropdb --if-exists "$previous"
if sudo -u postgres psql -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname='$live'" | grep -q 1; then
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -qc "ALTER DATABASE $live RENAME TO $previous"
fi
if ! sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -qc "ALTER DATABASE $stage RENAME TO $live"; then
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -qc "ALTER DATABASE $previous RENAME TO $live" || true
  exit 1
fi
report_count=$(sudo -u postgres psql -d "$live" -Atqc 'SELECT count(*) FROM caja_cierre')
PGPASSWORD="$AUTH_DB_PASSWORD" psql -h 127.0.0.1 -U motel_auth -d motel_web_auth -v ON_ERROR_STOP=1 -c "INSERT INTO sync_run(source_count,report_count) VALUES($source_count,$report_count)"
if systemctl is-enabled --quiet motel-web.service; then systemctl restart motel-web.service; fi
rm -f -- "$dump"
echo "Imported $report_count cash closures"
