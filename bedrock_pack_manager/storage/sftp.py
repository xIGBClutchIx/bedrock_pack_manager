"""SFTP storage built on paramiko, with explicit host-key trust."""

import base64
import hashlib
import io
import posixpath
import stat
from pathlib import Path

from .base import Entry, Storage, StorageError, join


class UnknownHostKeyError(StorageError):
    """The server's host key is not trusted yet. Show the fingerprint to the user."""

    def __init__(self, host: str, port: int, key_type: str, fingerprint: str) -> None:
        self.host = host
        self.port = port
        self.key_type = key_type
        self.fingerprint = fingerprint
        super().__init__(f"Unknown SSH host key for {host}:{port} ({key_type} {fingerprint}). Confirm the fingerprint to trust it.")


class HostKeyMismatchError(StorageError):
    pass


def fingerprint_of(key) -> str:
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")


def _host_entry(host: str, port: int) -> str:
    return host if port == 22 else f"[{host}]:{port}"


class SFTPStorage(Storage):
    cache_listings = True

    def __init__(
        self,
        host: str,
        *,
        port: int = 22,
        username: str = "",
        password: str | None = None,
        key_file: str | None = None,
        key_passphrase: str | None = None,
        root: str = "",
        known_hosts_file: Path | None = None,
        trusted_fingerprint: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        super().__init__()
        self.host = host
        self.port = port
        self.username = username
        self._password = password or None
        self._key_file = key_file or None
        self._key_passphrase = key_passphrase or None
        self.known_hosts_file = known_hosts_file
        self.trusted_fingerprint = trusted_fingerprint
        self.timeout = timeout
        self._client = None
        self._sftp = None
        self.root = root or ""
        self._connect()
        self.label = f"sftp://{username}@{host}:{port}{self.root if self.root.startswith('/') else '/' + self.root}"

    # ---- connection ---------------------------------------------------------------------------

    def _connect(self) -> None:
        import paramiko

        storage = self

        class _TrustPolicy(paramiko.MissingHostKeyPolicy):
            def missing_host_key(self, client, hostname, key):  # noqa: D401 - paramiko hook
                fingerprint = fingerprint_of(key)
                if storage.trusted_fingerprint and storage.trusted_fingerprint.strip() in {fingerprint, fingerprint.removeprefix("SHA256:")}:
                    client.get_host_keys().add(_host_entry(storage.host, storage.port), key.get_name(), key)
                    storage._remember_host_key(key)
                    return
                raise UnknownHostKeyError(storage.host, storage.port, key.get_name(), fingerprint)

        client = paramiko.SSHClient()
        try:
            client.load_system_host_keys()
        except OSError:
            pass
        if self.known_hosts_file and self.known_hosts_file.exists():
            try:
                client.load_host_keys(str(self.known_hosts_file))
            except OSError:
                pass
        client.set_missing_host_key_policy(_TrustPolicy())

        try:
            client.connect(
                self.host,
                port=self.port,
                username=self.username or None,
                password=self._password,
                key_filename=self._key_file,
                passphrase=self._key_passphrase,
                timeout=self.timeout,
                banner_timeout=self.timeout,
                auth_timeout=self.timeout,
                allow_agent=self._password is None,
                look_for_keys=self._password is None and self._key_file is None,
            )
        except UnknownHostKeyError:
            client.close()
            raise
        except paramiko.BadHostKeyException as exc:
            client.close()
            raise HostKeyMismatchError(
                f"The SSH host key for {self.host} changed (now {fingerprint_of(exc.key)}). "
                "This can mean the server was reinstalled, or someone is intercepting the connection."
            ) from exc
        except paramiko.AuthenticationException as exc:
            client.close()
            raise StorageError(f"SFTP login failed for {self.username}@{self.host}: {exc}") from exc
        except (paramiko.SSHException, OSError) as exc:
            client.close()
            raise StorageError(f"Could not connect to {self.host}:{self.port} over SFTP: {exc}") from exc

        try:
            sftp = client.open_sftp()
        except Exception as exc:
            client.close()
            raise StorageError(f"Server {self.host} does not allow SFTP: {exc}") from exc

        if not self.root.startswith("/"):
            try:
                home = sftp.normalize(".")
            except OSError:
                home = "/"
            self.root = join(home, self.root) or "/"
        self._client = client
        self._sftp = sftp

    def _remember_host_key(self, key) -> None:
        if self.known_hosts_file is None:
            return
        self.known_hosts_file.parent.mkdir(parents=True, exist_ok=True)
        line = f"{_host_entry(self.host, self.port)} {key.get_name()} {key.get_base64()}\n"
        with open(self.known_hosts_file, "a", encoding="utf-8") as handle:
            handle.write(line)

    def close(self) -> None:
        for resource in (self._sftp, self._client):
            if resource is not None:
                try:
                    resource.close()
                except Exception:
                    pass
        self._sftp = None
        self._client = None

    def _abs(self, path: str) -> str:
        path = join(path)
        if path.startswith("/"):
            return path
        return join(self.root, path) or "/"

    def describe(self, path: str) -> str:
        return self._abs(path)

    def _channel(self):
        if self._sftp is None:
            self._connect()
        return self._sftp

    def _retry(self, func):
        try:
            return func(self._channel())
        except (EOFError, ConnectionError) as exc:
            self.close()
            try:
                self._connect()
            except StorageError:
                raise StorageError(f"Lost the SFTP connection to {self.host}: {exc}") from exc
            return func(self._sftp)

    # ---- primitives -----------------------------------------------------------------------------

    def _list_dir(self, path: str) -> list[Entry]:
        target = self._abs(path)

        def _list(sftp):
            entries = []
            for attr in sftp.listdir_attr(target):
                mode = attr.st_mode or 0
                if stat.S_ISLNK(mode):
                    try:
                        mode = sftp.stat(posixpath.join(target, attr.filename)).st_mode or 0
                    except OSError:
                        continue
                is_dir = stat.S_ISDIR(mode)
                entries.append(Entry(name=attr.filename, is_dir=is_dir, size=None if is_dir else attr.st_size))
            return entries

        try:
            return self._retry(_list)
        except FileNotFoundError:
            raise
        except OSError as exc:
            if getattr(exc, "errno", None) == 2:
                raise FileNotFoundError(target) from exc
            raise StorageError(f"Listing {target} failed: {exc}") from exc

    def _read_bytes(self, path: str) -> bytes:
        target = self._abs(path)

        def _read(sftp):
            buffer = io.BytesIO()
            sftp.getfo(target, buffer)
            return buffer.getvalue()

        try:
            return self._retry(_read)
        except FileNotFoundError:
            raise
        except OSError as exc:
            if getattr(exc, "errno", None) == 2:
                raise FileNotFoundError(target) from exc
            raise StorageError(f"Reading {target} failed: {exc}") from exc

    def _write_bytes(self, path: str, data: bytes) -> None:
        target = self._abs(path)
        try:
            self._retry(lambda sftp: sftp.putfo(io.BytesIO(data), target, file_size=len(data), confirm=False))
        except OSError as exc:
            raise StorageError(f"Writing {target} failed: {exc}") from exc

    def _make_dir(self, path: str) -> None:
        self._retry(lambda sftp: sftp.mkdir(self._abs(path)))

    def _remove_file(self, path: str) -> None:
        target = self._abs(path)
        try:
            self._retry(lambda sftp: sftp.remove(target))
        except FileNotFoundError:
            return
        except OSError as exc:
            raise StorageError(f"Deleting {target} failed: {exc}") from exc

    def _remove_dir(self, path: str) -> None:
        target = self._abs(path)
        try:
            self._retry(lambda sftp: sftp.rmdir(target))
        except OSError as exc:
            raise StorageError(f"Removing folder {target} failed: {exc}") from exc

    def _rename(self, source: str, target: str) -> None:
        source_abs, target_abs = self._abs(source), self._abs(target)

        def _rename(sftp):
            try:
                sftp.posix_rename(source_abs, target_abs)
            except OSError:
                sftp.rename(source_abs, target_abs)

        self._retry(_rename)
