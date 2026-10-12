"""Configuración portable del sincronizador. Las contraseñas no van en JSON."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys


def project_dir() -> Path:
    if getattr(sys, "frozen", False):
        executable = Path(sys.executable).resolve()
        for candidate in (executable.parent, executable.parent.parent):
            if (candidate / "scripts" / "sync_occupancy.py").is_file():
                return candidate
        return executable.parent
    return Path(__file__).resolve().parents[1]


PROJECT = project_dir()
CONFIG_FILE = PROJECT / "scripts" / "sync-config.json"
LOCAL_SECRET = PROJECT / "scripts" / ".local-sync-password"
LEGACY_LOCAL_SECRET = PROJECT / "conexion_postgresql.txt"
REMOTE_PASSFILE = PROJECT / "scripts" / ".occupancy-sync.pgpass"


def defaults() -> dict[str, str | int]:
    return {
        "local_host": "127.0.0.1", "local_port": 5432,
        "local_database": "bddaomotelkm8_23", "local_user": "postgres",
        "pg_dump": r"C:\Program Files\PostgreSQL\17\bin\pg_dump.exe",
        "vps_host": "163.245.222.236", "ssh_port": 22,
        "ssh_user": "motel-sync", "ssh_key": str(Path.home() / ".ssh" / "motel_sync_ed25519"),
        "known_hosts": str(Path.home() / ".ssh" / "known_hosts"),
        "tunnel_port": 55432, "remote_pg_host": "127.0.0.1", "remote_pg_port": 5432,
        "remote_database": "motel_web_auth", "remote_user": "motel_occupancy_sync",
        "report_interval_minutes": 60, "occupancy_interval_seconds": 60,
        "remote_dump": "/home/motel-sync/incoming.dump",
        "remote_import": "/opt/motel-web/scripts/import-report.sh",
    }


PORT_KEYS = {"local_port", "ssh_port", "tunnel_port", "remote_pg_port"}
INT_KEYS = PORT_KEYS | {"report_interval_minutes", "occupancy_interval_seconds"}
HOST_KEYS = {"local_host", "vps_host", "remote_pg_host"}
NAME_KEYS = {"local_database", "local_user", "ssh_user", "remote_database", "remote_user"}


def validate(config: dict[str, object]) -> dict[str, str | int]:
    result: dict[str, str | int] = {}
    for key, default in defaults().items():
        value = config.get(key, default)
        if key in INT_KEYS:
            try:
                value = int(value)
            except (ValueError, TypeError) as error:
                raise ValueError(f"{key}: debe ser un número entero.") from error
            maximum = 65535 if key in PORT_KEYS else 1440 if key == "report_interval_minutes" else 3600
            if not 1 <= value <= maximum:
                raise ValueError(f"{key}: valor fuera de rango (1–{maximum}).")
        else:
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{key}: no puede estar vacío.")
            value = value.strip()
            if key in HOST_KEYS and not re.fullmatch(r"[A-Za-z0-9.:-]+", value):
                raise ValueError(f"{key}: nombre de servidor no válido.")
            if key in NAME_KEYS and not re.fullmatch(r"[A-Za-z0-9_.-]+", value):
                raise ValueError(f"{key}: nombre no válido.")
            if key in {"remote_dump", "remote_import"} and (not re.fullmatch(r"/[A-Za-z0-9_./-]+", value) or ".." in value):
                raise ValueError(f"{key}: se requiere una ruta absoluta del VPS.")
        result[key] = value
    return result


def load() -> dict[str, str | int]:
    if not CONFIG_FILE.is_file():
        return defaults()
    data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("El archivo de configuración debe contener un objeto JSON.")
    if any("password" in str(key).lower() or "contraseña" in str(key).lower() for key in data):
        raise ValueError("Las contraseñas no deben guardarse en sync-config.json.")
    return validate(data)


def protect_file(path: Path) -> None:
    if os.name == "nt":
        identity = subprocess.run(["whoami"], capture_output=True, text=True, check=True).stdout.strip()
        subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", f"{identity}:(F)"], capture_output=True, text=True, check=True)
    else:
        path.chmod(0o600)


def private_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.touch()
    protect_file(temporary)
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)
    protect_file(path)


def save(config: dict[str, object]) -> None:
    clean = validate(config)
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = CONFIG_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(clean, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(CONFIG_FILE)


def local_password() -> str:
    if LOCAL_SECRET.is_file():
        return LOCAL_SECRET.read_text(encoding="utf-8-sig").strip()
    if LEGACY_LOCAL_SECRET.is_file():
        for line in LEGACY_LOCAL_SECRET.read_text(encoding="utf-8-sig").splitlines():
            if line.startswith("Contraseña:"):
                return line.split(":", 1)[1].strip()
    return ""


def _pgpass_fields(line: str) -> list[str]:
    fields: list[str] = []
    part = ""
    escaped = False
    for char in line:
        if escaped:
            part += char
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == ":" and len(fields) < 4:
            fields.append(part)
            part = ""
        else:
            part += char
    fields.append(part)
    return fields


def remote_password() -> str:
    if not REMOTE_PASSFILE.is_file():
        return ""
    for line in REMOTE_PASSFILE.read_text(encoding="utf-8-sig").splitlines():
        if line and not line.startswith("#"):
            fields = _pgpass_fields(line)
            if len(fields) == 5:
                return fields[4]
    return ""


def save_passwords(local: str, remote: str, config: dict[str, str | int]) -> None:
    if not local or not remote or "\n" in local + remote or "\r" in local + remote:
        raise ValueError("Ambas contraseñas son obligatorias y deben ocupar una sola línea.")
    private_write(LOCAL_SECRET, local + "\n")
    escaped = remote.replace("\\", "\\\\").replace(":", "\\:")
    line = f"127.0.0.1:{config['tunnel_port']}:{config['remote_database']}:{config['remote_user']}:{escaped}\n"
    private_write(REMOTE_PASSFILE, line)
