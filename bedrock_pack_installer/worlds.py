import json
import sys
import termios
import tty
from pathlib import Path

from .console import C, TerminalListMenu, app_header_lines, display_path


def load_world_json(path: Path) -> list:
    if not path.exists():
        return []
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def save_world_json(path: Path, data: list) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def is_already_registered(world_packs: list, uuid: str) -> bool:
    return any(pack.get("pack_id") == uuid for pack in world_packs)


def register_pack(world_json_path: Path, uuid: str, version: list) -> bool:
    packs = load_world_json(world_json_path)
    if is_already_registered(packs, uuid):
        return False
    packs.append({"pack_id": uuid, "version": version})
    save_world_json(world_json_path, packs)
    return True


def is_interactive_terminal() -> bool:
    return bool(getattr(sys.stdin, "isatty", lambda: False)()) and bool(getattr(sys.stdout, "isatty", lambda: False)())


def _read_key() -> str:
    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        first = sys.stdin.read(1)
        if first == "\x1b":
            second = sys.stdin.read(1)
            third = sys.stdin.read(1)
            return first + second + third
        return first
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def _move_cursor(index: int, size: int, direction: str) -> int:
    if direction == "up":
        return (index - 1) % size
    if direction == "down":
        return (index + 1) % size
    return index


def _world_details(world: Path) -> str:
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
        f"  {C.DIM}{len(worlds)} world(s) available{C.RESET}",
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
            f"  {C.CYAN}{C.BOLD}Worlds{C.RESET}",
            f"  {C.DIM}↑/↓ move  Enter select  Q quit{C.RESET}",
        ],
        lambda: _world_menu_lines(worlds, cursor),
    )
    menu.render_initial()
    while True:
        key = _read_key()
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
    print(f"\n  {C.CYAN}{C.BOLD}Worlds{C.RESET}\n")
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

    worlds = sorted(
        directory
        for directory in worlds_dir.iterdir()
        if directory.is_dir() and not directory.name.startswith(".")
    )

    if not worlds:
        print(f"\n  {C.CYAN}{C.BOLD}Worlds{C.RESET}")
        print(f"  {C.RED}No worlds found in {display_path(worlds_dir)}.{C.RESET}")
        sys.exit(1)

    if len(worlds) == 1:
        print(f"\n  {C.CYAN}{C.BOLD}Worlds{C.RESET}")
        print(f"  {C.DIM}Only one world available{C.RESET}")
        print(f"  Selected: {C.CYAN}{worlds[0].name}{C.RESET}")
        return worlds[0]
    if is_interactive_terminal():
        return _select_world_interactive(worlds)
    return _select_world_with_prompt(worlds)
