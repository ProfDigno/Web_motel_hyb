#!/usr/bin/env bash
set -euo pipefail
exec 9>/run/lock/motel-occupancy-sync.lock
flock -n 9 || { echo 'Another occupancy sync is running' >&2; exit 1; }
set -a
source /etc/motel-web.env
set +a
incoming=/home/motel-sync/occupancy.csv
working=/var/tmp/motel-occupancy.csv
test -s "$incoming"
install -m 600 -o root -g root "$incoming" "$working"
cleanup() { rm -f -- "$working"; }
trap cleanup EXIT
PGPASSWORD="$AUTH_DB_PASSWORD" psql -h 127.0.0.1 -U motel_auth -d motel_web_auth -v ON_ERROR_STOP=1 <<SQL
BEGIN;
CREATE TEMP TABLE occupancy_import (LIKE occupancy_snapshot INCLUDING ALL) ON COMMIT DROP;
\copy occupancy_import(room_id,reception_id,room_number,room_type,state,state_description,room_description,elapsed_label,elapsed_seconds,amount,background_color,text_color,entry_at,is_hour,is_sleep,is_lodging,advance,extra_hours,client_door,cleaning_door,is_manual,minimum_amount,additional_unit_amount,consumption_amount,sort_order,source_at) FROM '$working' WITH (FORMAT CSV, HEADER true, ENCODING 'UTF8');
DO \$\$
DECLARE imported integer;
BEGIN
  SELECT count(*) INTO imported FROM occupancy_import;
  IF imported < 1 OR imported > 200 THEN
    RAISE EXCEPTION 'Invalid occupancy row count: %', imported;
  END IF;
END
\$\$;
TRUNCATE occupancy_snapshot;
INSERT INTO occupancy_snapshot SELECT * FROM occupancy_import;
COMMIT;
SQL
rm -f -- "$incoming"
echo "Imported $(PGPASSWORD="$AUTH_DB_PASSWORD" psql -h 127.0.0.1 -U motel_auth -d motel_web_auth -Atqc 'SELECT count(*) FROM occupancy_snapshot') rooms"
