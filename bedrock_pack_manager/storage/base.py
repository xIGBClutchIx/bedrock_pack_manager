"""Transport-neutral file access used by every command.

Paths handed to a storage are POSIX-style strings. Relative paths resolve against the
storage root (the server folder the user pointed at); absolute paths are used as-is.
"""

import posixpath
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator

JUNK_NAMES = {"__MACOSX", ".DS_Store", "Thumbs.db", "desktop.ini"}


class StorageError(Exception):
    """A transport-level failure that is not simply a missing file."""


@dataclass(frozen=True)
class Entry:
    name: str
    is_dir: bool
    size: int | None = None


def _fix_drive(path: str) -> str:
    # Keep Windows drive roots absolute: "C:" means "current folder on C", "C:/" is the root.
    if len(path) == 2 and path[1] == ":" and path[0].isalpha():
        return path + "/"
    return path


def join(*parts: str) -> str:
    cleaned = [str(part).replace("\\", "/") for part in parts if part not in ("", ".")]
    if not cleaned:
        return ""
    for index in range(len(cleaned) - 1, 0, -1):
        # A Windows absolute part (C:/...) replaces everything before it, like posix absolute parts.
        if len(cleaned[index]) > 1 and cleaned[index][1] == ":":
            cleaned = cleaned[index:]
            break
    return _fix_drive(posixpath.normpath(posixpath.join(*cleaned)))


def parent(path: str) -> str:
    head = posixpath.dirname(path.replace("\\", "/").rstrip("/"))
    return _fix_drive(head)


def basename(path: str) -> str:
    return posixpath.basename(path.rstrip("/"))


class Storage(ABC):
    """Minimal file API implemented by the local, FTP, and SFTP backends."""

    #: short human label such as ``sftp://user@host:22/srv/bedrock``
    label: str = ""
    #: whether directory listings can be cached for the lifetime of an operation
    cache_listings: bool = False

    def __init__(self) -> None:
        self._listing_cache: dict[str, list[Entry]] = {}

    # ---- primitives each backend implements -------------------------------------------------

    @abstractmethod
    def _list_dir(self, path: str) -> list[Entry]:
        """List a directory or raise FileNotFoundError / NotADirectoryError."""

    @abstractmethod
    def _read_bytes(self, path: str) -> bytes:
        """Read a whole file or raise FileNotFoundError."""

    @abstractmethod
    def _write_bytes(self, path: str, data: bytes) -> None:
        """Write a whole file, replacing it. The parent directory exists."""

    @abstractmethod
    def _make_dir(self, path: str) -> None:
        """Create one directory level. May raise if it already exists."""

    @abstractmethod
    def _remove_file(self, path: str) -> None: ...

    @abstractmethod
    def _remove_dir(self, path: str) -> None:
        """Remove an empty directory."""

    @abstractmethod
    def _rename(self, source: str, target: str) -> None:
        """Rename a file or directory. May fail when the target exists."""

    def close(self) -> None:
        """Release the connection, if any."""

    def describe(self, path: str) -> str:
        """Human-readable location used in console output."""

        return path or "."

    # ---- cache helpers --------------------------------------------------------------------------

    def clear_cache(self) -> None:
        self._listing_cache.clear()

    def _invalidate(self, path: str) -> None:
        if not self.cache_listings:
            return
        self._listing_cache.pop(path, None)
        self._listing_cache.pop(parent(path), None)
        prefix = f"{path}/"
        for key in [key for key in self._listing_cache if key.startswith(prefix)]:
            self._listing_cache.pop(key, None)

    # ---- public API -------------------------------------------------------------------------------

    def list_dir(self, path: str = "") -> list[Entry]:
        path = join(path)
        if self.cache_listings and path in self._listing_cache:
            return list(self._listing_cache[path])
        entries = [entry for entry in self._list_dir(path) if entry.name not in (".", "..")]
        entries.sort(key=lambda entry: entry.name.lower())
        if self.cache_listings:
            self._listing_cache[path] = entries
        return list(entries)

    def stat(self, path: str) -> Entry | None:
        """Find an entry by listing its parent, which every server supports."""

        path = join(path)
        if path in ("", "/"):
            return Entry(name=path, is_dir=True)
        name = basename(path)
        try:
            entries = self.list_dir(parent(path))
        except (FileNotFoundError, NotADirectoryError):
            return None
        for entry in entries:
            if entry.name == name:
                return entry
        return None

    def find_child(self, path: str, name: str, *, want_dir: bool | None = None) -> str | None:
        """Return ``path/<name>`` matching case-insensitively, for servers with odd casing."""

        try:
            entries = self.list_dir(path)
        except (FileNotFoundError, NotADirectoryError):
            return None
        exact = [entry for entry in entries if entry.name == name]
        loose = [entry for entry in entries if entry.name.lower() == name.lower()]
        for entry in exact + loose:
            if want_dir is None or entry.is_dir == want_dir:
                return join(path, entry.name)
        return None

    def exists(self, path: str) -> bool:
        return self.stat(path) is not None

    def is_dir(self, path: str) -> bool:
        entry = self.stat(path)
        return bool(entry and entry.is_dir)

    def is_file(self, path: str) -> bool:
        entry = self.stat(path)
        return bool(entry and not entry.is_dir)

    def read_bytes(self, path: str) -> bytes:
        return self._read_bytes(join(path))

    def read_text(self, path: str) -> str:
        return self.read_bytes(path).decode("utf-8-sig")

    def write_bytes(self, path: str, data: bytes, *, atomic: bool = True) -> None:
        """Write a file, going through a temp name and rename when the server allows it."""

        path = join(path)
        self.mkdirs(parent(path))
        if not atomic:
            self._write_bytes(path, data)
            self._invalidate(path)
            return

        temp_path = f"{path}.bpm-tmp"
        try:
            self._write_bytes(temp_path, data)
        except Exception:
            self._invalidate(temp_path)
            self._write_bytes(path, data)
            self._invalidate(path)
            return
        self._invalidate(temp_path)

        try:
            self._rename(temp_path, path)
        except Exception:
            # Many FTP servers refuse to rename over an existing file.
            try:
                if self.is_file(path):
                    self._remove_file(path)
                    self._invalidate(path)
                self._rename(temp_path, path)
            except Exception:
                self._write_bytes(path, data)
                try:
                    self._remove_file(temp_path)
                except Exception:
                    pass
        self._invalidate(path)

    def write_text(self, path: str, text: str) -> None:
        self.write_bytes(path, text.encode("utf-8"))

    def mkdirs(self, path: str) -> None:
        path = join(path)
        if path in ("", "/", "."):
            return
        if self.is_dir(path):
            return
        parent_path = parent(path)
        if parent_path and parent_path != path:
            self.mkdirs(parent_path)
        try:
            self._make_dir(path)
        except Exception:
            self._invalidate(path)
            if not self.is_dir(path):
                raise
        self._invalidate(path)

    def remove_file(self, path: str) -> None:
        path = join(path)
        self._remove_file(path)
        self._invalidate(path)

    def rename(self, source: str, target: str) -> None:
        source, target = join(source), join(target)
        self._rename(source, target)
        self._invalidate(source)
        self._invalidate(target)

    def copy_file(self, source: str, target: str) -> None:
        self.write_bytes(target, self.read_bytes(source))

    def walk(self, path: str) -> Iterator[tuple[str, list[str], list[Entry]]]:
        """Yield ``(dir, subdir_names, file_entries)`` top-down like ``os.walk``."""

        path = join(path)
        entries = self.list_dir(path)
        dirs = [entry.name for entry in entries if entry.is_dir]
        files = [entry for entry in entries if not entry.is_dir]
        yield path, dirs, files
        for name in dirs:
            yield from self.walk(join(path, name))

    def remove_tree(self, path: str) -> None:
        path = join(path)
        if path in ("", "/", "."):
            raise StorageError("Refusing to delete the storage root")
        entry = self.stat(path)
        if entry is None:
            return
        if not entry.is_dir:
            self.remove_file(path)
            return
        for child in self.list_dir(path):
            child_path = join(path, child.name)
            if child.is_dir:
                self.remove_tree(child_path)
            else:
                self._remove_file(child_path)
        self._invalidate(path)
        self._remove_dir(path)
        self._invalidate(path)

    def upload_tree(
        self,
        local_dir: Path,
        remote_dir: str,
        *,
        exclude: set[Path] | None = None,
        progress: Callable[[str], None] | None = None,
    ) -> int:
        """Upload a local folder. ``manifest.json`` files are written last so a broken
        transfer never leaves a folder that looks like a complete pack."""

        exclude = {path.resolve() for path in (exclude or set())}
        remote_dir = join(remote_dir)
        self.mkdirs(remote_dir)
        file_count = 0
        deferred: list[tuple[Path, str]] = []

        def _upload_dir(local: Path, remote: str) -> None:
            nonlocal file_count
            for child in sorted(local.iterdir(), key=lambda item: item.name.lower()):
                if child.name in JUNK_NAMES or child.resolve() in exclude:
                    continue
                child_remote = join(remote, child.name)
                if child.is_dir():
                    self.mkdirs(child_remote)
                    _upload_dir(child, child_remote)
                    continue
                if child.name.lower() == "manifest.json":
                    deferred.append((child, child_remote))
                    continue
                self.write_bytes(child_remote, child.read_bytes(), atomic=False)
                file_count += 1
                if progress:
                    progress(child_remote)

        _upload_dir(local_dir, remote_dir)
        for local_file, remote_file in sorted(deferred, key=lambda pair: -len(pair[1])):
            self.write_bytes(remote_file, local_file.read_bytes(), atomic=False)
            file_count += 1
            if progress:
                progress(remote_file)
        return file_count

    def download_files(self, path: str) -> Iterator[tuple[str, bytes]]:
        """Yield ``(relative_path, data)`` for every file under ``path``."""

        root = join(path)
        for dir_path, _dirs, files in self.walk(root):
            for file_entry in files:
                file_path = join(dir_path, file_entry.name)
                relative = posixpath.relpath(file_path, root) if root else file_path
                yield relative, self.read_bytes(file_path)

    def __enter__(self) -> "Storage":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()
