"""Where worlds and packs live on a server, detected leniently because real servers vary.

Recognised shapes, all relative to the folder the user pointed at:

- a Bedrock Dedicated Server root (``worlds/``, ``behavior_packs/``, ``resource_packs/``, ``server.properties``)
- the same root nested one or two folders down (common on hosting panels)
- the ``worlds/`` folder itself, with pack folders beside it
- a single world folder (has ``level.dat``), using world-local pack folders
- the classic local ``run/`` layout this tool has always used
"""

from dataclasses import dataclass, field
from typing import Literal

from .storage import JUNK_NAMES, Storage, basename, join

PackKind = Literal["bp", "rp"]
PackScope = Literal["shared", "world", "dev"]

WORLD_JSON_NAMES = {"bp": "world_behavior_packs.json", "rp": "world_resource_packs.json"}
PACK_DIR_NAMES = {"bp": "behavior_packs", "rp": "resource_packs"}
DEV_PACK_DIR_NAMES = {"bp": "development_behavior_packs", "rp": "development_resource_packs"}
SERVER_MARKERS = {"server.properties", "bedrock_server", "bedrock_server.exe", "worlds", "allowlist.json", "permissions.json"}
WORLD_MARKERS = {"level.dat", "world_behavior_packs.json", "world_resource_packs.json", "levelname.txt"}


@dataclass(frozen=True)
class PackDir:
    path: str
    kind: PackKind
    scope: PackScope


@dataclass
class ServerLayout:
    server_root: str = ""
    worlds_dir: str | None = "worlds"
    single_world: str | None = None
    bp_dir: str | None = "behavior_packs"
    rp_dir: str | None = "resource_packs"
    dev_bp_dir: str | None = None
    dev_rp_dir: str | None = None
    level_name: str | None = None
    notes: list[str] = field(default_factory=list)

    def shared_dir(self, kind: PackKind) -> str | None:
        return self.bp_dir if kind == "bp" else self.rp_dir

    def dev_dir(self, kind: PackKind) -> str | None:
        return self.dev_bp_dir if kind == "bp" else self.dev_rp_dir

    def as_dict(self) -> dict:
        return {
            "server_root": self.server_root,
            "worlds_dir": self.worlds_dir,
            "single_world": self.single_world,
            "bp_dir": self.bp_dir,
            "rp_dir": self.rp_dir,
            "dev_bp_dir": self.dev_bp_dir,
            "dev_rp_dir": self.dev_rp_dir,
            "level_name": self.level_name,
            "notes": list(self.notes),
        }


@dataclass
class Target:
    """A storage plus its layout: the thing every command operates on."""

    storage: Storage
    layout: ServerLayout
    pack_scope: PackScope = "shared"

    @property
    def label(self) -> str:
        return self.storage.label

    def layout_display(self) -> dict:
        """The layout with every folder shown as a full server path, for people to read."""

        data = self.layout.as_dict()
        for key in ("server_root", "worlds_dir", "single_world", "bp_dir", "rp_dir", "dev_bp_dir", "dev_rp_dir"):
            if data[key] is not None:
                data[key] = self.describe(data[key])
        data["pack_scope"] = self.pack_scope
        return data

    def describe(self, path: str) -> str:
        return self.storage.describe(path)

    def world_json(self, world: str, kind: PackKind) -> str:
        return join(world, WORLD_JSON_NAMES[kind])

    def level_dat(self, world: str) -> str:
        return join(world, "level.dat")

    def world_pack_dir(self, world: str, kind: PackKind) -> str:
        found = self.storage.find_child(world, PACK_DIR_NAMES[kind], want_dir=True)
        return found or join(world, PACK_DIR_NAMES[kind])

    def install_dir(self, world: str, kind: PackKind) -> str:
        """Folder new packs are uploaded to, honouring ``pack_scope`` and the layout."""

        shared = self.layout.shared_dir(kind)
        if self.pack_scope == "world" or shared is None:
            return self.world_pack_dir(world, kind)
        return shared

    def pack_dirs(self, world: str | None = None) -> list[PackDir]:
        """Every folder that may hold packs relevant to ``world`` (or all shared folders)."""

        dirs: list[PackDir] = []
        for kind in ("bp", "rp"):
            shared = self.layout.shared_dir(kind)
            if shared is not None:
                dirs.append(PackDir(shared, kind, "shared"))
            dev = self.layout.dev_dir(kind)
            if dev is not None:
                dirs.append(PackDir(dev, kind, "dev"))
            if world is not None:
                world_dir = self.storage.find_child(world, PACK_DIR_NAMES[kind], want_dir=True)
                if world_dir is not None:
                    dirs.append(PackDir(world_dir, kind, "world"))
        return dirs

    def list_worlds(self) -> list[str]:
        if self.layout.single_world is not None:
            return [self.layout.single_world]
        if self.layout.worlds_dir is None:
            return []
        try:
            entries = self.storage.list_dir(self.layout.worlds_dir)
        except (FileNotFoundError, NotADirectoryError):
            return []
        return [
            join(self.layout.worlds_dir, entry.name)
            for entry in entries
            if entry.is_dir and not entry.name.startswith(".") and entry.name not in JUNK_NAMES
        ]

    def find_world(self, name: str) -> str | None:
        for world in self.list_worlds():
            if basename(world) == name:
                return world
        for world in self.list_worlds():
            if basename(world).lower() == name.lower():
                return world
        return None

    def default_world(self) -> str | None:
        worlds = self.list_worlds()
        if len(worlds) == 1:
            return worlds[0]
        if self.layout.level_name:
            return self.find_world(self.layout.level_name)
        return None


def _names(storage: Storage, path: str) -> dict[str, tuple[str, bool]]:
    """Lower-cased child names mapped to (real name, is_dir)."""

    try:
        return {entry.name.lower(): (entry.name, entry.is_dir) for entry in storage.list_dir(path)}
    except (FileNotFoundError, NotADirectoryError):
        return {}


def _child_dir(names: dict[str, tuple[str, bool]], base: str, name: str) -> str | None:
    found = names.get(name.lower())
    if found and found[1]:
        return join(base, found[0])
    return None


def _looks_like_server(names: dict[str, tuple[str, bool]]) -> bool:
    return bool(SERVER_MARKERS & set(names)) or bool({"behavior_packs", "resource_packs"} & set(names))


def _looks_like_world(names: dict[str, tuple[str, bool]]) -> bool:
    return bool(WORLD_MARKERS & set(names)) or ("db" in names and names["db"][1])


def parse_server_properties(text: str) -> dict[str, str]:
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def _child_dirs(names: dict[str, tuple[str, bool]], base: str) -> list[str]:
    reals = [real for real, is_dir in names.values() if is_dir and real not in JUNK_NAMES and not real.startswith(".")]
    return [join(base, real) for real in sorted(reals, key=str.lower)]


def _find_server_root(storage: Storage, start: str, notes: list[str], depth: int = 2) -> tuple[str, dict]:
    """Breadth-first search a couple of levels down for something that looks like a server."""

    names = _names(storage, start)
    if _looks_like_server(names) or _looks_like_world(names):
        return start, names

    frontier = _child_dirs(names, start)[:40]
    for _level in range(depth):
        next_frontier: list[str] = []
        for candidate in frontier:
            candidate_names = _names(storage, candidate)
            if _looks_like_server(candidate_names):
                notes.append(f"Found the server inside '{candidate}'")
                return candidate, candidate_names
            next_frontier.extend(_child_dirs(candidate_names, candidate))
        frontier = next_frontier[:30]
    return start, names


@dataclass
class LayoutOverrides:
    server_root: str | None = None
    worlds_dir: str | None = None
    bp_dir: str | None = None
    rp_dir: str | None = None
    pack_scope: PackScope = "shared"

    @classmethod
    def from_dict(cls, data: dict | None) -> "LayoutOverrides":
        data = data or {}

        def _clean(key: str) -> str | None:
            value = data.get(key)
            if value is None:
                return None
            value = str(value).strip()
            return value or None

        scope = data.get("pack_scope") or "shared"
        return cls(
            server_root=_clean("server_root"),
            worlds_dir=_clean("worlds_dir"),
            bp_dir=_clean("bp_dir"),
            rp_dir=_clean("rp_dir"),
            pack_scope="world" if scope == "world" else "shared",
        )


def connect_target(storage: Storage, overrides: LayoutOverrides | None = None) -> Target:
    overrides = overrides or LayoutOverrides()
    layout = detect_layout(
        storage,
        server_root=overrides.server_root,
        worlds_dir=overrides.worlds_dir,
        bp_dir=overrides.bp_dir,
        rp_dir=overrides.rp_dir,
    )
    return Target(storage=storage, layout=layout, pack_scope=overrides.pack_scope)


def detect_layout(
    storage: Storage,
    *,
    server_root: str | None = None,
    worlds_dir: str | None = None,
    bp_dir: str | None = None,
    rp_dir: str | None = None,
) -> ServerLayout:
    """Work out the layout, applying any explicit overrides on top of detection."""

    notes: list[str] = []
    if server_root is None:
        root, names = _find_server_root(storage, "", notes)
    else:
        root, names = join(server_root), _names(storage, server_root)

    layout = ServerLayout(server_root=root, notes=notes)

    properties = names.get("server.properties")
    if properties and not properties[1]:
        try:
            values = parse_server_properties(storage.read_text(join(root, properties[0])))
            layout.level_name = values.get("level-name") or None
        except (FileNotFoundError, UnicodeDecodeError):
            pass

    found_worlds = _child_dir(names, root, "worlds")
    if worlds_dir is not None:
        layout.worlds_dir = join(worlds_dir)
    elif found_worlds:
        layout.worlds_dir = found_worlds
    elif _looks_like_world(names):
        # Pointed straight at a world folder.
        layout.worlds_dir = None
        layout.single_world = root
        notes.append("The selected folder is a single world; packs go into its own behavior_packs/resource_packs folders")
    elif any(_looks_like_world(_names(storage, join(root, real))) for real, is_dir in list(names.values())[:40] if is_dir):
        # Pointed at the worlds folder itself.
        layout.worlds_dir = root
        notes.append("The selected folder looks like a worlds folder")
    else:
        layout.worlds_dir = join(root, "worlds")
        notes.append("No worlds folder found yet")

    if layout.single_world is None and layout.worlds_dir == root:
        sibling_root = join(root, "..")
        sibling_names = _names(storage, sibling_root)
        default_bp = _child_dir(sibling_names, sibling_root, "behavior_packs")
        default_rp = _child_dir(sibling_names, sibling_root, "resource_packs")
        dev_bp = _child_dir(sibling_names, sibling_root, "development_behavior_packs")
        dev_rp = _child_dir(sibling_names, sibling_root, "development_resource_packs")
    elif layout.single_world is not None:
        default_bp = default_rp = dev_bp = dev_rp = None
    else:
        default_bp = _child_dir(names, root, "behavior_packs") or join(root, "behavior_packs")
        default_rp = _child_dir(names, root, "resource_packs") or join(root, "resource_packs")
        dev_bp = _child_dir(names, root, "development_behavior_packs")
        dev_rp = _child_dir(names, root, "development_resource_packs")

    layout.bp_dir = join(bp_dir) if bp_dir is not None else default_bp
    layout.rp_dir = join(rp_dir) if rp_dir is not None else default_rp
    layout.dev_bp_dir = dev_bp
    layout.dev_rp_dir = dev_rp
    return layout
