"""Ventana de configuración y control del sincronizador del motel."""
from __future__ import annotations

import ctypes
import base64
import hashlib
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext, ttk

import psycopg

from sync_config import PROJECT, load, local_password, protect_file, remote_password, save, save_passwords, validate
from sync_enroll import VPS_HOST_KEY_B64, authorize_pc, public_key_for_private_file


LOG_FILE = PROJECT / "logs" / "occupancy-sync.log"
STOP_FILE = PROJECT / "sync-state" / "stop-request"
VPS_HOST = "163.245.222.236"
VPS_ED25519_FINGERPRINT = "SHA256:WgNEJySuVDOJy1SR7/OAuq5pw+5+wROhF1VbYIFUOqY"

LOCAL_FIELDS = [
    ("local_host", "Servidor PostgreSQL"), ("local_port", "Puerto"),
    ("local_database", "Base de datos"), ("local_user", "Usuario"),
    ("pg_dump", "Ruta de pg_dump.exe"),
]
REMOTE_FIELDS = [
    ("vps_host", "IP o nombre del VPS"), ("ssh_port", "Puerto SSH"),
    ("ssh_user", "Usuario SSH"), ("ssh_key", "Clave privada SSH"),
    ("known_hosts", "Archivo known_hosts"),
    ("tunnel_port", "Puerto local del túnel"),
    ("remote_pg_host", "PostgreSQL en el VPS"),
    ("remote_pg_port", "Puerto PostgreSQL del VPS"),
    ("remote_database", "Base de datos web"), ("remote_user", "Usuario PostgreSQL web"),
]
ADVANCED_FIELDS = [
    ("occupancy_interval_seconds", "Habitaciones: cada cuántos segundos"),
    ("report_interval_minutes", "Informes: cada cuántos minutos"),
    ("remote_dump", "Destino de copia en el VPS"),
    ("remote_import", "Script de importación en el VPS"),
]


def ssh_base(config: dict[str, str | int]) -> list[str]:
    return ["ssh", "-i", str(config["ssh_key"]), "-p", str(config["ssh_port"]),
            "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", f"UserKnownHostsFile={config['known_hosts']}",
            "-o", "ConnectTimeout=8"]


def hidden_flags() -> int:
    return subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def check_ssh_files(config: dict[str, str | int]) -> None:
    key = Path(str(config["ssh_key"]))
    hosts = Path(str(config["known_hosts"]))
    if not key.is_file():
        raise FileNotFoundError(f"No existe la clave privada SSH: {key}. Seleccione un archivo existente o pulse Crear clave de esta PC en la pestaña VPS.")
    if not hosts.is_file():
        raise FileNotFoundError(f"No existe known_hosts: {hosts}. Copie o registre la identidad verificada del VPS antes de conectar.")


def ssh_error_detail(stderr: bytes, returncode: int) -> str:
    detail = stderr.decode("utf-8", errors="replace").strip()
    if not detail:
        return f"SSH terminó con código {returncode}, sin más detalles. Compruebe la red, el puerto y la clave."
    if "Host key verification failed" in detail or "No ED25519 host key is known" in detail:
        return detail + "\n\nVerifique la huella del VPS y registre su identidad en known_hosts; no desactive la comprobación SSH."
    if "Permission denied" in detail:
        return detail + "\n\nCompruebe el usuario SSH y que la clave pública esté autorizada en el VPS."
    if "Connection timed out" in detail or "Connection refused" in detail:
        return detail + "\n\nCompruebe la IP, el puerto SSH y el acceso a Internet."
    return detail


def scan_verified_vps_key(config: dict[str, str | int]) -> str:
    """Fetch the VPS public host key, accepting only the independently pinned key."""
    if str(config["vps_host"]) != VPS_HOST:
        raise ValueError(f"El registro automático solo admite el VPS {VPS_HOST}. Para otro servidor, verifique su huella por separado.")
    try:
        completed = subprocess.run(
            ["ssh-keyscan", "-T", "8", "-p", str(config["ssh_port"]), "-t", "ed25519", VPS_HOST],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=15, creationflags=hidden_flags(),
        )
        lines = completed.stdout.decode("ascii", errors="replace").splitlines()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        lines = []
    if not any("ssh-ed25519" in line for line in lines):
        # Some Windows ssh-keyscan builds cannot negotiate newer server KEX.
        # Accept into an isolated temporary file, then enforce the pinned fingerprint.
        with tempfile.TemporaryDirectory(prefix="motel-host-") as temporary:
            probe_file = Path(temporary) / "known_hosts"
            subprocess.run(
                ["ssh", "-p", str(config["ssh_port"]), "-o", "BatchMode=yes",
                 "-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={probe_file}",
                 "-o", "HostKeyAlgorithms=ssh-ed25519", "-o", "PreferredAuthentications=none",
                 "-o", "ConnectTimeout=8", f"{config['ssh_user']}@{VPS_HOST}", "true"],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=15, creationflags=hidden_flags(),
            )
            if probe_file.is_file():
                lines = probe_file.read_text(encoding="ascii", errors="replace").splitlines()
    keys: set[str] = set()
    for line in lines:
        parts = line.split()
        if len(parts) < 3 or parts[1] != "ssh-ed25519":
            continue
        try:
            raw = base64.b64decode(parts[2], validate=True)
        except ValueError:
            continue
        fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(raw).digest()).decode("ascii").rstrip("=")
        if fingerprint != VPS_ED25519_FINGERPRINT:
            raise RuntimeError(f"La huella recibida ({fingerprint}) no coincide con la huella verificada del VPS. No se guardó nada.")
        keys.add(parts[2])
    if len(keys) != 1:
        raise RuntimeError("No se pudo obtener una clave ED25519 válida del VPS. Revise la IP, el puerto y la red.")
    host = VPS_HOST if int(config["ssh_port"]) == 22 else f"[{VPS_HOST}]:{config['ssh_port']}"
    return f"{host} ssh-ed25519 {keys.pop()}"


def save_verified_vps_key(config: dict[str, str | int], key_line: str) -> bool:
    """Append a verified host key without overwriting existing trust entries."""
    target = Path(str(config["known_hosts"]))
    existing = target.read_text(encoding="utf-8") if target.exists() else ""
    host = key_line.split()[0]
    for line in existing.splitlines():
        parts = line.split()
        if len(parts) >= 3 and host in parts[0].split(",") and parts[1] == "ssh-ed25519":
            if parts[2] == key_line.split()[2]:
                return False
            raise RuntimeError("known_hosts ya contiene otra clave ED25519 para este VPS. No se modificó el archivo; revise el cambio de identidad.")
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="ascii", newline="\n") as output:
        if existing and not existing.endswith(("\n", "\r")):
            output.write("\n")
        output.write(key_line + "\n")
    return True


def create_local_ssh_key(path: Path) -> str:
    """Create a new per-PC key; never package or overwrite a private key."""
    public_path = Path(str(path) + ".pub")
    if path.exists() or public_path.exists():
        raise FileExistsError("Ya existe una clave privada o pública en esa ruta. Seleccione otra ubicación; no se sobrescribió nada.")
    path.parent.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        ["ssh-keygen", "-q", "-t", "ed25519", "-f", str(path), "-N", "",
         "-C", f"motel-sync-{socket.gethostname()}"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=20, creationflags=hidden_flags(),
    )
    if completed.returncode != 0 or not path.is_file() or not public_path.is_file():
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(detail or "No se pudo crear la clave SSH. Compruebe que OpenSSH esté instalado.")
    protect_file(path)
    public_key = public_path.read_text(encoding="ascii").strip()
    if not public_key.startswith("ssh-ed25519 "):
        raise RuntimeError("La clave pública generada no tiene el formato esperado.")
    return public_key


def sync_is_running() -> bool:
    if sys.platform != "win32":
        return False
    kernel32 = ctypes.windll.kernel32
    kernel32.OpenMutexW.restype = ctypes.c_void_p
    handle = kernel32.OpenMutexW(0x00100000, False, "Local\\MotelOccupancyPythonSync")
    if handle:
        kernel32.CloseHandle(handle)
        return True
    return False


class SyncWindow:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Sincronización Motel · Configuración")
        self.root.geometry("850x700")
        self.root.minsize(690, 560)
        self.vars: dict[str, tk.StringVar] = {}
        self.messages: queue.Queue[tuple[str, str]] = queue.Queue()
        self.worker: subprocess.Popen[bytes] | None = None
        self.show_passwords = tk.BooleanVar(value=False)
        self.status = tk.StringVar(value="Sincronización detenida")
        self.last_log = ""
        self.pending_host_config: dict[str, str | int] | None = None
        self._build()
        try:
            self._load()
        except Exception as error:
            messagebox.showerror("Configuración", str(error))
        self.root.after(700, self._refresh)

    def _build(self) -> None:
        style = ttk.Style(self.root)
        if "vista" in style.theme_names():
            style.theme_use("vista")
        outer = ttk.Frame(self.root, padding=18)
        outer.pack(fill="both", expand=True)
        ttk.Label(outer, text="Sincronización Motel", font=("Segoe UI", 18, "bold")).pack(anchor="w")
        ttk.Label(outer, text="Configure el origen local y el VPS. Las habitaciones se actualizan cada minuto y los informes cada hora.").pack(anchor="w", pady=(2, 12))
        tabs = ttk.Notebook(outer)
        tabs.pack(fill="both", expand=True)
        local = ttk.Frame(tabs, padding=18)
        remote = ttk.Frame(tabs, padding=18)
        advanced = ttk.Frame(tabs, padding=18)
        activity = ttk.Frame(tabs, padding=12)
        tabs.add(local, text="PC local")
        tabs.add(remote, text="VPS")
        tabs.add(advanced, text="Frecuencia y rutas")
        tabs.add(activity, text="Actividad reciente")
        self._fields(local, LOCAL_FIELDS)
        self._password(local, "local_password", "Contraseña PostgreSQL local", len(LOCAL_FIELDS))
        ttk.Button(local, text="Probar base local", command=self.test_local).grid(row=len(LOCAL_FIELDS) + 1, column=1, sticky="w", pady=12)
        self._fields(remote, REMOTE_FIELDS)
        self._password(remote, "remote_password", "Contraseña PostgreSQL VPS", len(REMOTE_FIELDS))
        checks = ttk.Frame(remote)
        checks.grid(row=len(REMOTE_FIELDS) + 1, column=1, sticky="w", pady=12)
        ttk.Button(checks, text="Probar SSH", command=self.test_ssh).pack(side="left", padx=(0, 8))
        ttk.Button(checks, text="Registrar VPS seguro", command=self.register_vps).pack(side="left", padx=(0, 8))
        ttk.Button(checks, text="Probar base VPS", command=self.test_vps).pack(side="left")
        key_actions = ttk.Frame(remote)
        key_actions.grid(row=len(REMOTE_FIELDS) + 2, column=1, sticky="w")
        ttk.Button(key_actions, text="Crear clave de esta PC", command=self.create_ssh_key).pack(side="left", padx=(0, 8))
        ttk.Button(key_actions, text="Ver clave pública", command=self.view_public_key).pack(side="left", padx=(0, 8))
        ttk.Button(key_actions, text="Autorizar esta PC", command=self.authorize_this_pc).pack(side="left")
        self._fields(advanced, ADVANCED_FIELDS)
        ttk.Label(advanced, text="Cambie estas rutas solo si el VPS tiene otra instalación. Guardar no modifica usuarios ni contraseñas del servidor.", wraplength=620).grid(row=len(ADVANCED_FIELDS), column=0, columnspan=3, sticky="w", pady=12)
        ttk.Label(activity, text="Registro de sincronización de habitaciones e informes").pack(anchor="w", pady=(0, 8))
        self.log = scrolledtext.ScrolledText(activity, state="disabled", font=("Consolas", 10), wrap="word")
        self.log.pack(fill="both", expand=True)
        for frame in (local, remote, advanced):
            frame.columnconfigure(1, weight=1)
        ttk.Checkbutton(outer, text="Mostrar contraseñas", variable=self.show_passwords, command=self._toggle_passwords).pack(anchor="w", pady=(10, 3))
        actions = ttk.Frame(outer)
        actions.pack(fill="x", pady=(0, 10))
        ttk.Button(actions, text="Guardar parámetros", command=self.save_form).pack(side="left", padx=(0, 8))
        ttk.Button(actions, text="Iniciar sincronización", command=self.start).pack(side="left", padx=(0, 8))
        ttk.Button(actions, text="Detener sincronización", command=self.stop).pack(side="left")
        ttk.Label(actions, textvariable=self.status).pack(side="right")
        self.root.protocol("WM_DELETE_WINDOW", self._close)

    def _fields(self, frame: ttk.Frame, fields: list[tuple[str, str]]) -> None:
        for row, (key, label) in enumerate(fields):
            ttk.Label(frame, text=label).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=5)
            variable = tk.StringVar()
            self.vars[key] = variable
            ttk.Entry(frame, textvariable=variable).grid(row=row, column=1, sticky="ew", pady=5)
            if key in {"pg_dump", "ssh_key", "known_hosts"}:
                ttk.Button(frame, text="Buscar…", command=lambda name=key: self._browse(name)).grid(row=row, column=2, padx=(8, 0))

    def _password(self, frame: ttk.Frame, key: str, label: str, row: int) -> None:
        ttk.Label(frame, text=label).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=5)
        variable = tk.StringVar()
        self.vars[key] = variable
        entry = ttk.Entry(frame, textvariable=variable, show="•")
        entry.grid(row=row, column=1, sticky="ew", pady=5)
        setattr(self, key + "_entry", entry)

    def _toggle_passwords(self) -> None:
        for entry in (self.local_password_entry, self.remote_password_entry):
            entry.configure(show="" if self.show_passwords.get() else "•")

    def _browse(self, key: str) -> None:
        selected = filedialog.askopenfilename(initialdir=str(Path(self.vars[key].get()).parent))
        if selected:
            self.vars[key].set(selected)

    def _load(self) -> None:
        config = load()
        for key, value in config.items():
            self.vars[key].set(str(value))
        self.vars["local_password"].set(local_password())
        self.vars["remote_password"].set(remote_password())

    def _values(self) -> dict[str, str | int]:
        return validate({key: self.vars[key].get() for key in self.vars if key not in {"local_password", "remote_password"}})

    def save_form(self) -> bool:
        try:
            config = self._values()
            save_passwords(self.vars["local_password"].get(), self.vars["remote_password"].get(), config)
            save(config)
        except Exception as error:
            messagebox.showerror("No se pudo guardar", str(error))
            return False
        self.status.set("Parámetros guardados. Reinicie la sincronización para aplicarlos.")
        return True

    def _task(self, title: str, action) -> None:
        self.status.set(f"{title}…")
        def run() -> None:
            try:
                detail = action()
                self.messages.put(("ok", f"{title}: {detail}"))
            except Exception as error:
                self.messages.put(("error", f"{title}: {error}"))
        threading.Thread(target=run, daemon=True).start()

    def test_local(self) -> None:
        try:
            config = self._values()
            password = self.vars["local_password"].get()
            if not password:
                raise ValueError("Indique la contraseña local.")
        except Exception as error:
            messagebox.showerror("Base local", str(error))
            return
        def action() -> str:
            with psycopg.connect(host=str(config["local_host"]), port=int(config["local_port"]), dbname=str(config["local_database"]), user=str(config["local_user"]), password=password, connect_timeout=8) as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT count(*) FROM habitacion_recepcion_temp WHERE activo=true")
                    rooms = cursor.fetchone()[0]
            return f"conexión correcta; {rooms} habitaciones activas"
        self._task("Base local", action)

    def test_ssh(self) -> None:
        try:
            config = self._values()
            check_ssh_files(config)
        except Exception as error:
            messagebox.showerror("SSH", str(error))
            return
        def action() -> str:
            command = [*ssh_base(config), f"{config['ssh_user']}@{config['vps_host']}", "true"]
            completed = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, creationflags=hidden_flags())
            if completed.returncode != 0:
                raise RuntimeError(ssh_error_detail(completed.stderr, completed.returncode))
            return "conexión SSH correcta"
        self._task("SSH", action)

    def create_ssh_key(self) -> None:
        try:
            config = self._values()
            path = Path(str(config["ssh_key"]))
            if not messagebox.askyesno("Crear clave SSH", f"Se creará una clave nueva en esta PC:\n{path}\n\nLa clave privada quedará solo aquí. Después deberá autorizar la clave pública en el VPS. ¿Continuar?"):
                return
            public_key = create_local_ssh_key(path)
        except Exception as error:
            messagebox.showerror("Crear clave SSH", str(error))
            return
        self.status.set("Clave SSH creada; falta autorizarla en el VPS")
        self._show_public_key(public_key)

    def view_public_key(self) -> None:
        try:
            config = self._values()
            public_path = Path(str(config["ssh_key"]) + ".pub")
            public_key = public_path.read_text(encoding="ascii").strip()
            if not public_key.startswith("ssh-ed25519 "):
                raise ValueError("El archivo no contiene una clave pública ED25519 válida.")
        except Exception as error:
            messagebox.showerror("Clave pública", f"No se pudo abrir la clave pública: {error}")
            return
        self._show_public_key(public_key)

    def _show_public_key(self, public_key: str) -> None:
        dialog = tk.Toplevel(self.root)
        dialog.title("Clave pública para autorizar en el VPS")
        dialog.geometry("740x270")
        dialog.transient(self.root)
        dialog.grab_set()
        body = ttk.Frame(dialog, padding=18)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text="Envíe solo esta clave PÚBLICA para autorizar la nueva PC en el VPS.", wraplength=680).pack(anchor="w", pady=(0, 10))
        ttk.Label(body, text="No comparta el archivo de clave privada indicado en el formulario.", wraplength=680).pack(anchor="w", pady=(0, 10))
        output = tk.Text(body, height=4, wrap="word")
        output.insert("1.0", public_key)
        output.configure(state="disabled")
        output.pack(fill="both", expand=True)
        buttons = ttk.Frame(body)
        buttons.pack(anchor="e", pady=(12, 0))
        def copy_public_key() -> None:
            self.root.clipboard_clear()
            self.root.clipboard_append(public_key)
            messagebox.showinfo("Clave pública", "Clave pública copiada. Puede enviarla para autorizar esta PC en el VPS.", parent=dialog)
        ttk.Button(buttons, text="Copiar clave pública", command=copy_public_key).pack(side="left", padx=(0, 8))
        ttk.Button(buttons, text="Cerrar", command=dialog.destroy).pack(side="left")

    def authorize_this_pc(self) -> None:
        try:
            config = self._values()
            if str(config["vps_host"]) != VPS_HOST:
                raise ValueError(f"El alta automática solo está habilitada para {VPS_HOST}.")
        except Exception as error:
            messagebox.showerror("Autorizar esta PC", str(error))
            return
        dialog = tk.Toplevel(self.root)
        dialog.title("Autorizar esta PC en el VPS")
        dialog.geometry("500x265")
        dialog.transient(self.root)
        dialog.grab_set()
        body = ttk.Frame(dialog, padding=18)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text="Ingrese un usuario SSH administrador con sudo. La contraseña se usa solo para esta autorización y no se guarda.", wraplength=450).grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 14))
        admin_user = tk.StringVar()
        admin_password = tk.StringVar()
        ttk.Label(body, text="Usuario SSH administrador").grid(row=1, column=0, sticky="w", pady=5)
        user_entry = ttk.Entry(body, textvariable=admin_user)
        user_entry.grid(row=1, column=1, sticky="ew", pady=5)
        ttk.Label(body, text="Contraseña SSH").grid(row=2, column=0, sticky="w", pady=5)
        password_entry = ttk.Entry(body, textvariable=admin_password, show="•")
        password_entry.grid(row=2, column=1, sticky="ew", pady=5)
        show = tk.BooleanVar(value=False)
        ttk.Checkbutton(body, text="Mostrar contraseña", variable=show,
                        command=lambda: password_entry.configure(show="" if show.get() else "•")).grid(row=3, column=1, sticky="w", pady=5)
        body.columnconfigure(1, weight=1)
        def submit() -> None:
            username = admin_user.get().strip()
            password = admin_password.get()
            if not username or not password:
                messagebox.showerror("Autorizar esta PC", "Escriba el usuario y la contraseña SSH de administrador.", parent=dialog)
                return
            admin_password.set("")
            dialog.destroy()
            def action() -> str:
                key_path = Path(str(config["ssh_key"]))
                if not key_path.exists() and not Path(str(key_path) + ".pub").exists():
                    public_key = create_local_ssh_key(key_path)
                else:
                    public_key = public_key_for_private_file(key_path)
                outcome = authorize_pc(config, username, password, public_key)
                host = VPS_HOST if int(config["ssh_port"]) == 22 else f"[{VPS_HOST}]:{config['ssh_port']}"
                save_verified_vps_key(config, f"{host} ssh-ed25519 {VPS_HOST_KEY_B64}")
                save(config)
                test = subprocess.run([*ssh_base(config), f"{config['ssh_user']}@{config['vps_host']}", "true"],
                                      stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      timeout=15, creationflags=hidden_flags())
                if test.returncode != 0:
                    raise RuntimeError("La clave fue registrada, pero la prueba SSH falló: " + ssh_error_detail(test.stderr, test.returncode))
                return "clave creada y acceso SSH comprobado" if outcome == "ADDED" else "acceso SSH comprobado; la clave ya estaba autorizada"
            self._task("Autorizar esta PC", action)
        buttons = ttk.Frame(body)
        buttons.grid(row=4, column=1, sticky="e", pady=(14, 0))
        ttk.Button(buttons, text="Cancelar", command=dialog.destroy).pack(side="left", padx=(0, 8))
        ttk.Button(buttons, text="Autorizar", command=submit).pack(side="left")
        user_entry.focus_set()

    def register_vps(self) -> None:
        if self.pending_host_config is not None:
            return
        try:
            config = self._values()
        except Exception as error:
            messagebox.showerror("Registrar VPS", str(error))
            return
        self.pending_host_config = config
        self.status.set("Comprobando identidad del VPS…")
        def run() -> None:
            try:
                self.messages.put(("host_key", scan_verified_vps_key(config)))
            except Exception as error:
                self.messages.put(("host_key_error", str(error)))
        threading.Thread(target=run, daemon=True).start()

    def test_vps(self) -> None:
        try:
            config = self._values()
            check_ssh_files(config)
            password = self.vars["remote_password"].get()
            if not password:
                raise ValueError("Indique la contraseña PostgreSQL del VPS.")
        except Exception as error:
            messagebox.showerror("Base VPS", str(error))
            return
        def action() -> str:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            command = [*ssh_base(config), "-N", "-o", "ExitOnForwardFailure=yes", "-L", f"127.0.0.1:{port}:{config['remote_pg_host']}:{config['remote_pg_port']}", f"{config['ssh_user']}@{config['vps_host']}"]
            tunnel = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, creationflags=hidden_flags())
            try:
                deadline = time.monotonic() + 12
                while time.monotonic() < deadline:
                    if tunnel.poll() is not None:
                        detail = tunnel.stderr.read().decode(errors="replace").strip() if tunnel.stderr else ""
                        raise RuntimeError(detail or "No se pudo abrir el túnel SSH.")
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=1):
                            break
                    except OSError:
                        time.sleep(0.25)
                else:
                    raise TimeoutError("El túnel SSH no respondió.")
                with psycopg.connect(host="127.0.0.1", port=port, dbname=str(config["remote_database"]), user=str(config["remote_user"]), password=password, connect_timeout=8) as connection:
                    with connection.cursor() as cursor:
                        cursor.execute("SELECT count(*) FROM occupancy_snapshot")
                        rooms = cursor.fetchone()[0]
                return f"conexión correcta; {rooms} habitaciones en la última copia"
            finally:
                tunnel.terminate()
                try:
                    tunnel.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    tunnel.kill()
        self._task("Base VPS", action)

    def start(self) -> None:
        if sync_is_running():
            messagebox.showinfo("Sincronización", "Ya hay una sincronización ejecutándose. Ciérrela antes de iniciar otra.")
            return
        if not self.save_form():
            return
        STOP_FILE.unlink(missing_ok=True)
        command = [sys.executable, "--worker"] if getattr(sys, "frozen", False) else [sys.executable, str(Path(__file__).resolve()), "--worker"]
        try:
            self.worker = subprocess.Popen(command, cwd=PROJECT, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=hidden_flags())
        except Exception as error:
            messagebox.showerror("Inicio", str(error))
            return
        self.status.set("Iniciando sincronización…")

    def stop(self) -> None:
        if not sync_is_running():
            self.status.set("No hay sincronización ejecutándose")
            return
        STOP_FILE.parent.mkdir(parents=True, exist_ok=True)
        STOP_FILE.touch()
        self.status.set("Solicitando parada segura…")

    def _refresh(self) -> None:
        while not self.messages.empty():
            kind, detail = self.messages.get_nowait()
            if kind in {"host_key", "host_key_error"}:
                config = self.pending_host_config
                self.pending_host_config = None
                if kind == "host_key_error":
                    self.status.set("No se registró el VPS")
                    messagebox.showerror("Registrar VPS", detail)
                elif config is not None and messagebox.askyesno("Registrar identidad del VPS", f"Se verificó la huella ED25519 del VPS {VPS_HOST}:\n\n{VPS_ED25519_FINGERPRINT}\n\n¿Guardar esta identidad en known_hosts?"):
                    try:
                        added = save_verified_vps_key(config, detail)
                        self.status.set("Identidad del VPS registrada" if added else "El VPS ya estaba registrado")
                        messagebox.showinfo("Registrar VPS", "Identidad guardada. Ya puede pulsar Probar SSH." if added else "La identidad ya estaba guardada. Puede pulsar Probar SSH.")
                    except Exception as error:
                        messagebox.showerror("Registrar VPS", str(error))
                else:
                    self.status.set("Registro del VPS cancelado")
                continue
            self.status.set(detail)
            if kind == "error":
                messagebox.showerror("Prueba de conexión", detail)
            else:
                messagebox.showinfo("Prueba de conexión", detail)
        if self.worker is not None:
            code = self.worker.poll()
            if code is not None:
                self.status.set("Sincronización detenida" if code == 0 else f"Sincronización finalizada con error ({code}); revise el registro")
                self.worker = None
        elif sync_is_running() and not self.status.get().startswith("Solicitando"):
            self.status.set("Sincronización ejecutándose en segundo plano")
        elif not sync_is_running() and self.status.get().startswith("Solicitando"):
            self.status.set("Sincronización detenida")
        if LOG_FILE.is_file():
            recent = "\n".join(LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()[-80:])
            if recent != self.last_log:
                self.log.configure(state="normal")
                self.log.delete("1.0", "end")
                self.log.insert("end", recent)
                self.log.see("end")
                self.log.configure(state="disabled")
                self.last_log = recent
        self.root.after(2000, self._refresh)

    def _close(self) -> None:
        if self.worker is not None and self.worker.poll() is None:
            if not messagebox.askyesno("Cerrar ventana", "La sincronización seguirá ejecutándose en segundo plano. ¿Cerrar la ventana?"):
                return
        self.root.destroy()


def main() -> int:
    if "--worker" in sys.argv:
        from sync_occupancy import main as sync_main
        return sync_main()
    root = tk.Tk()
    SyncWindow(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
