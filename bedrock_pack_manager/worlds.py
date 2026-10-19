"""World pack JSON helpers and the terminal world picker."""

import json
import sys
from pathlib import Path

from .console import C, TerminalListMenu, app_header_lines, dim_text, title_text
from .layout import Target
from .manifests import strip_json_comments
from .pack_index import uuid_key
from .storage import Storage, basename, join
from .terminal import read_keypress


def load_world_json(storage: Storage, path: str) -> list:
    """Load a world pack registration file with helpful errors for bad JSON."""

    try:
        raw = storage.read_bytes(path)
    except FileNotFoundError:
        return []
    text = raw.decode("utf-8-sig", errors="replace").strip()
    if not text:
        return []
    try:
        data = json.loads(strip_json_comments(text))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Corrupt world pack JSON: {storage.describe(path)} (line {exc.lineno}, column {exc.colno}, char {exc.pos})") from exc
    if not isinstance(data, list):
        raise ValueError(f"World pack JSON is not a list: {storage.describe(path)}")
    return [entry for entry in data if isinstance(entry, dict)]


def save_world_json(storage: Storage, path: str, data: list) -> None:
    storage.write_text(path, json.dumps(data, indent=2) + "\n")


def upsert_entry(packs: list, uuid: str, version: list) -> str:
    """Add a pack to a world JSON list or update its version. Returns added/updated/unchanged."""

    for pack in packs:
        if uuid_key(pack.get("pack_id", "")) != uuid_key(uuid):
            continue
        if pack.get("version") == version:
            return "unchanged"
        pack["version"] = version
        return "updated"
    packs.append({"pack_id": uuid, "version": version})
    return "added"


def remove_entry(packs: list, uuid: str) -> bool:
    before = len(packs)
    packs[:] = [pack for pack in packs if uuid_key(pack.get("pack_id", "")) != uuid_key(uuid)]
    return len(packs) != before


def registered_keys(packs: list) -> set[tuple[str, tuple]]:
    return {
        (uuid_key(entry.get("pack_id", "")), tuple(entry.get("version", [])))
        for entry in packs
        if entry.get("pack_id") and isinstance(entry.get("version"), list)
    }


def resolve_world_path(target: Target, world_path: str) -> str:
    """Accept a path relative to the worlds folder, relative to the server root, or absolute."""

    candidates = []
    world_path = str(Path(world_path).expanduser()) if world_path.startswith("~") else world_path
    normalized = world_path.replace("\\", "/")
    if Path(world_path).is_absolute() or normalized.startswith("/"):
        candidates.append(world_path)
    else:
        if target.layout.worlds_dir is not None:
            candidates.append(join(target.layout.worlds_dir, normalized))
        candidates.append(join(target.layout.server_root, normalized))

    for candidate in candidates:
        entry = target.storage.stat(candidate)
        if entry is not None and entry.is_dir:
            return candidate
        if entry is not None:
            raise ValueError(f"World path is not a directory: {target.describe(candidate)}")
    raise ValueError(f"World path does not exist: {target.describe(candidates[0])}")


def is_interactive_terminal() -> bool:
    return bool(getattr(sys.stdin, "isatty", lambda: False)()) and bool(getattr(sys.stdout, "isatty", lambda: False)())


def _move_cursor(index: int, size: int, direction: str) -> int:
    if direction == "up":
        return (index - 1) % size
    if direction == "down":
        return (index + 1) % size
    return index


def world_details(target: Target, world: str, storage: Storage | None = None) -> str:
    """Build the small metadata suffix shown in the world picker."""

    storage = storage or target.storage
    extras = []
    try:
        names = {entry.name.lower() for entry in storage.list_dir(world)}
    except (FileNotFoundError, NotADirectoryError):
        names = set()
    if "level.dat" in names:
        extras.append("level.dat")
    for kind, label in (("bp", "BP"), ("rp", "RP")):
        json_name = target.world_json(world, kind)
        if basename(json_name).lower() in names:
            try:
                extras.append(f"{len(load_world_json(storage, json_name))} {label}")
            except ValueError:
                extras.append(f"bad {label} json")
    return f" {C.DIM}({', '.join(extras)}){C.RESET}" if extras else ""


def all_world_details(target: Target, worlds: list[str]) -> dict[str, str]:
    """``world_details`` for many worlds at once, over parallel connections."""

    results = target.storage.parallel(lambda storage, world: world_details(target, world, storage), worlds)
    return {world: "" if isinstance(result, BaseException) else result for world, result in zip(worlds, results)}


def _world_menu_lines(target: Target, worlds: list[str], details: dict[str, str], cursor: int) -> list[str]:
    lines = [
        f"  {dim_text(f'{len(worlds)} world(s) available')}",
        "",
    ]
    for index, world in enumerate(worlds):
        pointer = f"{C.CYAN}▸{C.RESET}" if index == cursor else " "
        name = f"{C.BOLD}{basename(world)}{C.RESET}" if index == cursor else basename(world)
        lines.append(f"  {pointer} {name}{details[world]}")
    return lines


def _select_world_interactive(target: Target, worlds: list[str], details: dict[str, str], cursor: int) -> str:
    menu = TerminalListMenu(
        [
            *app_header_lines(),
            "",
            f"  {title_text('Worlds')}",
            f"  {dim_text('↑/↓ move  Enter select  Q quit')}",
        ],
        lambda: _world_menu_lines(target, worlds, details, cursor),
    )
    menu.render_initial()
    while True:
        key = read_keypress()
        if key in {"\r", "\n"}:
            print(f"  Selected: {C.CYAN}{basename(worlds[cursor])}{C.RESET}")
            return worlds[cursor]
        if key in {"q", "Q", "\x03"}:
            raise KeyboardInterrupt
        if key == "\x1b[A":
            cursor = _move_cursor(cursor, len(worlds), "up")
            menu.redraw()
            continue
        if key == "\x1b[B":
            cursor = _move_cursor(cursor, len(worlds), "down")
            menu.redraw()
            continue


def _select_world_with_prompt(worlds: list[str], details: dict[str, str]) -> str:
    print(f"\n  {title_text('Worlds')}\n")
    for index, world in enumerate(worlds, 1):
        print(f"    {C.BOLD}{index}.{C.RESET} {basename(world)}{details[world]}")

    print()
    while True:
        try:
            choice = input(f"  Pick a world (1-{len(worlds)}): ").strip()
            idx = int(choice) - 1
            if 0 <= idx < len(worlds):
                print(f"  Selected: {C.CYAN}{basename(worlds[idx])}{C.RESET}")
                return worlds[idx]
            print(f"  {C.RED}Invalid choice{C.RESET}")
        except ValueError:
            print(f"  {C.RED}Enter a number{C.RESET}")
        except EOFError as exc:
            raise ValueError("No world selected.") from exc


def select_world(target: Target) -> str:
    worlds = target.list_worlds()
    if not worlds:
        where = target.describe(target.layout.worlds_dir) if target.layout.worlds_dir is not None else target.label
        raise ValueError(f"No worlds found in {where}.")

    if len(worlds) == 1:
        print(f"\n  {title_text('Worlds')}")
        print(f"  {dim_text('Only one world available')}")
        print(f"  Selected: {C.CYAN}{basename(worlds[0])}{C.RESET}")
        return worlds[0]

    details = all_world_details(target, worlds)
    default = target.default_world()
    cursor = worlds.index(default) if default in worlds else 0
    if is_interactive_terminal():
        return _select_world_interactive(target, worlds, details, cursor)
    return _select_world_with_prompt(worlds, details)
