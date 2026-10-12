import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sync_gui import (VPS_ED25519_FINGERPRINT, check_ssh_files, create_local_ssh_key,
                      save_verified_vps_key, scan_verified_vps_key, ssh_error_detail)
from sync_config import defaults


class GuiDiagnosticsTests(unittest.TestCase):
    def test_missing_key_is_specific(self):
        with TemporaryDirectory() as directory:
            config = defaults()
            config["ssh_key"] = str(Path(directory) / "missing_key")
            with self.assertRaisesRegex(FileNotFoundError, "clave privada SSH"):
                check_ssh_files(config)

    def test_host_key_error_explains_next_step(self):
        message = ssh_error_detail(b"Host key verification failed.", 255)
        self.assertIn("known_hosts", message)

    def test_permission_error_explains_public_key(self):
        message = ssh_error_detail(b"Permission denied (publickey).", 255)
        self.assertIn("clave p\u00fablica", message)

    def test_verified_host_key_is_saved_once(self):
        with TemporaryDirectory() as directory:
            config = defaults()
            config["known_hosts"] = str(Path(directory) / ".ssh" / "known_hosts")
            key = "163.245.222.236 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHqO28CfDgS7nFtCr7Ld6QtONcGebqBHqDYzEV4Nj/R3"
            self.assertTrue(save_verified_vps_key(config, key))
            self.assertFalse(save_verified_vps_key(config, key))
            self.assertEqual(Path(config["known_hosts"]).read_text().count(key), 1)
            with self.assertRaisesRegex(RuntimeError, "otra clave"):
                save_verified_vps_key(config, key.replace("Nj/R3", "Nj/R4"))

    def test_scan_accepts_only_pinned_fingerprint(self):
        config = defaults()
        key = "163.245.222.236 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHqO28CfDgS7nFtCr7Ld6QtONcGebqBHqDYzEV4Nj/R3"
        result = type("Result", (), {"stdout": (key + "\n").encode(), "returncode": 0})()
        with patch("sync_gui.subprocess.run", return_value=result):
            self.assertEqual(scan_verified_vps_key(config), key)
        self.assertEqual(VPS_ED25519_FINGERPRINT, "SHA256:WgNEJySuVDOJy1SR7/OAuq5pw+5+wROhF1VbYIFUOqY")
        with patch("sync_gui.subprocess.run", return_value=result), patch("sync_gui.VPS_ED25519_FINGERPRINT", "SHA256:incorrecta"):
            with self.assertRaisesRegex(RuntimeError, "no coincide"):
                scan_verified_vps_key(config)

    def test_creates_per_pc_key_without_overwriting_it(self):
        with TemporaryDirectory() as directory:
            private = Path(directory) / "ssh" / "motel_sync_ed25519"
            public = create_local_ssh_key(private)
            self.assertTrue(private.is_file())
            self.assertTrue(Path(str(private) + ".pub").is_file())
            self.assertTrue(public.startswith("ssh-ed25519 "))
            with self.assertRaises(FileExistsError):
                create_local_ssh_key(private)


if __name__ == "__main__":
    unittest.main()
