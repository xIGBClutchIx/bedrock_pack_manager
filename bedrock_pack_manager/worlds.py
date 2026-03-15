"""World selection and world pack JSON helpers."""

import json
import sys
from pathlib import Path

from .console import C, TerminalListMenu, app_header_lines, dim_text, display_path, title_text
from .terminal import read_keypress


def load_world_json(path: Path) -> list:
    """Load a world pack registration file with helpful errors for bad JSON."""

    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Corrupt world pack JSON: {path} "
            f"(line {exc.lineno}, column {exc.colno}, char {exc.pos})"
        ) from exc
    except OSError as exc:
        raise ValueError(f"Can't read world pack JSON: {path} ({exc})") from exc


def save_world_json(path: Path, data: list) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def is_already_registered(world_packs: list, uuid: str) -> bool:
    return any(pack.get("pack_id") == uuid for pack in world_packs)


def upsert_pack(world_json_path: Path, uuid: str, version: list) -> str:
    """Add a pack to world JSON or update its version if it is already registered."""

    packs = load_world_json(world_json_path)
    for pack in packs:
        if pack.get("pack_id") != uuid:
            continue
        if pack.get("version") == version:
            return "unchanged"
        pack["version"] = version
        save_world_json(world_json_path, packs)
        return "updated"

    packs.append({"pack_id": uuid, "version": version})
    save_world_json(world_json_path, packs)
    return "added"


def register_pack(world_json_path: Path, uuid: str, version: list) -> bool:
    packs = load_world_json(world_json_path)
    if is_already_registered(packs, uuid):
        return False
    packs.append({"pack_id": uuid, "version": version})
    save_world_json(world_json_path, packs)
    return True


def remove_pack(world_json_path: Path, uuid: str) -> bool:
    packs = load_world_json(world_json_path)
    updated_packs = [pack for pack in packs if pack.get("pack_id") != uuid]
    if len(updated_packs) == len(packs):
        return False
    save_world_json(world_json_path, updated_packs)
    return True


def find_world_by_name(worlds_dir: Path, world_name: str) -> Path | None:
    world_path = worlds_dir / world_name
    if world_path.is_dir() and not world_path.name.startswith("."):
        return world_path
    return None


def resolve_world_path(worlds_dir: Path, world_path: str) -> Path:
    resolved_path = Path(world_path).expanduser()
    if not resolved_path.is_absolute():
        resolved_path = (worlds_dir / resolved_path).resolve()
    else:
        resolved_path = resolved_path.resolve()

    if not resolved_path.exists():
        raise ValueError(f"World path does not exist: {resolved_path}")
    if not resolved_path.is_dir():
        raise ValueError(f"World path is not a directory: {resolved_path}")

    return resolved_path


def is_interactive_terminal() -> bool:
    return bool(getattr(sys.stdin, "isatty", lambda: False)()) and bool(getattr(sys.stdout, "isatty", lambda: False)())


def _move_cursor(index: int, size: int, direction: str) -> int:
    if direction == "up":
        return (index - 1) % size
    if direction == "down":
        return (index + 1) % size
    return index


def _world_details(world: Path) -> str:
    """Build the small metadata suffix shown in the world picker."""

    extras = []
    if (world / "level.dat").exists():
        extras.append("level.dat")
    bp_json = world / "world_behavior_packs.json"
    rp_json = world / "world_resource_packs.json"
    if bp_json.exists():
        extras.append(f"{len(load_world_json(bp_json))} BP")
    if rp_json.exists():
        extras.append(f"{len(load_world_json(rp_json))} RP")
    return f" {C.DIM}({', '.join(extras)}){C.RESET}" if extras else ""


def _world_menu_lines(worlds: list[Path], cursor: int) -> list[str]:
    lines = [
        f"  {dim_text(f'{len(worlds)} world(s) available')}",
        "",
    ]
    for index, world in enumerate(worlds):
        pointer = f"{C.CYAN}▸{C.RESET}" if index == cursor else " "
        name = f"{C.BOLD}{world.name}{C.RESET}" if index == cursor else world.name
        lines.append(f"  {pointer} {name}{_world_details(world)}")
    return lines


def _select_world_interactive(worlds: list[Path]) -> Path:
    cursor = 0
    menu = TerminalListMenu(
        [
            *app_header_lines(),
            "",
            f"  {title_text('Worlds')}",
            f"  {dim_text('↑/↓ move  Enter select  Q quit')}",
        ],
        lambda: _world_menu_lines(worlds, cursor),
    )
    menu.render_initial()
    while True:
        key = read_keypress()
        if key in {"\r", "\n"}:
            print(f"  Selected: {C.CYAN}{worlds[cursor].name}{C.RESET}")
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


def _select_world_with_prompt(worlds: list[Path]) -> Path:
    print(f"\n  {title_text('Worlds')}\n")
    for index, world in enumerate(worlds, 1):
        print(f"    {C.BOLD}{index}.{C.RESET} {world.name}{_world_details(world)}")

    print()
    while True:
        try:
            choice = input(f"  Pick a world (1-{len(worlds)}): ").strip()
            idx = int(choice) - 1
            if 0 <= idx < len(worlds):
                print(f"  Selected: {C.CYAN}{worlds[idx].name}{C.RESET}")
                return worlds[idx]
            print(f"  {C.RED}Invalid choice{C.RESET}")
        except (ValueError, EOFError):
            print(f"  {C.RED}Enter a number{C.RESET}")


def select_world(worlds_dir: Path) -> Path:
    if not worlds_dir.exists():
        worlds_dir.mkdir(parents=True, exist_ok=True)

    # Hidden folders are ignored so runtime/system directories do not appear in the picker.
    worlds = sorted(
        directory
        for directory in worlds_dir.iterdir()
        if directory.is_dir() and not directory.name.startswith(".")
    )

    if not worlds:
        print(f"\n  {title_text('Worlds')}")
        print(f"  {C.RED}No worlds found in {display_path(worlds_dir)}.{C.RESET}")
        sys.exit(1)

    if len(worlds) == 1:
        print(f"\n  {title_text('Worlds')}")
        print(f"  {dim_text('Only one world available')}")
        print(f"  Selected: {C.CYAN}{worlds[0].name}{C.RESET}")
        return worlds[0]
    if is_interactive_terminal():
        return _select_world_interactive(worlds)
    return _select_world_with_prompt(worlds)
