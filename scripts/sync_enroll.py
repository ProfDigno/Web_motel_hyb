"""Authorize a new PC with an existing SSH administrator; never store its password."""
from __future__ import annotations

import base64
import hashlib
from pathlib import Path
import re
import shlex
import subprocess

import paramiko


VPS_HOST = "163.245.222.236"
VPS_HOST_KEY_B64 = "AAAAC3NzaC1lZDI1NTE5AAAAIHqO28CfDgS7nFtCr7Ld6QtONcGebqBHqDYzEV4Nj/R3"
VPS_HOST_FINGERPRINT = "SHA256:WgNEJySuVDOJy1SR7/OAuq5pw+5+wROhF1VbYIFUOqY"
TARGET_KEYS = "/home/motel-sync/.ssh/authorized_keys"


def validate_public_key(value: str) -> str:
    key = value.strip()
    if len(key) > 400 or not re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/=]+(?: [A-Za-z0-9_.@-]+)?", key):
        raise ValueError("La clave pública SSH no tiene un formato válido.")
    raw = base64.b64decode(key.split()[1], validate=True)
    paramiko.Ed25519Key(data=raw)
    return key


def public_key_for_private_file(path: Path) -> str:
    if not path.is_file():
        raise FileNotFoundError("No existe la clave privada de esta PC. Pulse Crear clave de esta PC.")
    public_path = Path(str(path) + ".pub")
    if not public_path.is_file():
        raise FileNotFoundError("No existe la clave pública .pub de esta PC.")
    public_key = validate_public_key(public_path.read_text(encoding="ascii"))
    completed = subprocess.run(
        ["ssh-keygen", "-y", "-P", "", "-f", str(path)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=12, creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
    )
    if completed.returncode != 0 or completed.stdout.decode("ascii", errors="replace").split()[:2] != public_key.split()[:2]:
        raise ValueError("La clave pública no corresponde a la clave privada seleccionada, o esta requiere una contraseña.")
    return public_key


def _remote_script(public_key: str) -> str:
    """Fixed, idempotent root-side operation; public key is validated before insertion."""
    blob = public_key.split()[1]
    return f'''import fcntl
import os
import pwd
import stat
from pathlib import Path
key = {public_key!r}
blob = {blob!r}
path = Path({TARGET_KEYS!r})
owner = pwd.getpwnam("motel-sync").pw_uid
fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
try:
    details = os.fstat(fd)
    if not stat.S_ISREG(details.st_mode) or details.st_uid != owner or stat.S_IMODE(details.st_mode) != 0o600:
        raise RuntimeError("authorized_keys no tiene propietario o permisos seguros")
    with os.fdopen(fd, "r+", encoding="ascii", newline="") as keys:
        fd = -1
        fcntl.flock(keys.fileno(), fcntl.LOCK_EX)
        existing = keys.read()
        if any(len(parts := line.split()) >= 2 and parts[1] == blob for line in existing.splitlines()):
            print("ALREADY_PRESENT")
        else:
            keys.seek(0, os.SEEK_END)
            if existing and not existing.endswith("\\n"):
                keys.write("\\n")
            keys.write(key + "\\n")
            keys.flush()
            os.fsync(keys.fileno())
            print("ADDED")
finally:
    if fd >= 0:
        os.close(fd)
'''


def authorize_pc(config: dict[str, str | int], admin_user: str, admin_password: str, public_key: str) -> str:
    """Use password SSH and sudo only for this request; return no credential data."""
    if str(config["vps_host"]) != VPS_HOST:
        raise ValueError(f"El alta automática solo está habilitada para {VPS_HOST}.")
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*[$]?", admin_user):
        raise ValueError("Escriba un usuario SSH administrador válido.")
    if not admin_password or "\n" in admin_password or "\r" in admin_password:
        raise ValueError("Escriba la contraseña SSH de administrador.")
    public_key = validate_public_key(public_key)
    host_key = paramiko.Ed25519Key(data=base64.b64decode(VPS_HOST_KEY_B64))
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(host_key.asbytes()).digest()).decode("ascii").rstrip("=")
    if fingerprint != VPS_HOST_FINGERPRINT:
        raise RuntimeError("La huella incorporada del VPS no coincide; se canceló el alta.")
    port = int(config["ssh_port"])
    host_label = VPS_HOST if port == 22 else f"[{VPS_HOST}]:{port}"
    client = paramiko.SSHClient()
    client.get_host_keys().add(host_label, "ssh-ed25519", host_key)
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect(VPS_HOST, port=port, username=admin_user, password=admin_password,
                       allow_agent=False, look_for_keys=False, timeout=10, banner_timeout=10, auth_timeout=10)
        script = _remote_script(public_key)
        encoded = base64.b64encode(script.encode("utf-8")).decode("ascii")
        python_command = f"/usr/bin/python3 -c {shlex.quote(f'import base64;exec(base64.b64decode({encoded!r}))')}"
        command = python_command if admin_user == "root" else f"sudo -S -p '' {python_command}"
        stdin, stdout, stderr = client.exec_command(command, timeout=20)
        if admin_user != "root":
            stdin.write(admin_password + "\n")
            stdin.flush()
        stdin.channel.shutdown_write()
        result = stdout.read().decode("utf-8", errors="replace").strip()
        error = stderr.read().decode("utf-8", errors="replace").strip()
        code = stdout.channel.recv_exit_status()
        if code != 0:
            raise RuntimeError("No se pudo autorizar la PC en el VPS. Verifique que el usuario tenga sudo y que la contraseña sea correcta. " + error[-400:])
        if result not in {"ADDED", "ALREADY_PRESENT"}:
            raise RuntimeError("El VPS no confirmó el alta de la clave; verifique sus permisos.")
        return result
    except paramiko.AuthenticationException as error:
        raise RuntimeError("Usuario o contraseña SSH de administrador incorrectos.") from error
    finally:
        client.close()
