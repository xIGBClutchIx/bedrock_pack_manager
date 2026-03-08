import json
import sys
from pathlib import Path

from .console import C


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


def select_world(worlds_dir: Path) -> Path:
    if not worlds_dir.exists():
        worlds_dir.mkdir(parents=True, exist_ok=True)

    worlds = sorted(
        directory
        for directory in worlds_dir.iterdir()
        if directory.is_dir() and not directory.name.startswith(".")
    )

    if not worlds:
        try:
            display_path = worlds_dir.relative_to(Path.cwd())
        except ValueError:
            display_path = worlds_dir
        print(f"\n  {C.RED}No worlds found in {display_path}.{C.RESET}")
        sys.exit(1)

    if len(worlds) == 1:
        print(f"\n  World: {C.CYAN}{worlds[0].name}{C.RESET}")
        return worlds[0]

    print(f"\n  Found {len(worlds)} world(s):\n")
    for index, world in enumerate(worlds, 1):
        extras = []
        if (world / "level.dat").exists():
            extras.append("level.dat")
        bp_json = world / "world_behavior_packs.json"
        rp_json = world / "world_resource_packs.json"
        if bp_json.exists():
            extras.append(f"{len(load_world_json(bp_json))} BP")
        if rp_json.exists():
            extras.append(f"{len(load_world_json(rp_json))} RP")
        extra_str = f" {C.DIM}({', '.join(extras)}){C.RESET}" if extras else ""
        print(f"    {C.BOLD}{index}.{C.RESET} {world.name}{extra_str}")

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
