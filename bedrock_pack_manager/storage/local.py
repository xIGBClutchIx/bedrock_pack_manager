"""Local filesystem storage, used for the classic `run/` layout and local server folders."""

import os
import shutil
from pathlib import Path

from .base import Entry, Storage, join


class LocalStorage(Storage):
    cache_listings = False

    def __init__(self, root: Path) -> None:
        super().__init__()
        self.root = Path(root)
        self.label = str(self.root)

    def resolve(self, path: str) -> Path:
        path = join(path)
        if not path:
            return self.root
        return self.root / Path(path)

    def describe(self, path: str) -> str:
        resolved = self.resolve(path)
        try:
            return str(resolved.relative_to(Path.cwd()))
        except ValueError:
            return str(resolved)

    def _list_dir(self, path: str) -> list[Entry]:
        target = self.resolve(path)
        if not target.exists():
            raise FileNotFoundError(str(target))
        if not target.is_dir():
            raise NotADirectoryError(str(target))
        entries = []
        for child in target.iterdir():
            is_dir = child.is_dir()
            size = None if is_dir else child.stat().st_size
            entries.append(Entry(name=child.name, is_dir=is_dir, size=size))
        return entries

    def _read_bytes(self, path: str) -> bytes:
        target = self.resolve(path)
        if not target.is_file():
            raise FileNotFoundError(str(target))
        return target.read_bytes()

    def _write_bytes(self, path: str, data: bytes) -> None:
        self.resolve(path).write_bytes(data)

    def _make_dir(self, path: str) -> None:
        self.resolve(path).mkdir(parents=True, exist_ok=True)

    def _remove_file(self, path: str) -> None:
        self.resolve(path).unlink()

    def _remove_dir(self, path: str) -> None:
        self.resolve(path).rmdir()

    def _rename(self, source: str, target: str) -> None:
        os.replace(self.resolve(source), self.resolve(target))

    # Local fast paths for the bulk operations.

    def remove_tree(self, path: str) -> None:
        target = self.resolve(path)
        if target == self.root:
            super().remove_tree(path)
            return
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()

    def copy_file(self, source: str, target: str) -> None:
        destination = self.resolve(target)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(self.resolve(source), destination)
