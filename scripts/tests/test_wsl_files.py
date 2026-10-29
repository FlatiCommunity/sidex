"""Run the actual fixed WSL helper against a Linux filesystem, without WSL mocks."""

import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[2] / "crates/sidex-remote/src/wsl_files.py"
spec = importlib.util.spec_from_file_location("wsl_files", HELPER)
wsl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wsl)


class WslFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def request(self, operation, path, **kwargs):
        return wsl.handle(dict(kwargs, op=operation, path=str(path)))

    def test_binary_and_linux_filenames_round_trip_without_shell_interpretation(self):
        path = self.root / "Привет: $(touch injected) 'quoted'\n?.bin"
        content = bytes(range(256)) * 17
        self.request("write", path, data=list(content), create=True, overwrite=False)
        self.assertEqual(bytes(self.request("read", path)), content)
        self.assertFalse((self.root / "injected").exists())
        names = dict(self.request("readdir", self.root))
        self.assertIn(path.name, names)

    def test_case_sensitive_filenames_remain_distinct(self):
        for name, content in (("Name", b"upper"), ("name", b"lower")):
            self.request("write", self.root / name, data=list(content))
        self.assertEqual(bytes(self.request("read", self.root / "Name")), b"upper")
        self.assertEqual(bytes(self.request("read", self.root / "name")), b"lower")

    def test_creation_and_overwrite_contracts_preserve_existing_data(self):
        path = self.root / "file"
        with self.assertRaises(FileNotFoundError):
            self.request("write", path, data=[1], create=False)
        self.request("write", path, data=[1, 2])
        with self.assertRaises(FileExistsError):
            self.request("write", path, data=[9], overwrite=False)
        with self.assertRaises(ValueError):
            self.request("write", path, data=[999])
        self.assertEqual(path.read_bytes(), b"\x01\x02")
        self.assertFalse(list(self.root.glob(".sidex-save-*")))

    def test_saving_through_symlink_preserves_link_and_mode(self):
        target = self.root / "script"
        target.write_bytes(b"old")
        target.chmod(0o751)
        link = self.root / "link"
        link.symlink_to(target)
        self.request("write", link, data=list(b"new"))
        self.assertTrue(link.is_symlink())
        self.assertEqual(target.read_bytes(), b"new")
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o751)
        self.assertEqual(self.request("stat", link)["type"], 65)

    def test_rename_and_delete_obey_options_and_do_not_follow_directory_symlinks(self):
        source, target = self.root / "first", self.root / "second"
        source.write_bytes(b"first")
        target.write_bytes(b"second")
        with self.assertRaises(FileExistsError):
            self.request("rename", source, target=str(target), overwrite=False)
        self.request("rename", source, target=str(target), overwrite=True)
        self.assertEqual(target.read_bytes(), b"first")
        sub = self.root / "sub"
        sub.mkdir()
        (sub / "keep").write_text("keep")
        link = self.root / "symlink"
        link.symlink_to(sub, target_is_directory=True)
        self.request("delete", link, recursive=True)
        self.assertTrue((sub / "keep").exists())
        with self.assertRaises(PermissionError):
            self.request("delete", "/", recursive=True)
        root_link = self.root / "root_link"
        root_link.symlink_to("/", target_is_directory=True)
        with self.assertRaises(PermissionError):
            self.request("delete", str(root_link) + "/.", recursive=True)
        with self.assertRaises(PermissionError):
            self.request("rename", target, target=str(root_link) + "/.", overwrite=True)
        self.assertTrue(target.exists())

    def test_snapshot_observes_external_changes_and_applies_exclusions(self):
        sub = self.root / "nested"
        self.request("mkdir", sub)
        path = sub / "test"
        path.write_bytes(b"a")
        first = self.request("snapshot", self.root, recursive=True)
        path.write_bytes(b"changed")
        second = self.request("snapshot", self.root, recursive=True)
        self.assertNotEqual(first[str(path)], second[str(path)])
        self.assertNotIn(str(path), self.request("snapshot", self.root, recursive=True, excludes=[str(sub)]))
        self.request("delete", sub, recursive=True)
        self.assertNotIn(str(path), self.request("snapshot", self.root, recursive=True))

    def test_stdio_protocol_returns_structured_errors_and_binary_arrays(self):
        path = self.root / "missing"
        result = subprocess.run(
            ["python3", str(HELPER)], input=json.dumps({"op": "read", "path": str(path)}),
            text=True, capture_output=True, check=True,
        )
        response = json.loads(result.stdout)
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "FileNotFound")


if __name__ == "__main__":
    unittest.main()
