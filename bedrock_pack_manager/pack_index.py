"""One scan of every pack folder on the server, reused for a whole operation.

Remote round trips are slow, so commands build a ``PackIndex`` once and update it in
memory as they upload or delete folders instead of re-reading manifests.
"""

from dataclasses import dataclass, field

from .layout import PackDir, PackKind, PackScope, Target
from .manifests import ManifestError, classify_pack, format_version, get_pack_dependencies, get_pack_info, parse_manifest
from .storage import JUNK_NAMES, basename, join


def uuid_key(uuid: str) -> str:
    return str(uuid or "").strip().lower()


@dataclass
class InstalledPack:
    uuid: str
    version: list
    name: str
    kind: PackKind | None
    dir_kind: PackKind
    scope: PackScope
    path: str
    pack_dir: str
    dependencies: list[dict] = field(default_factory=list)
    nested: bool = False

    @property
    def key(self) -> tuple[str, tuple]:
        return uuid_key(self.uuid), tuple(self.version)

    @property
    def folder(self) -> str:
        return basename(self.path)

    @property
    def version_label(self) -> str:
        return format_version(self.version)

    def as_dict(self) -> dict:
        return {
            "uuid": self.uuid,
            "version": self.version,
            "version_label": self.version_label,
            "name": self.name,
            "kind": self.kind,
            "dir_kind": self.dir_kind,
            "scope": self.scope,
            "path": self.path,
            "folder": self.folder,
            "nested": self.nested,
            "dependencies": self.dependencies,
        }


@dataclass
class PackIndex:
    packs: list[InstalledPack] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)
    scanned_dirs: list[PackDir] = field(default_factory=list)

    @classmethod
    def build(cls, target: Target, world: str | None = None, *, pack_dirs: list[PackDir] | None = None) -> "PackIndex":
        index = cls()
        for pack_dir in pack_dirs if pack_dirs is not None else target.pack_dirs(world):
            index._scan_dir(target, pack_dir)
        index._flag_duplicates()
        return index

    def _scan_dir(self, target: Target, pack_dir: PackDir) -> None:
        storage = target.storage
        try:
            entries = storage.list_dir(pack_dir.path)
        except (FileNotFoundError, NotADirectoryError):
            return
        self.scanned_dirs.append(pack_dir)
        for entry in entries:
            if not entry.is_dir or entry.name in JUNK_NAMES or entry.name.startswith("."):
                continue
            folder = join(pack_dir.path, entry.name)
            pack, missing = self._read_pack(target, pack_dir, folder)
            if pack is not None:
                self.packs.append(pack)
                continue
            if not missing:
                continue
            # No manifest at the top: a common mistake is an extra wrapper folder.
            try:
                children = storage.list_dir(folder)
            except (FileNotFoundError, NotADirectoryError):
                continue
            if any(not child.is_dir and child.name.lower() == "manifest.json" for child in children):
                # Odd casing such as Manifest.json.
                pack, _missing = self._read_pack(target, pack_dir, folder, quiet_missing=True)
                if pack is not None:
                    self.packs.append(pack)
                continue
            nested_found = False
            for child in children:
                if not child.is_dir or child.name in JUNK_NAMES:
                    continue
                nested, _missing = self._read_pack(target, pack_dir, join(folder, child.name), quiet_missing=True)
                if nested is not None:
                    nested.nested = True
                    nested_found = True
                    self.packs.append(nested)
                    self.problems.append(
                        f"{target.describe(nested.path)} is nested one folder too deep - the server will not load it. Move it up into {target.describe(pack_dir.path)}"
                    )
            if not nested_found:
                self.problems.append(f"{target.describe(folder)} has no manifest.json - not a valid pack (partial upload or leftover folder?)")

    def _read_pack(self, target: Target, pack_dir: PackDir, folder: str, *, quiet_missing: bool = False) -> tuple[InstalledPack | None, bool]:
        """Return ``(pack, manifest_missing)``. Reading the manifest directly avoids a listing round trip."""

        manifest_path = target.storage.find_child(folder, "manifest.json", want_dir=False) if quiet_missing else join(folder, "manifest.json")
        if manifest_path is None:
            return None, True
        try:
            manifest = parse_manifest(target.storage.read_bytes(manifest_path))
        except FileNotFoundError:
            return None, True
        except ManifestError as exc:
            self.problems.append(f"{target.describe(manifest_path)} is not valid JSON ({exc})")
            return None, False

        uuid, version, name = get_pack_info(manifest)
        if not uuid:
            self.problems.append(f"{target.describe(folder)} has no UUID in its manifest - skipping it")
            return None, False
        kind = classify_pack(manifest)
        if kind is not None and kind != pack_dir.kind:
            expected = "behavior_packs" if kind == "bp" else "resource_packs"
            kind_name = "behavior" if kind == "bp" else "resource"
            self.problems.append(f"{target.describe(folder)} is a {kind_name} pack but sits in {target.describe(pack_dir.path)} - move it to {expected}")
        return (
            InstalledPack(
                uuid=uuid,
                version=version,
                name=name,
                kind=kind,
                dir_kind=pack_dir.kind,
                scope=pack_dir.scope,
                path=folder,
                pack_dir=pack_dir.path,
                dependencies=get_pack_dependencies(manifest),
            ),
            False,
        )

    def _flag_duplicates(self) -> None:
        by_key: dict[tuple, list[InstalledPack]] = {}
        for pack in self.packs:
            by_key.setdefault(pack.key, []).append(pack)
        for copies in by_key.values():
            if len(copies) > 1:
                where = ", ".join(pack.folder for pack in copies)
                self.problems.append(f"'{copies[0].name}' v{copies[0].version_label} is installed {len(copies)} times ({where})")

    # ---- queries ------------------------------------------------------------------------------

    def find(self, uuid: str, kind: PackKind | None = None) -> list[InstalledPack]:
        wanted = uuid_key(uuid)
        matches = [pack for pack in self.packs if uuid_key(pack.uuid) == wanted and (kind is None or pack.dir_kind == kind)]
        return sorted(matches, key=lambda pack: pack.folder.lower())

    def find_version(self, uuid: str, version: list, kind: PackKind | None = None) -> list[InstalledPack]:
        return [pack for pack in self.find(uuid, kind) if pack.version == version]

    def of_kind(self, kind: PackKind) -> list[InstalledPack]:
        return [pack for pack in self.packs if pack.dir_kind == kind]

    def uuids(self) -> set[str]:
        return {uuid_key(pack.uuid) for pack in self.packs}

    def folder_names(self, pack_dir: str) -> set[str]:
        return {pack.folder.lower() for pack in self.packs if pack.pack_dir == pack_dir}

    # ---- updates ------------------------------------------------------------------------------

    def add(self, pack: InstalledPack) -> None:
        self.packs.append(pack)

    def remove(self, path: str) -> None:
        self.packs = [pack for pack in self.packs if pack.path != path]
