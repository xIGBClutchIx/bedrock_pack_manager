"""A paramiko stand-in backed by a local folder, so SFTPStorage runs its real code in tests."""

import errno
import os
import shutil
from pathlib import Path
from unittest import mock

_HOST_KEY = None


def host_key():
    global _HOST_KEY
    if _HOST_KEY is None:
        import paramiko

        _HOST_KEY = paramiko.RSAKey.generate(1024)
    return _HOST_KEY


class FakeSFTP:
    def __init__(self, root: Path) -> None:
        self.root = root

    def _local(self, path: str) -> Path:
        return self.root / path.lstrip("/")

    @staticmethod
    def _missing(path):
        return OSError(errno.ENOENT, "No such file", str(path))

    def normalize(self, _path):
        return "/"

    def listdir_attr(self, path):
        import paramiko

        local = self._local(path)
        if not local.is_dir():
            raise self._missing(path)
        return [paramiko.SFTPAttributes.from_stat(child.stat(), child.name) for child in local.iterdir()]

    def stat(self, path):
        import paramiko

        local = self._local(path)
        if not local.exists():
            raise self._missing(path)
        return paramiko.SFTPAttributes.from_stat(local.stat(), local.name)

    def getfo(self, path, handle):
        local = self._local(path)
        if not local.is_file():
            raise self._missing(path)
        handle.write(local.read_bytes())

    def putfo(self, handle, path, file_size=0, confirm=True):
        self._local(path).write_bytes(handle.read())

    def mkdir(self, path):
        local = self._local(path)
        if local.exists():
            raise OSError(errno.EEXIST, "exists")
        local.mkdir()

    def remove(self, path):
        local = self._local(path)
        if not local.exists():
            raise self._missing(path)
        local.unlink()

    def rmdir(self, path):
        self._local(path).rmdir()

    def posix_rename(self, source, target):
        os.replace(self._local(source), self._local(target))

    def rename(self, source, target):
        shutil.move(self._local(source), self._local(target))

    def close(self):
        pass


class FakeHostKeys(dict):
    def add(self, hostname, keytype, key):
        self[hostname] = key


def make_client_class(root: Path, password: str | None = "pw"):
    class FakeSSHClient:
        def __init__(self):
            self._host_keys = FakeHostKeys()
            self._policy = None

        def load_system_host_keys(self):
            pass

        def load_host_keys(self, filename):
            for line in Path(filename).read_text(encoding="utf-8").splitlines():
                parts = line.split()
                if len(parts) == 3 and parts[2] == host_key().get_base64():
                    self._host_keys[parts[0]] = host_key()

        def set_missing_host_key_policy(self, policy):
            self._policy = policy

        def get_host_keys(self):
            return self._host_keys

        def connect(self, hostname, port=22, username=None, password=None, **_kwargs):
            import paramiko

            entry = hostname if port == 22 else f"[{hostname}]:{port}"
            if entry not in self._host_keys:
                self._policy.missing_host_key(self, hostname, host_key())
            if expected_password is not None and password != expected_password:
                raise paramiko.AuthenticationException("Authentication failed.")

        def open_sftp(self):
            return FakeSFTP(root)

        def close(self):
            pass

    expected_password = password
    return FakeSSHClient


def make_sftp_storage(root: Path, *, password="pw", trusted=True, known_hosts_file=None, server_password="pw"):
    import paramiko
    from bedrock_pack_manager.storage.sftp import SFTPStorage, fingerprint_of

    with mock.patch.object(paramiko, "SSHClient", make_client_class(root, server_password)):
        return SFTPStorage(
            "sftp.test",
            username="mc",
            password=password,
            root="/",
            known_hosts_file=known_hosts_file,
            trusted_fingerprint=fingerprint_of(host_key()) if trusted else None,
        )
