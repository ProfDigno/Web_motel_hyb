import unittest
from pathlib import Path
import tempfile
import threading
from unittest.mock import patch

import sync_config
import sync_occupancy
from sync_config import _pgpass_fields, defaults, validate


class SyncConfigTests(unittest.TestCase):
    def test_defaults_are_valid(self):
        self.assertEqual(validate(defaults()), defaults())

    def test_invalid_port(self):
        config = defaults()
        config["ssh_port"] = 70000
        with self.assertRaises(ValueError):
            validate(config)

    def test_remote_command_path_is_restricted(self):
        config = defaults()
        config["remote_import"] = "/opt/import.sh;rm"
        with self.assertRaises(ValueError):
            validate(config)

    def test_pgpass_escapes(self):
        self.assertEqual(_pgpass_fields(r"127.0.0.1:55432:motel_web_auth:motel_occupancy_sync:ab\:cd\\ef"),
                         ["127.0.0.1", "55432", "motel_web_auth", "motel_occupancy_sync", r"ab:cd\ef"])

    def test_passwords_are_separate_from_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(sync_config, "LOCAL_SECRET", root / "local.secret"), \
                 patch.object(sync_config, "REMOTE_PASSFILE", root / "remote.pgpass"):
                sync_config.save_passwords("local-secret", r"remote:secret\part", defaults())
                self.assertEqual(sync_config.local_password(), "local-secret")
                self.assertEqual(sync_config.remote_password(), r"remote:secret\part")
                self.assertFalse((root / "sync-config.json").exists())

    def test_stop_request_ends_wait(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "stop-request"
            marker.touch()
            event = threading.Event()
            with patch.object(sync_occupancy, "STOP_FILE", marker):
                self.assertTrue(sync_occupancy.wait_or_stop(event, 60))
            self.assertTrue(event.is_set())


if __name__ == "__main__":
    unittest.main()
