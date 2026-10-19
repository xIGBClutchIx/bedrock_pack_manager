"""FTP and explicit FTPS storage built on the standard library."""

import ftplib
import io
import re
import socket
import ssl
import time
from typing import Callable, TypeVar

from .base import Entry, Storage, StorageError, basename, join, parent

T = TypeVar("T")

_UNIX_LIST_RE = re.compile(
    r"^(?P<mode>[\-dlbcps][\-rwxsStT]{9})[+@.]?\s+\d+\s+\S+\s+\S+\s+(?P<size>\d+)\s+"
    r"\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4})\s(?P<name>.+)$"
)
_DOS_LIST_RE = re.compile(r"^\d{2}-\d{2}-\d{2,4}\s+\d{1,2}:\d{2}(?:[AaPp][Mm])?\s+(?P<size><DIR>|\d+)\s+(?P<name>.+)$")
_RETRYABLE = (EOFError, ConnectionError, socket.timeout, TimeoutError, ftplib.error_temp, ssl.SSLError, BrokenPipeError)


def parse_list_line(line: str) -> Entry | None:
    """Parse one line of a classic ``LIST`` reply in Unix or DOS format."""

    line = line.rstrip("\r\n")
    match = _UNIX_LIST_RE.match(line)
    if match:
        mode = match.group("mode")
        name = match.group("name")
        if mode.startswith("l") and " -> " in name:
            name = name.split(" -> ", 1)[0]
            # A symlink is usually a folder on game hosts; verify lazily when used.
            return Entry(name=name, is_dir=True)
        return Entry(name=name, is_dir=mode.startswith("d"), size=int(match.group("size")))
    match = _DOS_LIST_RE.match(line)
    if match:
        size = match.group("size")
        if size == "<DIR>":
            return Entry(name=match.group("name"), is_dir=True)
        return Entry(name=match.group("name"), is_dir=False, size=int(size))
    return None


def _is_missing(exc: Exception) -> bool:
    return isinstance(exc, ftplib.error_perm) and str(exc)[:3] in {"550", "553", "450", "451"}


class FTPStorage(Storage):
    cache_listings = True
    # Every FTP worker is a separate login; many hosts allow only a handful per user.
    max_workers = 4

    def __init__(
        self,
        host: str,
        *,
        port: int = 21,
        username: str = "anonymous",
        password: str = "",
        root: str = "/",
        tls: bool = False,
        tls_verify: bool = True,
        passive: bool = True,
        timeout: float = 30.0,
        ftp_factory: Callable[..., ftplib.FTP] | None = None,
    ) -> None:
        super().__init__()
        self.host = host
        self.port = port
        self.username = username or "anonymous"
        self._password = password
        self.tls = tls
        self.tls_verify = tls_verify
        self.passive = passive
        self.timeout = timeout
        self._ftp_factory = ftp_factory
        self._ftp: ftplib.FTP | None = None
        self._mlsd_supported = True
        scheme = "ftps" if tls else "ftp"
        self.root = root or "/"
        self.label = f"{scheme}://{self.username}@{host}:{port}{self.root if self.root.startswith('/') else '/' + self.root}"
        self._connect()

    # ---- connection ---------------------------------------------------------------------------

    def _connect(self) -> None:
        try:
            if self._ftp_factory is not None:
                ftp = self._ftp_factory()
            elif self.tls:
                context = ssl.create_default_context()
                if not self.tls_verify:
                    context.check_hostname = False
                    context.verify_mode = ssl.CERT_NONE
                ftp = ftplib.FTP_TLS(context=context, timeout=self.timeout)
            else:
                ftp = ftplib.FTP(timeout=self.timeout)
            ftp.encoding = "utf-8"
            ftp.connect(self.host, self.port)
            ftp.login(self.username, self._password)
            if isinstance(ftp, ftplib.FTP_TLS):
                ftp.prot_p()
            ftp.set_pasv(self.passive)
            try:
                ftp.sendcmd("OPTS UTF8 ON")
            except ftplib.all_errors:
                pass
            try:
                ftp.voidcmd("TYPE I")
            except ftplib.all_errors:
                pass
        except ftplib.error_perm as exc:
            raise StorageError(f"FTP login failed for {self.username}@{self.host}: {exc}") from exc
        except ssl.SSLCertVerificationError as exc:
            raise StorageError(f"FTPS certificate check failed for {self.host}: {exc}. Enable 'allow self-signed certificate' if you trust this server.") from exc
        except (OSError, EOFError, ftplib.Error) as exc:
            raise StorageError(f"Could not connect to {self.host}:{self.port} over FTP: {exc}") from exc

        if not self.root.startswith("/"):
            try:
                home = ftp.pwd()
            except ftplib.all_errors:
                home = "/"
            self.root = join(home, self.root) or "/"
        self._ftp = ftp

    def _spawn(self) -> "FTPStorage":
        """A second logged-in connection. Hosts often cap these, so callers tolerate failure."""

        return FTPStorage(
            self.host,
            port=self.port,
            username=self.username,
            password=self._password,
            root=self.root,
            tls=self.tls,
            tls_verify=self.tls_verify,
            passive=self.passive,
            timeout=self.timeout,
            ftp_factory=self._ftp_factory,
        )

    def close(self) -> None:
        super().close()
        if self._ftp is None:
            return
        try:
            self._ftp.quit()
        except ftplib.all_errors:
            try:
                self._ftp.close()
            except Exception:
                pass
        self._ftp = None

    def _call(self, func: Callable[[ftplib.FTP], T]) -> T:
        """Run an FTP call, reconnecting once if the server dropped the session."""

        if self._ftp is None:
            self._connect()
        try:
            return func(self._ftp)
        except _RETRYABLE:
            self.close()
            time.sleep(0.5)
            self._connect()
            return func(self._ftp)

    def _abs(self, path: str) -> str:
        path = join(path)
        if path.startswith("/"):
            return path
        return join(self.root, path) or "/"

    def describe(self, path: str) -> str:
        return self._abs(path)

    # ---- primitives -----------------------------------------------------------------------------

    def _list_dir(self, path: str) -> list[Entry]:
        target = self._abs(path)
        if self._mlsd_supported:
            try:
                return self._call(lambda ftp: self._mlsd(ftp, target))
            except ftplib.error_perm as exc:
                code = str(exc)[:3]
                if code in {"500", "501", "502", "504"}:
                    self._mlsd_supported = False
                elif _is_missing(exc):
                    raise FileNotFoundError(target) from exc
                else:
                    raise StorageError(f"Listing {target} failed: {exc}") from exc
        return self._call(lambda ftp: self._list_fallback(ftp, target))

    @staticmethod
    def _mlsd(ftp: ftplib.FTP, target: str) -> list[Entry]:
        entries = []
        for name, facts in ftp.mlsd(target, facts=["type", "size"]):
            kind = facts.get("type", "").lower()
            if kind in {"cdir", "pdir"} or name in (".", ".."):
                continue
            if kind == "file":
                entries.append(Entry(name=basename(name), is_dir=False, size=int(facts["size"]) if facts.get("size", "").isdigit() else None))
            elif kind == "dir" or kind.startswith("os.unix=symlink"):
                entries.append(Entry(name=basename(name), is_dir=True))
        return entries

    @staticmethod
    def _list_fallback(ftp: ftplib.FTP, target: str) -> list[Entry]:
        lines: list[str] = []
        try:
            ftp.cwd(target)
        except ftplib.error_perm as exc:
            if _is_missing(exc):
                raise FileNotFoundError(target) from exc
            raise
        try:
            ftp.retrlines("LIST -a", lines.append)
        except ftplib.error_perm:
            lines.clear()
            ftp.retrlines("LIST", lines.append)
        entries = []
        for line in lines:
            entry = parse_list_line(line)
            if entry is not None:
                entries.append(entry)
        return entries

    def _read_bytes(self, path: str) -> bytes:
        target = self._abs(path)
        buffer = io.BytesIO()

        def _retr(ftp: ftplib.FTP) -> bytes:
            buffer.seek(0)
            buffer.truncate()
            ftp.retrbinary(f"RETR {target}", buffer.write)
            return buffer.getvalue()

        try:
            return self._call(_retr)
        except ftplib.error_perm as exc:
            if _is_missing(exc):
                raise FileNotFoundError(target) from exc
            raise StorageError(f"Reading {target} failed: {exc}") from exc

    def _write_bytes(self, path: str, data: bytes) -> None:
        target = self._abs(path)
        try:
            self._call(lambda ftp: ftp.storbinary(f"STOR {target}", io.BytesIO(data)))
        except ftplib.error_perm as exc:
            raise StorageError(f"Writing {target} failed: {exc}") from exc

    def _make_dir(self, path: str) -> None:
        self._call(lambda ftp: ftp.mkd(self._abs(path)))

    def _remove_file(self, path: str) -> None:
        target = self._abs(path)
        try:
            self._call(lambda ftp: ftp.delete(target))
        except ftplib.error_perm as exc:
            if _is_missing(exc) and not self._exists_uncached(path):
                return
            raise StorageError(f"Deleting {target} failed: {exc}") from exc

    def _remove_dir(self, path: str) -> None:
        target = self._abs(path)
        try:
            self._call(lambda ftp: ftp.rmd(target))
        except ftplib.error_perm as exc:
            raise StorageError(f"Removing folder {target} failed: {exc}") from exc

    def _rename(self, source: str, target: str) -> None:
        self._call(lambda ftp: ftp.rename(self._abs(source), self._abs(target)))

    def _exists_uncached(self, path: str) -> bool:
        self._invalidate(path)
        try:
            return any(entry.name == basename(path) for entry in self._list_dir(parent(path)))
        except FileNotFoundError:
            return False
