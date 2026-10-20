"""Bridge between the hosted browser app (Pyodide) and the existing command handlers.

The browser UI calls these functions with plain strings and gets JSON strings back,
so the JavaScript side never has to deal with Python objects directly.
"""

import json
import shutil
from pathlib import Path

from .commands import collect_uninstall_candidates, run
from .console import AppState, C, app_header
from .install import DuplicateMode
from .logger import capture_run_logs
from .paths import build_paths, ensure_runtime_dirs
from .worlds import find_world_by_name

RUN_MARKERS = ("worlds", "behavior_packs", "resource_packs")


def _paths(base_dir: str):
    paths = build_paths(Path(base_dir))
    ensure_runtime_dirs(paths)
    return paths


def _world_dir(paths, world_name: str) -> Path:
    world_dir = find_world_by_name(paths.worlds_dir, world_name) if world_name else None
    if world_dir is None:
        raise ValueError(f"World '{world_name}' was not found in worlds/")
    return world_dir


def normalize_upload(run_dir: str) -> str:
    """Flatten an uploaded zip that wraps the server folder in one extra top-level folder."""

    root = Path(run_dir)
    if any((root / marker).is_dir() for marker in RUN_MARKERS):
        return json.dumps({"ok": True})

    children = [child for child in root.iterdir() if child.name != "__MACOSX"]
    if len(children) == 1 and children[0].is_dir() and any((children[0] / marker).is_dir() for marker in RUN_MARKERS):
        wrapper = children[0]
        for item in list(wrapper.iterdir()):
            shutil.move(str(item), str(root / item.name))
        wrapper.rmdir()
        return json.dumps({"ok": True})

    return json.dumps({"ok": False, "error": "The zip must contain a worlds/ folder (and usually behavior_packs/ and resource_packs/)."})


def list_worlds(base_dir: str) -> str:
    paths = _paths(base_dir)
    worlds = sorted(world.name for world in paths.worlds_dir.iterdir() if world.is_dir())
    return json.dumps(worlds)


def uninstall_candidates(base_dir: str, world_name: str) -> str:
    paths = _paths(base_dir)
    candidates = collect_uninstall_candidates(_world_dir(paths, world_name), paths)
    return json.dumps([{"flag": candidate["flag"], "label": candidate["label"], "details": candidate["details"]} for candidate in candidates])


def run_action(base_dir: str, world_name: str, flags_json: str, duplicate_mode: DuplicateMode = "replace") -> str:
    """Run one action with CLI-style flags and report the outcome plus any zip that was created."""

    paths = _paths(base_dir)
    flags = set(json.loads(flags_json))
    state = AppState()
    result = {"ok": True, "warnings": [], "zip_path": None}

    with capture_run_logs(paths.logs_dir):
        app_header()
        try:
            zip_only = bool(flags) and all(flag.startswith("--zip") for flag in flags)
            world_dir = None if zip_only else _world_dir(paths, world_name)
            run(flags, world_dir, paths, state, duplicate_mode=duplicate_mode)
        except ValueError as exc:
            print(f"\n{C.RED}{exc}{C.RESET}")
            result["ok"] = False

    result["warnings"] = state.warnings
    for action in state.actions:
        if action.kind == "create_zip":
            result["zip_path"] = action.details.get("zip_path")
    return json.dumps(result)
