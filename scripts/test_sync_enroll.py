import base64
import hashlib
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from sync_config import defaults
from sync_enroll import (VPS_HOST_FINGERPRINT, VPS_HOST_KEY_B64, _remote_script,
                         authorize_pc, public_key_for_private_file, validate_public_key)
from sync_gui import create_local_ssh_key


class EnrollmentTests(unittest.TestCase):
    def test_pinned_host_key_matches_fingerprint(self):
        fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(base64.b64decode(VPS_HOST_KEY_B64)).digest()).decode().rstrip("=")
        self.assertEqual(fingerprint, VPS_HOST_FINGERPRINT)

    def test_local_public_key_matches_private_key(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "motel_sync_ed25519"
            expected = create_local_ssh_key(path)
            self.assertEqual(public_key_for_private_file(path), expected)
            self.assertEqual(validate_public_key(expected), expected)
            with self.assertRaisesRegex(ValueError, "formato"):
                validate_public_key("ssh-ed25519 not-base64!")

    def test_refuses_other_vps_before_connecting(self):
        config = defaults()
        config["vps_host"] = "example.net"
        with self.assertRaisesRegex(ValueError, "solo está habilitada"):
            authorize_pc(config, "admin", "example-password", "bad-key")

    def test_remote_script_compiles(self):
        key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILRFGP0AGXQzwTnNl0Ex4UOLk0N0Qv8p+XDXT8IZMDPA motel-sync-OPTIMUS_i5"
        compile(_remote_script(key), "<remote-enrollment>", "exec")


if __name__ == "__main__":
    unittest.main()
