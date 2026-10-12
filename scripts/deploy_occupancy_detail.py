"""Publica de forma segura la actualización de ocupación en el VPS.

Las credenciales SSH se solicitan en pantalla y solo se conservan en memoria
durante la publicación.
"""
from __future__ import annotations

import base64
import hashlib
from pathlib import Path
import re
import shlex
import threading
import tkinter as tk
from tkinter import messagebox, ttk

import paramiko

from sync_enroll import VPS_HOST, VPS_HOST_FINGERPRINT, VPS_HOST_KEY_B64


PROJECT = Path(__file__).resolve().parent.parent
RELEASE = PROJECT / "motel-occupancy-detail-release.tar.gz"
REMOTE_RELEASE = "/tmp/motel-occupancy-detail-release.tar.gz"


def _deployment_script() -> str:
    return r'''from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request

archive = Path("/tmp/motel-occupancy-detail-release.tar.gz")
application = Path("/opt/motel-web")
backup_root = Path("/opt/motel-web-backups")
stamp = time.strftime("%Y%m%d-%H%M%S")
backup = backup_root / ("occupancy-detail-" + stamp)
stage = Path(tempfile.mkdtemp(prefix="motel-release-", dir="/var/tmp"))
backup.mkdir(parents=True, exist_ok=False)

try:
    with tarfile.open(archive, "r:gz") as package:
        members = package.getmembers()
        for member in members:
            parts = Path(member.name).parts
            if member.name.startswith("/") or ".." in parts:
                raise RuntimeError("El paquete contiene una ruta no permitida")
            if not (member.name.startswith("dist/") or member.name in {
                "scripts/auth.sql", "scripts/import-occupancy.sh",
                "scripts/migrate-occupancy-financial.sql"
            }):
                raise RuntimeError("Archivo inesperado en el paquete: " + member.name)
        package.extractall(stage)

    required = [
        stage / "dist/server/index.js",
        stage / "dist/web/index.html",
        stage / "scripts/migrate-occupancy-financial.sql",
        stage / "scripts/import-occupancy.sh",
    ]
    if not all(path.is_file() for path in required):
        raise RuntimeError("El paquete de publicación está incompleto")

    shutil.copytree(application / "dist", backup / "dist")
    old_import = application / "scripts/import-occupancy.sh"
    if old_import.is_file():
        (backup / "scripts").mkdir()
        shutil.copy2(old_import, backup / "scripts/import-occupancy.sh")

    migration_sql = (stage / "scripts/migrate-occupancy-financial.sql").read_text(encoding="utf-8")
    subprocess.run([
        "runuser", "-u", "postgres", "--", "psql", "-v", "ON_ERROR_STOP=1",
        "-d", "motel_web_auth", "-f", "-"
    ], input=migration_sql, text=True, check=True)

    failed_dist = backup / "failed-dist"
    try:
        shutil.rmtree(application / "dist")
        shutil.copytree(stage / "dist", application / "dist")
        shutil.copy2(stage / "scripts/import-occupancy.sh", old_import)
        old_import.chmod(0o755)
        subprocess.run(["systemctl", "restart", "motel-web.service"], check=True)
        last_error = None
        for _ in range(15):
            try:
                with urllib.request.urlopen("http://127.0.0.1:3000/api/csrf", timeout=2) as response:
                    if response.status == 200:
                        last_error = None
                        break
            except Exception as error:
                last_error = error
                time.sleep(1)
        if last_error is not None:
            raise RuntimeError("El servicio no respondió después de reiniciarse")
    except Exception:
        if (application / "dist").exists():
            shutil.move(application / "dist", failed_dist)
        shutil.copytree(backup / "dist", application / "dist")
        saved_import = backup / "scripts/import-occupancy.sh"
        if saved_import.is_file():
            shutil.copy2(saved_import, old_import)
            old_import.chmod(0o755)
        subprocess.run(["systemctl", "restart", "motel-web.service"], check=False)
        raise

    print("DEPLOYED:" + str(backup))
finally:
    shutil.rmtree(stage, ignore_errors=True)
    archive.unlink(missing_ok=True)
'''


def deploy(admin_user: str, admin_password: str) -> str:
    if not RELEASE.is_file():
        raise FileNotFoundError(f"No se encontró el paquete: {RELEASE}")
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*[$]?", admin_user):
        raise ValueError("Escriba un usuario SSH administrador válido.")
    if not admin_password or "\n" in admin_password or "\r" in admin_password:
        raise ValueError("Escriba la contraseña SSH de administrador.")

    host_key = paramiko.Ed25519Key(data=base64.b64decode(VPS_HOST_KEY_B64))
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(host_key.asbytes()).digest()).decode("ascii").rstrip("=")
    if fingerprint != VPS_HOST_FINGERPRINT:
        raise RuntimeError("La identidad incorporada del VPS no coincide. Se canceló la publicación.")

    client = paramiko.SSHClient()
    client.get_host_keys().add(VPS_HOST, "ssh-ed25519", host_key)
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect(VPS_HOST, port=22, username=admin_user, password=admin_password,
                       allow_agent=False, look_for_keys=False, timeout=12,
                       banner_timeout=12, auth_timeout=12)
        with client.open_sftp() as sftp:
            sftp.put(str(RELEASE), REMOTE_RELEASE, confirm=True)

        encoded = base64.b64encode(_deployment_script().encode("utf-8")).decode("ascii")
        python_command = f"/usr/bin/python3 -c {shlex.quote(f'import base64;exec(base64.b64decode({encoded!r}))')}"
        command = python_command if admin_user == "root" else f"sudo -S -p '' {python_command}"
        stdin, stdout, stderr = client.exec_command(command, timeout=120, get_pty=False)
        if admin_user != "root":
            stdin.write(admin_password + "\n")
            stdin.flush()
        stdin.channel.shutdown_write()
        result = stdout.read().decode("utf-8", errors="replace").strip()
        error = stderr.read().decode("utf-8", errors="replace").strip()
        code = stdout.channel.recv_exit_status()
        if code != 0:
            raise RuntimeError("No se pudo publicar. Verifique el usuario, la contraseña y el permiso sudo.\n" + error[-800:])
        confirmation = next((line for line in result.splitlines() if line.startswith("DEPLOYED:")), "")
        if not confirmation:
            raise RuntimeError("El VPS no confirmó la publicación.")
        return confirmation.removeprefix("DEPLOYED:")
    except paramiko.AuthenticationException as error:
        raise RuntimeError("Usuario o contraseña SSH de administrador incorrectos.") from error
    finally:
        client.close()


class DeploymentWindow:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title("Publicar detalle de Ocupación")
        self.root.resizable(False, False)
        self.user = tk.StringVar()
        self.password = tk.StringVar()
        self.status = tk.StringVar(value="Preparado para publicar")
        self._build()

    def _build(self) -> None:
        frame = ttk.Frame(self.root, padding=20)
        frame.grid()
        ttk.Label(frame, text="Publicar actualización", font=("Segoe UI", 16, "bold")).grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 6))
        ttk.Label(frame, text="Ingrese una cuenta SSH con permiso sudo. La contraseña no se guarda.").grid(row=1, column=0, columnspan=2, sticky="w", pady=(0, 16))
        ttk.Label(frame, text="Usuario SSH").grid(row=2, column=0, sticky="w", padx=(0, 12), pady=5)
        user_entry = ttk.Entry(frame, textvariable=self.user, width=36)
        user_entry.grid(row=2, column=1, pady=5)
        ttk.Label(frame, text="Contraseña").grid(row=3, column=0, sticky="w", padx=(0, 12), pady=5)
        ttk.Entry(frame, textvariable=self.password, show="•", width=36).grid(row=3, column=1, pady=5)
        self.button = ttk.Button(frame, text="Publicar ahora", command=self.start)
        self.button.grid(row=4, column=1, sticky="e", pady=(16, 8))
        ttk.Label(frame, textvariable=self.status, foreground="#35536b").grid(row=5, column=0, columnspan=2, sticky="w")
        user_entry.focus_set()

    def start(self) -> None:
        admin_user = self.user.get().strip()
        admin_password = self.password.get()
        self.password.set("")
        self.button.configure(state="disabled")
        self.status.set("Publicando y verificando el servicio…")

        def worker() -> None:
            nonlocal admin_password
            try:
                backup = deploy(admin_user, admin_password)
            except Exception as error:
                self.root.after(0, lambda: self.finish_error(str(error)))
            else:
                self.root.after(0, lambda: self.finish_ok(backup))
            finally:
                admin_password = None

        threading.Thread(target=worker, daemon=True).start()

    def finish_error(self, error: str) -> None:
        self.button.configure(state="normal")
        self.status.set("No se publicó la actualización")
        messagebox.showerror("Publicación", error, parent=self.root)

    def finish_ok(self, backup: str) -> None:
        self.status.set("Actualización publicada correctamente")
        messagebox.showinfo("Publicación completa", f"La web fue actualizada y verificada.\n\nRespaldo: {backup}", parent=self.root)
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


if __name__ == "__main__":
    DeploymentWindow().run()
