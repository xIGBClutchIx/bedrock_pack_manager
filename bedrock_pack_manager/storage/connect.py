"""Connection settings shared by the CLI and web UI, and the storage factory."""

from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .base import Storage, StorageError

PROTOCOLS = ("local", "ftp", "ftps", "sftp")
DEFAULT_PORTS = {"ftp": 21, "ftps": 21, "sftp": 22}


@dataclass
class ConnectionSettings:
    """Everything needed to open a storage. Secrets are never persisted."""

    protocol: str = "local"
    host: str = ""
    port: int | None = None
    username: str = ""
    root: str = ""
    password: str = field(default="", repr=False)
    key_file: str = ""
    key_passphrase: str = field(default="", repr=False)
    tls_verify: bool = True
    passive: bool = True
    trusted_fingerprint: str = ""

    def effective_port(self) -> int:
        return self.port or DEFAULT_PORTS.get(self.protocol, 0)

    def public_dict(self) -> dict:
        """Settings safe to show or save: no password or key passphrase."""

        data = asdict(self)
        data.pop("password", None)
        data.pop("key_passphrase", None)
        data.pop("trusted_fingerprint", None)
        return data

    def display(self) -> str:
        if self.protocol == "local":
            return self.root or "."
        user = f"{self.username}@" if self.username else ""
        root = self.root if self.root.startswith("/") else f"/{self.root}" if self.root else "/"
        return f"{self.protocol}://{user}{self.host}:{self.effective_port()}{root}"


def parse_remote_url(url: str) -> ConnectionSettings:
    """Parse ``sftp://user@host:2022/path`` style URLs. Anything without a scheme is a local path."""

    url = url.strip()
    if "://" not in url:
        return ConnectionSettings(protocol="local", root=url)

    parts = urlsplit(url)
    protocol = parts.scheme.lower()
    if protocol not in PROTOCOLS or protocol == "local":
        raise ValueError(f"Unsupported protocol '{parts.scheme}'. Use ftp://, ftps://, or sftp://")
    if not parts.hostname:
        raise ValueError(f"Missing host in '{url}'")

    path = unquote(parts.path or "")
    # `sftp://host/srv/bedrock` is absolute; `sftp://host/~/bedrock` is relative to the login folder.
    if path.startswith("/~/"):
        path = path[3:]
    elif path in ("/~", "/"):
        path = "" if path == "/~" else "/"

    return ConnectionSettings(
        protocol=protocol,
        host=parts.hostname,
        port=parts.port,
        username=unquote(parts.username or ""),
        password=unquote(parts.password or ""),
        root=path,
    )


def redact_url(url: str) -> str:
    if "://" not in url:
        return url
    parts = urlsplit(url)
    if parts.password is None:
        return url
    netloc = parts.netloc.replace(f":{parts.password}@", ":***@")
    return parts._replace(netloc=netloc).geturl()


def open_storage(settings: ConnectionSettings, *, base_dir: Path | None = None, known_hosts_file: Path | None = None) -> Storage:
    protocol = settings.protocol.lower()
    if protocol == "local":
        from .local import LocalStorage

        root = Path(settings.root).expanduser() if settings.root else (base_dir or Path.cwd())
        if not root.is_absolute() and base_dir is not None:
            root = (base_dir / root).resolve()
        if not root.exists():
            raise StorageError(f"Local folder does not exist: {root}")
        return LocalStorage(root)

    if not settings.host:
        raise StorageError("A host is required for remote connections")

    if protocol in ("ftp", "ftps"):
        from .ftp import FTPStorage

        return FTPStorage(
            settings.host,
            port=settings.effective_port(),
            username=settings.username,
            password=settings.password,
            root=settings.root,
            tls=protocol == "ftps",
            tls_verify=settings.tls_verify,
            passive=settings.passive,
        )

    if protocol == "sftp":
        from .sftp import SFTPStorage

        return SFTPStorage(
            settings.host,
            port=settings.effective_port(),
            username=settings.username,
            password=settings.password or None,
            key_file=settings.key_file or None,
            key_passphrase=settings.key_passphrase or None,
            root=settings.root,
            known_hosts_file=known_hosts_file,
            trusted_fingerprint=settings.trusted_fingerprint or None,
        )

    raise StorageError(f"Unsupported protocol '{settings.protocol}'")
