from __future__ import annotations

import ctypes
from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import time

import psycopg
from sync_config import PROJECT, REMOTE_PASSFILE, LOCAL_SECRET, LEGACY_LOCAL_SECRET, load, local_password


CONFIG = load()
SSH_KEY = Path(str(CONFIG["ssh_key"]))
KNOWN_HOSTS = Path(str(CONFIG["known_hosts"]))
LOG_FILE = PROJECT / "logs" / "occupancy-sync.log"
STOP_FILE = PROJECT / "sync-state" / "stop-request"
VPS_HOST = str(CONFIG["vps_host"])
TUNNEL_PORT = int(CONFIG["tunnel_port"])
INTERVAL_SECONDS = int(CONFIG["occupancy_interval_seconds"])
REPORT_INTERVAL_SECONDS = int(CONFIG["report_interval_minutes"]) * 60
REPORT_RETRY_SECONDS = 5 * 60
REPORT_STATE_FILE = PROJECT / "sync-state" / "python-report-sync.json"
PG_DUMP = Path(str(CONFIG["pg_dump"]))

COLUMNS = (
    "room_id", "reception_id", "room_number", "room_type", "state",
    "state_description", "room_description", "elapsed_label", "elapsed_seconds",
    "amount", "background_color", "text_color", "entry_at", "is_hour",
    "is_sleep", "is_lodging", "advance", "extra_hours", "client_door",
    "cleaning_door", "is_manual", "minimum_amount", "additional_unit_amount",
    "consumption_amount", "sort_order", "source_at",
)

SOURCE_SQL = """
SELECT idhabitacion_dato AS room_id,
  COALESCE(idhabitacion_recepcion_actual,0) AS reception_id,
  nro_habitacion::integer AS room_number,
  COALESCE(tipo_habitacion,'') AS room_type,
  COALESCE(estado,'') AS state,
  COALESCE(descrip_estado,estado,'') AS state_description,
  COALESCE(descripcion_habitacion,'') AS room_description,
  COALESCE(tiempo_estado,'.') AS elapsed_label,
  GREATEST(COALESCE(CASE
    WHEN estado='OCUPADO' THEN extract(epoch FROM current_timestamp-fec_ocupado_inicio)
    WHEN estado IN ('SUCIO','LIMPIANDO') THEN extract(epoch FROM current_timestamp-fec_ocupado_fin)
    ELSE 0 END,0)::integer,0) AS elapsed_seconds,
  COALESCE(monto_gral,0) AS amount,
  COALESCE(color_fondo,'#F0F0F0') AS background_color,
  COALESCE(color_texto,'#000000') AS text_color,
  CASE WHEN estado='OCUPADO' THEN fec_ocupado_inicio ELSE NULL END AS entry_at,
  COALESCE(es_por_hora,false) AS is_hour,
  COALESCE(es_por_dormir,false) AS is_sleep,
  COALESCE(es_hospedaje,false) AS is_lodging,
  COALESCE(monto_adelanto,0) AS advance,
  COALESCE(cant_hora_adicional,0) AS extra_hours,
  COALESCE(puerta_cliente,false) AS client_door,
  COALESCE(puerta_limpieza,false) AS cleaning_door,
  COALESCE(es_manual,false) AS is_manual,
  COALESCE(CASE
    WHEN es_hospedaje THEN monto_por_hospedaje_minimo
    WHEN es_por_dormir THEN monto_por_dormir_minimo
    WHEN es_por_hora THEN monto_por_hora_minimo
    ELSE 0 END,0) AS minimum_amount,
  COALESCE(CASE
    WHEN es_hospedaje THEN 0
    WHEN es_por_dormir THEN monto_por_dormir_adicional
    WHEN es_por_hora THEN monto_por_hora_adicional
    ELSE 0 END,0) AS additional_unit_amount,
  COALESCE(monto_consumision,0) AS consumption_amount,
  COALESCE(orden,0) AS sort_order,
  current_timestamp AS source_at
FROM habitacion_recepcion_temp
WHERE activo=true
ORDER BY orden,nro_habitacion
"""

INSERT_SQL = f"INSERT INTO occupancy_snapshot ({','.join(COLUMNS)}) VALUES ({','.join(['%s'] * len(COLUMNS))})"


def setup_logging() -> logging.Logger:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%d/%m/%y %H:%M:%S")
    logger = logging.getLogger("occupancy-sync")
    logger.setLevel(logging.INFO)
    if sys.stdout is not None:
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(formatter)
        logger.addHandler(console)
    file_handler = RotatingFileHandler(LOG_FILE, maxBytes=5_000_000, backupCount=3, encoding="utf-8")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)
    return logger


def acquire_single_instance() -> object | None:
    if sys.platform != "win32":
        return object()
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    handle = kernel32.CreateMutexW(None, False, "Local\\MotelOccupancyPythonSync")
    if not handle or kernel32.GetLastError() == 183:
        return None
    return handle


def read_local_password() -> str:
    password = local_password()
    if not password:
        raise RuntimeError("No se encontró la contraseña de PostgreSQL local.")
    return password


def validate_configuration() -> None:
    missing = [str(path) for path in (REMOTE_PASSFILE, SSH_KEY, KNOWN_HOSTS, PG_DUMP) if not path.is_file()]
    if not LOCAL_SECRET.is_file() and not LEGACY_LOCAL_SECRET.is_file():
        missing.append(str(LOCAL_SECRET))
    if missing:
        raise RuntimeError("Faltan archivos de configuración: " + ", ".join(missing))


def port_is_open() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", TUNNEL_PORT), timeout=1):
            return True
    except OSError:
        return False


def start_tunnel(logger: logging.Logger) -> subprocess.Popen[bytes]:
    command = [
        "ssh", "-N",
        "-L", f"127.0.0.1:{TUNNEL_PORT}:{CONFIG['remote_pg_host']}:{CONFIG['remote_pg_port']}",
        "-p", str(CONFIG["ssh_port"]),
        "-i", str(SSH_KEY),
        "-o", "BatchMode=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        "-o", "StrictHostKeyChecking=yes",
        "-o", f"UserKnownHostsFile={KNOWN_HOSTS}",
        f"{CONFIG['ssh_user']}@{VPS_HOST}",
    ]
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, creationflags=flags)
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if process.poll() is not None:
            error = (process.stderr.read() if process.stderr else b"").decode(errors="replace").strip()
            raise RuntimeError(f"No se pudo abrir el túnel SSH: {error or 'proceso finalizado'}")
        if port_is_open():
            logger.info("Túnel SSH conectado por el puerto local %s.", TUNNEL_PORT)
            return process
        time.sleep(0.25)
    process.terminate()
    raise RuntimeError("El túnel SSH no respondió dentro del tiempo esperado.")


def stop_tunnel(process: subprocess.Popen[bytes] | None) -> None:
    if not process or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()


def connect_local(password: str) -> psycopg.Connection:
    return psycopg.connect(host=str(CONFIG["local_host"]), port=int(CONFIG["local_port"]), dbname=str(CONFIG["local_database"]), user=str(CONFIG["local_user"]), password=password, connect_timeout=8)


def connect_remote() -> psycopg.Connection:
    return psycopg.connect(host="127.0.0.1", port=TUNNEL_PORT, dbname=str(CONFIG["remote_database"]), user=str(CONFIG["remote_user"]), passfile=str(REMOTE_PASSFILE), connect_timeout=8)


def wait_or_stop(stop_event: threading.Event, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while not stop_event.is_set():
        if STOP_FILE.exists():
            stop_event.set()
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        stop_event.wait(min(1, remaining))
    return True


def close_connection(connection: psycopg.Connection | None) -> None:
    if connection is not None:
        try:
            connection.close()
        except Exception:
            pass


def run_hidden(command: list[str], stop_event: threading.Event, env: dict[str, str] | None = None) -> str:
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=flags,
        env=env,
    )
    output = ""
    while True:
        try:
            output, _ = process.communicate(timeout=1)
            break
        except subprocess.TimeoutExpired:
            if stop_event.is_set():
                process.terminate()
                try:
                    output, _ = process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    output, _ = process.communicate()
                raise RuntimeError("Operación cancelada al detener la sincronización.")
    if process.returncode != 0:
        detail = output.strip().splitlines()
        raise RuntimeError(detail[-1] if detail else f"El proceso terminó con código {process.returncode}.")
    return output.strip()


def write_report_state() -> None:
    REPORT_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = REPORT_STATE_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps({"last_success_epoch": time.time(), "finished_at": datetime.now(timezone.utc).isoformat()}), encoding="utf-8")
    temporary.replace(REPORT_STATE_FILE)


def report_wait_seconds() -> float:
    try:
        state = json.loads(REPORT_STATE_FILE.read_text(encoding="utf-8"))
        return max(0.0, float(state["last_success_epoch"]) + REPORT_INTERVAL_SECONDS - time.time())
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        return 0.0


def synchronize_reports(local_password: str, logger: logging.Logger, stop_event: threading.Event) -> None:
    dump = Path(tempfile.gettempdir()) / "motel-hourly-python.dump"
    dump.unlink(missing_ok=True)
    local_env = os.environ.copy()
    local_env["PGPASSWORD"] = local_password
    ssh_options = [
        "-i", str(SSH_KEY),
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", f"UserKnownHostsFile={KNOWN_HOSTS}",
    ]
    ssh_port = ["-p", str(CONFIG["ssh_port"])]
    scp_port = ["-P", str(CONFIG["ssh_port"])]
    started = time.monotonic()
    try:
        logger.info("[INFORMES] Iniciando copia horaria de la base local.")
        run_hidden([
            str(PG_DUMP), "-w", "-h", str(CONFIG["local_host"]), "-p", str(CONFIG["local_port"]), "-U", str(CONFIG["local_user"]),
            "-d", str(CONFIG["local_database"]), "-Fc", "-Z", "6", "-f", str(dump),
        ], stop_event, local_env)
        if not dump.is_file() or dump.stat().st_size < 1024:
            raise RuntimeError("La copia local de informes quedó vacía.")
        run_hidden(["scp", *ssh_options, *scp_port, str(dump), f"{CONFIG['ssh_user']}@{VPS_HOST}:{CONFIG['remote_dump']}"], stop_event)
        result = run_hidden(["ssh", *ssh_options, *ssh_port, f"{CONFIG['ssh_user']}@{VPS_HOST}", "sudo " + shlex.quote(str(CONFIG["remote_import"]))], stop_event)
        write_report_state()
        detail = result.splitlines()[-1] if result else "Importación finalizada"
        logger.info("[INFORMES] %s en %.1f s. Próxima copia en una hora.", detail, time.monotonic() - started)
    finally:
        local_env["PGPASSWORD"] = ""
        dump.unlink(missing_ok=True)


def report_worker(local_password: str, logger: logging.Logger, stop_event: threading.Event) -> None:
    wait_seconds = report_wait_seconds()
    if wait_seconds:
        logger.info("[INFORMES] Próxima copia horaria en %d minutos.", max(1, round(wait_seconds / 60)))
    while not wait_or_stop(stop_event, wait_seconds):
        try:
            synchronize_reports(local_password, logger, stop_event)
            wait_seconds = REPORT_INTERVAL_SECONDS
        except Exception as error:
            if stop_event.is_set():
                return
            logger.error("[INFORMES] %s Reintento en %d minutos.", error, REPORT_RETRY_SECONDS // 60)
            wait_seconds = REPORT_RETRY_SECONDS


def synchronize(local: psycopg.Connection, remote: psycopg.Connection) -> int:
    with local.cursor() as cursor:
        cursor.execute(SOURCE_SQL)
        rows = cursor.fetchall()
    local.rollback()
    if not 1 <= len(rows) <= 200:
        raise RuntimeError(f"Cantidad de habitaciones inválida: {len(rows)}")
    with remote.transaction():
        with remote.cursor() as cursor:
            cursor.execute("TRUNCATE occupancy_snapshot")
            cursor.executemany(INSERT_SQL, rows)
            cursor.execute("SELECT count(*) FROM occupancy_snapshot")
            inserted = cursor.fetchone()[0]
            if inserted != len(rows):
                raise RuntimeError(f"Verificación remota incorrecta: {inserted} de {len(rows)}")
    return len(rows)


def main() -> int:
    if sys.platform == "win32":
        if sys.stdout is not None:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        ctypes.windll.kernel32.SetConsoleTitleW("Sincronización Motel - Ocupación e informes")
    logger = setup_logging()
    mutex = acquire_single_instance()
    if mutex is None:
        logger.error("Ya hay otra sincronización de ocupación ejecutándose.")
        return 2
    tunnel: subprocess.Popen[bytes] | None = None
    local: psycopg.Connection | None = None
    remote: psycopg.Connection | None = None
    stop_event = threading.Event()
    reports: threading.Thread | None = None
    try:
        if "--worker" not in sys.argv:
            STOP_FILE.unlink(missing_ok=True)
        validate_configuration()
        local_password = read_local_password()
        reports = threading.Thread(target=report_worker, args=(local_password, logger, stop_event), name="report-sync", daemon=True)
        reports.start()
        logger.info("Sincronización de ocupación e informes iniciada. Presione Ctrl+C para detenerla.")
        while True:
            started = time.monotonic()
            try:
                if tunnel is None or tunnel.poll() is not None:
                    stop_tunnel(tunnel)
                    tunnel = start_tunnel(logger)
                    close_connection(remote)
                    remote = None
                if local is None or local.closed:
                    local = connect_local(local_password)
                if remote is None or remote.closed:
                    remote = connect_remote()
                count = synchronize(local, remote)
                logger.info("[OCUPACIÓN] %s habitaciones actualizadas en %.2f s.", count, time.monotonic() - started)
            except Exception as error:
                logger.error("[OCUPACIÓN] %s Reintento en %s segundos.", error, INTERVAL_SECONDS)
                close_connection(local)
                close_connection(remote)
                local = remote = None
                if tunnel is not None and tunnel.poll() is not None:
                    stop_tunnel(tunnel)
                    tunnel = None
            elapsed = time.monotonic() - started
            if wait_or_stop(stop_event, max(1, INTERVAL_SECONDS - elapsed)):
                break
    except KeyboardInterrupt:
        logger.info("Sincronización detenida por el usuario.")
        return 0
    except Exception as error:
        logger.error("No se pudo iniciar: %s", error)
        return 1
    finally:
        stop_event.set()
        close_connection(local)
        close_connection(remote)
        stop_tunnel(tunnel)
        if reports is not None:
            reports.join(timeout=10)


if __name__ == "__main__":
    raise SystemExit(main())
