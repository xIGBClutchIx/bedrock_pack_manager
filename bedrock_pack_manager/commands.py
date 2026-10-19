"""Top-level command handlers for install, uninstall, rebuild, cleanup, audit, zip, and world edits.

Every handler works on a ``Target`` (storage + layout), so the same code serves local folders,
FTP/FTPS, and SFTP servers. Handlers print for the CLI and also return JSON-friendly results
for the web UI.
"""

import shutil
import zipfile
from datetime import datetime
from pathlib import Path

from .console import AppState, C, error, info, ok, print_warnings, section, warn
from .install import (
    KIND_LABELS,
    DuplicateMode,
    do_install,
    load_world_packs,
    move_to_processed,
    prepare_source,
    queued_entries,
)
from .layout import PackKind, Target
from .manifests import format_version
from .nbt import GAMEMODE_VALUES, enable_beta_apis, read_level_dat, set_world_gamemode
from .pack_index import InstalledPack, PackIndex, uuid_key
from .paths import ProjectPaths
from .storage import StorageError, basename, join
from .worlds import load_world_json, registered_keys, remove_entry, save_world_json

GAMEMODE_LABELS = {
    "survival": "Survival",
    "creative": "Creative",
    "adventure": "Adventure",
}
PACK_TYPE_LABELS = KIND_LABELS


def _print_pack_summary(pack_type: str, name: str, version: list) -> None:
    color = C.GREEN if pack_type == "bp" else C.CYAN
    print(f"  {color}[{pack_type.upper()}]{C.RESET} {name} (v{format_version(version)})")


def _uninstall_flag(pack_type: str, uuid: str, version: list) -> str:
    return f"--uninstall-pack={pack_type}:{uuid}:{format_version(version)}"


def _parse_uninstall_flag(flag: str) -> tuple[str, str, str] | None:
    if not flag.startswith("--uninstall-pack="):
        return None
    payload = flag.split("=", 1)[1]
    parts = payload.split(":", 2)
    if len(parts) != 3:
        return None
    return parts[0], parts[1], parts[2]


# ---- world status ----------------------------------------------------------------------------------


def _other_worlds_using(target: Target, world: str, kind: PackKind, uuid: str, version: list, cache: dict | None = None) -> list[str]:
    """Names of other worlds that register the same pack version."""

    cache = cache if cache is not None else {}
    references = []
    for other in target.list_worlds():
        if other == world:
            continue
        key = (other, kind)
        if key not in cache:
            try:
                cache[key] = registered_keys(load_world_json(target.storage, target.world_json(other, kind)))
            except ValueError:
                cache[key] = set()
        if (uuid_key(uuid), tuple(version)) in cache[key]:
            references.append(basename(other))
    return references


def collect_uninstall_candidates(target: Target, world: str, index: PackIndex | None = None) -> list[dict]:
    """Registered packs plus their matching folders, as shown in uninstall mode."""

    index = index or PackIndex.build(target, world)
    world_packs = load_world_packs(target, world)
    candidates = []
    for kind in ("bp", "rp"):
        for entry in world_packs[kind]:
            uuid = entry.get("pack_id", "")
            version = entry.get("version", [])
            if not uuid or not isinstance(version, list):
                continue
            installed = index.find(uuid, kind)
            exact = [pack for pack in installed if pack.version == version]
            name = exact[0].name if exact else (installed[0].name if installed else uuid)
            if exact:
                details = target.describe(exact[0].path)
            elif installed:
                details = f"registered v{format_version(version)}, other version(s) on the server"
            else:
                details = "missing on the server"
            candidates.append(
                {
                    "flag": _uninstall_flag(kind, uuid, version),
                    "type": kind,
                    "type_label": PACK_TYPE_LABELS[kind],
                    "uuid": uuid,
                    "version": version,
                    "version_label": format_version(version),
                    "name": name,
                    "label": f"[{kind.upper()}] {name} (v{format_version(version)})",
                    "details": details,
                    "world_json": target.world_json(world, kind),
                    "installed": exact,
                    "installed_paths": [pack.path for pack in exact],
                }
            )
    return sorted(candidates, key=lambda candidate: (candidate["type"], candidate["name"].lower(), candidate["version_label"]))


def world_status(target: Target, world: str, index: PackIndex | None = None) -> dict:
    """Everything the UI needs about one world: registered packs, stray folders, and problems."""

    index = index or PackIndex.build(target, world)
    world_packs = load_world_packs(target, world)
    rows = []
    registered_seen: set[tuple[str, str]] = set()
    problems = list(index.problems)

    for kind in ("bp", "rp"):
        for entry in world_packs[kind]:
            uuid = entry.get("pack_id", "")
            version = entry.get("version", [])
            if not uuid:
                problems.append(f"{basename(target.world_json(world, kind))} contains an entry with no pack_id")
                continue
            registered_seen.add((kind, uuid_key(uuid)))
            installed = index.find(uuid, kind)
            exact = [pack for pack in installed if pack.version == version]
            if exact:
                status = "ok"
            elif installed:
                status = "version-mismatch"
            else:
                status = "missing"
            source = exact[0] if exact else (installed[0] if installed else None)
            rows.append(
                {
                    "flag": _uninstall_flag(kind, uuid, version) if isinstance(version, list) else "",
                    "kind": kind,
                    "uuid": uuid,
                    "version": version,
                    "version_label": format_version(version),
                    "name": source.name if source else uuid,
                    "status": status,
                    "registered": True,
                    "paths": [target.describe(pack.path) for pack in (exact or installed)],
                    "on_server_versions": sorted({pack.version_label for pack in installed}),
                    "scope": source.scope if source else None,
                    "dependencies": source.dependencies if source else [],
                }
            )

    hidden_builtin = 0
    for pack in index.packs:
        if (pack.dir_kind, uuid_key(pack.uuid)) in registered_seen:
            continue
        if pack.builtin:
            hidden_builtin += 1
            continue
        rows.append(
            {
                "flag": "",
                "kind": pack.dir_kind,
                "uuid": pack.uuid,
                "version": pack.version,
                "version_label": pack.version_label,
                "name": pack.name,
                "status": "unregistered",
                "registered": False,
                "paths": [target.describe(pack.path)],
                "on_server_versions": [pack.version_label],
                "scope": pack.scope,
                "dependencies": pack.dependencies,
            }
        )

    known = index.uuids() | {uuid_key(entry.get("pack_id", "")) for entries in world_packs.values() for entry in entries}
    dependency_problems = set()
    for row in rows:
        if row["status"] == "unregistered":
            continue
        for dep in row["dependencies"]:
            dep_uuid = uuid_key(dep.get("uuid", ""))
            if dep_uuid and dep_uuid != uuid_key(row["uuid"]) and dep_uuid not in known:
                dependency_problems.add(
                    f"'{row['name']}' depends on UUID {dep.get('uuid')} (v{format_version(dep.get('version', '?'))}) which is NOT installed - "
                    "it may not work correctly! Make sure the matching pack is also installed."
                )
    problems.extend(sorted(dependency_problems))

    level = {"exists": False, "beta": None, "gamemode": None, "level_name": None, "error": None}
    if target.storage.exists(target.level_dat(world)):
        level["exists"] = True
        try:
            level_dat = read_level_dat(target.storage, target.level_dat(world))
            level.update(beta=level_dat.beta_enabled, gamemode=level_dat.gamemode, level_name=level_dat.level_name)
        except Exception as exc:
            level["error"] = str(exc)

    rows.sort(key=lambda row: (row["kind"], row["status"] == "unregistered", str(row["name"]).lower()))
    return {
        "world": world,
        "world_name": basename(world),
        "packs": rows,
        "problems": problems,
        "notes": list(index.notes),
        "hidden_builtin": hidden_builtin,
        "level": level,
        "pack_dirs": [{"path": target.describe(pack_dir.path), "kind": pack_dir.kind, "scope": pack_dir.scope} for pack_dir in index.scanned_dirs],
        "install_dirs": {kind: target.describe(target.install_dir(world, kind)) for kind in ("bp", "rp")},
    }


# ---- uninstall queue -----------------------------------------------------------------------------


def has_uninstall_queue_entries(paths: ProjectPaths) -> bool:
    return bool(queued_entries(paths.uninstall_dir))


def _collect_uninstall_queue_candidates(target: Target, world: str, paths: ProjectPaths, state: AppState, index: PackIndex) -> list[dict]:
    """Resolve `run/uninstall/` inputs into uninstall selections for the selected world."""

    entries = queued_entries(paths.uninstall_dir)
    if not entries:
        return []

    candidate_by_key = {(candidate["type"], uuid_key(candidate["uuid"])): candidate for candidate in collect_uninstall_candidates(target, world, index)}
    selected: dict[str, dict] = {}
    scratch_dir = paths.staging_dir / "uninstall"
    scratch_dir.mkdir(parents=True, exist_ok=True)

    section("Resolve Uninstall Queue", state=state, action="uninstall_queue")
    for entry in entries:
        source = prepare_source(entry, scratch_dir, state)
        for pack in source.packs:
            candidate = candidate_by_key.get((pack.kind, uuid_key(pack.uuid)))
            if candidate is None:
                info(
                    f"{PACK_TYPE_LABELS[pack.kind]} '{pack.display_name}' is not registered in {basename(world)} - skipping",
                    state=state,
                    action="skip_uninstall_queue_pack",
                    source=str(entry),
                    uuid=pack.uuid,
                    pack_type=pack.kind,
                )
                continue
            if candidate["flag"] in selected:
                continue
            info(
                f"Queued {candidate['type_label']} '{candidate['name']}' from {entry.name}",
                state=state,
                action="queue_uninstall_pack",
                source=str(entry),
                uuid=candidate["uuid"],
                version=candidate["version"],
                pack_type=candidate["type"],
            )
            selected[candidate["flag"]] = candidate
        if source.extracted is not None:
            shutil.rmtree(source.extracted, ignore_errors=True)
        if source.packs:
            move_to_processed(entry, paths.uninstalled_dir)

    return [selected[flag] for flag in sorted(selected)]


# ---- commands --------------------------------------------------------------------------------------


def do_doctor(target: Target, world: str, state: AppState) -> dict:
    section("Audit World And Installed Packs", state=state, action="doctor")
    print(f"  Server: {C.CYAN}{target.label}{C.RESET}")
    status = world_status(target, world)

    on_server = [row for row in status["packs"] if row["status"] != "missing"]
    for row in on_server:
        _print_pack_summary(row["kind"], row["name"], row["version"])

    state.installed_packs = [
        {
            "uuid": row["uuid"],
            "name": row["name"],
            "type": row["kind"],
            "version": row["version"],
            "dependencies": row["dependencies"],
            "source": row["paths"][0] if row["paths"] else "",
        }
        for row in on_server
    ]

    for row in status["packs"]:
        label = PACK_TYPE_LABELS[row["kind"]]
        json_name = "world_behavior_packs.json" if row["kind"] == "bp" else "world_resource_packs.json"
        if row["status"] == "missing":
            warn(state, f"{label} UUID {row['uuid']} is registered in {json_name} but missing on the server")
        elif row["status"] == "version-mismatch":
            found = ", ".join(row["on_server_versions"])
            warn(state, f"{label} UUID {row['uuid']} is registered in {json_name} at v{row['version_label']} but that version is not installed (found {found})")
        elif row["status"] == "unregistered":
            warn(state, f"{label} '{row['name']}' is installed but not registered in {json_name}")
    for problem in status["problems"]:
        warn(state, problem)
    for note in status["notes"]:
        info(note)
    if status["hidden_builtin"]:
        info(f"Ignored {status['hidden_builtin']} built-in game pack(s) that ship with the server")

    bp_installed = sum(1 for row in on_server if row["kind"] == "bp")
    rp_installed = sum(1 for row in on_server if row["kind"] == "rp")
    bp_registered = sum(1 for row in status["packs"] if row["kind"] == "bp" and row["registered"])
    rp_registered = sum(1 for row in status["packs"] if row["kind"] == "rp" and row["registered"])
    print(f"  Installed on server: {C.CYAN}{bp_installed}{C.RESET} BP, {C.CYAN}{rp_installed}{C.RESET} RP")
    print(f"  Registered in world: {C.CYAN}{bp_registered}{C.RESET} BP, {C.CYAN}{rp_registered}{C.RESET} RP")

    if not state.warnings:
        print(f"  {C.GREEN}Audit clean.{C.RESET}")
    state.record(
        "doctor_summary",
        "Audit complete",
        behavior_packs=bp_installed,
        resource_packs=rp_installed,
        registered_behavior_packs=bp_registered,
        registered_resource_packs=rp_registered,
        warnings=len(state.warnings),
    )
    print_warnings(state.warnings)
    return status


def do_rebuild(target: Target, world: str, state: AppState) -> dict:
    """Overwrite both world JSONs with every pack found on the server (newest version per UUID)."""

    section("Rebuild JSONs", state=state, action="rebuild")
    index = PackIndex.build(target, world)
    for problem in index.problems:
        warn(state, problem)

    result = {}
    for kind in ("bp", "rp"):
        newest: dict[str, InstalledPack] = {}
        for pack in sorted(index.of_kind(kind), key=lambda item: item.folder.lower()):
            if pack.nested or pack.builtin:
                continue
            current = newest.get(uuid_key(pack.uuid))
            if current is not None:
                if current.version != pack.version:
                    warn(state, f"'{pack.name}' has several versions installed ({current.version_label}, {pack.version_label}) - registering the newest")
                if _version_sort_key(pack.version) <= _version_sort_key(current.version):
                    continue
            newest[uuid_key(pack.uuid)] = pack
        entries = []
        for pack in sorted(newest.values(), key=lambda item: item.folder.lower()):
            entries.append({"pack_id": pack.uuid, "version": pack.version})
            _print_pack_summary(kind, pack.name, pack.version)
        save_world_json(target.storage, target.world_json(world, kind), entries)
        result[kind] = len(entries)

    print(f"  {C.GREEN}Done!{C.RESET} Registered {C.CYAN}{result['bp']}{C.RESET} behavior pack(s) and {C.CYAN}{result['rp']}{C.RESET} resource pack(s)")
    state.record(
        "rebuild_world_json",
        "Rebuilt world pack JSON files",
        world_dir=world,
        behavior_packs=result["bp"],
        resource_packs=result["rp"],
        behavior_json=target.world_json(world, "bp"),
        resource_json=target.world_json(world, "rp"),
    )
    print_warnings(state.warnings)
    return {"behavior_packs": result["bp"], "resource_packs": result["rp"]}


def _version_sort_key(version: list) -> tuple:
    return tuple((0, value) if isinstance(value, int) else (-1, str(value)) for value in version)


def do_cleanup_pack_folders(target: Target, world: str, state: AppState, *, dry_run: bool = False) -> dict:
    """Delete installed pack folders this world does not register and no other world uses."""

    section("Cleanup Pack Folders" + (" (dry run)" if dry_run else ""), state=state, action="cleanup_pack_folders")
    index = PackIndex.build(target, world)
    world_packs = load_world_packs(target, world)
    registered = {kind: registered_keys(world_packs[kind]) for kind in ("bp", "rp")}
    cache: dict = {}
    deleted, kept = [], []

    for pack in list(index.packs):
        if pack.scope == "dev" or pack.nested or pack.builtin:
            continue
        if pack.key in registered[pack.dir_kind]:
            continue
        other_worlds = _other_worlds_using(target, world, pack.dir_kind, pack.uuid, pack.version, cache) if pack.scope == "shared" else []
        if other_worlds:
            kept.append(pack.path)
            info(
                f"Kept {target.describe(pack.path)} because still used by: {', '.join(other_worlds)}",
                state=state,
                action="keep_shared_cleanup_pack",
                uuid=pack.uuid,
                version=pack.version,
                pack_type=pack.dir_kind,
                world_dir=world,
                referenced_by=other_worlds,
            )
            state.record(
                "cleanup_pack_folder",
                "Kept unregistered pack folder because another world still references it",
                uuid=pack.uuid,
                version=pack.version,
                pack_type=pack.dir_kind,
                deleted=False,
                path=pack.path,
                referenced_by=other_worlds,
            )
            continue

        if dry_run:
            deleted.append(pack.path)
            info(f"Would delete {target.describe(pack.path)}", state=state, action="cleanup_pack_folder_plan", path=pack.path)
            continue
        try:
            target.storage.remove_tree(pack.path)
        except (StorageError, OSError) as exc:
            warn(state, f"Could not delete {target.describe(pack.path)}: {exc}")
            continue
        deleted.append(pack.path)
        ids = {"uuid": pack.uuid, "version": pack.version, "pack_type": pack.dir_kind}
        ok(f"Deleted {target.describe(pack.path)}", state=state, action="cleanup_pack_folder", deleted_path=pack.path, **ids)
        state.record("cleanup_pack_folder", "Deleted unregistered pack folder", deleted=True, path=pack.path, referenced_by=[], **ids)

    verb = "Would delete" if dry_run else "Deleted"
    if not deleted:
        print(f"  {C.GREEN}No unregistered pack folders to delete.{C.RESET}")
    else:
        print(f"  {C.GREEN}Done!{C.RESET} {verb} {C.CYAN}{len(deleted)}{C.RESET} unregistered pack folder(s)")
    if kept:
        print(f"  Kept {C.CYAN}{len(kept)}{C.RESET} folder(s) still referenced by other worlds")

    state.record("cleanup_pack_folders_summary", "Cleanup pack folders complete", world_dir=world, deleted_folders=len(deleted), kept_shared_folders=len(kept), dry_run=dry_run)
    print_warnings(state.warnings)
    return {"deleted": [target.describe(path) for path in deleted], "kept": [target.describe(path) for path in kept], "dry_run": dry_run}


def _resolve_zip_name(zip_name: str | None = None) -> str:
    if zip_name:
        normalized_name = Path(zip_name).name.strip()
        if not normalized_name.lower().endswith(".zip"):
            normalized_name += ".zip"
        return normalized_name
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    return f"Bedrock_Packs_{timestamp}.zip"


def do_zip(target: Target, paths: ProjectPaths, state: AppState, zip_name: str | None = None, *, output_dir: Path | None = None, world: str | None = None) -> dict:
    """Download worlds and pack folders into a local zip (a backup when the target is remote).

    With ``world`` only that world plus the pack folders are included.
    """

    zip_name = _resolve_zip_name(zip_name)
    output_dir = output_dir or paths.base_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    zip_path = output_dir / zip_name

    section("Zip Pack Folders", state=state, action="zip")
    print(f"  Server: {C.CYAN}{target.label}{C.RESET}")

    layout = target.layout
    folders: list[str] = []
    if world is not None:
        folders.append(world)
    elif layout.single_world is not None:
        folders.append(layout.single_world)
    elif layout.worlds_dir is not None:
        folders.append(layout.worlds_dir)
    for kind in ("bp", "rp"):
        for folder in (layout.shared_dir(kind), layout.dev_dir(kind)):
            if folder is not None:
                folders.append(folder)

    file_count = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for folder in folders:
            if not target.storage.is_dir(folder):
                warn(state, f"{target.describe(folder)}/ does not exist - skipping")
                continue
            top = basename(folder) or "root"
            if world is not None and folder == world:
                top = join("worlds", basename(world))
            print(f"  Adding {target.describe(folder)} ...")
            for relative, data in target.storage.download_files(folder):
                zf.writestr(join(top, relative), data)
                file_count += 1

    size_mb = zip_path.stat().st_size / (1024 * 1024)
    print(f"\n  {C.GREEN}Done!{C.RESET} {file_count} files zipped")
    print(f"  {C.CYAN}{zip_name}{C.RESET} ({size_mb:.1f} MB)")
    print(f"  Saved to: {zip_path}")
    state.record("create_zip", "Created zip archive", zip_path=str(zip_path), file_count=file_count, size_mb=round(size_mb, 1))
    return {"zip_path": str(zip_path), "zip_name": zip_name, "file_count": file_count, "size_mb": round(size_mb, 1)}


def do_uninstall(target: Target, world: str, paths: ProjectPaths, selected_flags: set[str], state: AppState, keep_files: bool = False) -> dict:
    index = PackIndex.build(target, world)
    if selected_flags:
        candidates = {candidate["flag"]: candidate for candidate in collect_uninstall_candidates(target, world, index)}
        unknown_flags = sorted(flag for flag in selected_flags if flag not in candidates)
        if unknown_flags:
            raise ValueError(f"Unknown uninstall selection(s): {', '.join(unknown_flags)}")
        chosen = [candidates[flag] for flag in sorted(selected_flags)]
    else:
        chosen = _collect_uninstall_queue_candidates(target, world, paths, state, index)
        if not chosen:
            raise ValueError("No packs from run/uninstall matched this world's registered packs.")

    section("Uninstall Packs", state=state, action="uninstall", keep_files=keep_files)
    world_packs = load_world_packs(target, world)
    changed_kinds: set[str] = set()
    cache: dict = {}
    removed_from_world = 0
    deleted_folders: list[str] = []

    # Unregister first and save, so an interrupted delete never leaves the world pointing at half a pack.
    for candidate in chosen:
        kind = candidate["type"]
        json_name = basename(candidate["world_json"])
        ids = {"uuid": candidate["uuid"], "version": candidate["version"]}
        if remove_entry(world_packs[kind], candidate["uuid"]):
            changed_kinds.add(kind)
            removed_from_world += 1
            state.record("uninstall_world_pack", f"Removed from {json_name}", world_json=candidate["world_json"], **ids)
        else:
            state.record("uninstall_world_pack", f"Already missing from {json_name}", world_json=candidate["world_json"], **ids)
    for kind in sorted(changed_kinds):
        save_world_json(target.storage, target.world_json(world, kind), world_packs[kind])

    for candidate in chosen:
        kind = candidate["type"]
        ids = {"uuid": candidate["uuid"], "version": candidate["version"], "pack_type": kind}
        print(f"\n    {C.BOLD}[{candidate['type_label']}]{C.RESET} {candidate['name']} (v{candidate['version_label']})")
        print(f"    UUID: {C.DIM}{candidate['uuid']}{C.RESET}")
        print(f"  {C.GREEN}[OK]{C.RESET} Unregistered from {basename(candidate['world_json'])}")

        installed: list[InstalledPack] = candidate["installed"]
        if not installed:
            info("No matching installed pack files found on the server", state=state, action="uninstall_missing_pack_files", **ids)
            state.record("uninstall_pack", "Removed stale pack registration", removed_paths=[], referenced_by=[], keep_files=False, **ids)
            continue

        if keep_files:
            kept = [pack.path for pack in installed]
            info("Kept installed pack files on the server", state=state, action="keep_uninstall_pack_files", installed_paths=kept, **ids)
            state.record(
                "uninstall_pack", "Removed pack from world JSON and kept files", removed_paths=[], kept_paths=kept, referenced_by=[], keep_files=True, **ids
            )
            continue

        other_worlds = _other_worlds_using(target, world, kind, candidate["uuid"], candidate["version"], cache)
        removed_paths = []
        for pack in installed:
            if pack.builtin:
                info(f"Kept built-in game pack {target.describe(pack.path)}", state=state, action="keep_builtin_pack_files", path=pack.path)
                continue
            if pack.scope == "shared" and other_worlds:
                message = f"Kept {target.describe(pack.path)} because still used by: {', '.join(other_worlds)}"
                info(message, state=state, action="keep_shared_pack_files", world_dir=world, referenced_by=other_worlds, **ids)
                continue
            if pack.scope == "dev":
                info(f"Kept development copy {target.describe(pack.path)}", state=state, action="keep_dev_pack_files", path=pack.path)
                continue
            try:
                target.storage.remove_tree(pack.path)
            except (StorageError, OSError) as exc:
                warn(state, f"Could not delete {target.describe(pack.path)}: {exc}")
                continue
            removed_paths.append(pack.path)
            deleted_folders.append(pack.path)
            ok(f"Deleted {target.describe(pack.path)}", state=state, action="delete_installed_pack", deleted_path=pack.path, **ids)

        message = "Removed pack from world and server" if removed_paths else "Removed pack from world but kept shared files"
        state.record("uninstall_pack", message, removed_paths=removed_paths, referenced_by=other_worlds, keep_files=False, **ids)

    print(f"\n  {C.GREEN}Done!{C.RESET} Removed {C.CYAN}{removed_from_world}{C.RESET} pack(s) from '{C.CYAN}{basename(world)}{C.RESET}'")
    if keep_files:
        print("  Kept installed pack folders on the server")
    else:
        print(f"  Deleted {C.CYAN}{len(deleted_folders)}{C.RESET} installed folder(s)")
    print_warnings(state.warnings)
    return {"removed": removed_from_world, "deleted": [target.describe(path) for path in deleted_folders]}


def _level_dat_or_warn(target: Target, world: str, what: str, state: AppState | None, **details) -> str | None:
    dat_path = target.level_dat(world)
    if not target.storage.exists(dat_path):
        print(f"  {C.YELLOW}[WARNING]{C.RESET} No level.dat found in '{basename(world)}' - skipping {what}")
        if state is not None:
            state.record(details.pop("action"), f"Skipped {what} because level.dat is missing", world_dir=world, changed=False, **details)
        return None
    try:
        import nbtlib  # noqa: F401
    except ImportError:
        error("nbtlib is required. Install it with: pip install nbtlib", state=state, world_dir=world, changed=False, **details)
        return None
    return dat_path


def do_beta(target: Target, world: str, state: AppState | None = None) -> dict:
    dat_path = _level_dat_or_warn(target, world, "beta toggle", state, action="beta_toggle")
    if dat_path is None:
        return {"changed": False}

    section("Enable Beta APIs", state=state, action="beta")
    if not enable_beta_apis(target.storage, dat_path):
        print(f"\n  Beta APIs already {C.GREEN}enabled{C.RESET} for '{basename(world)}'")
        if state is not None:
            state.record("beta_toggle", "Beta APIs already enabled", world_dir=world, changed=False)
        return {"changed": False}

    info("Backup saved as level.dat.backup", state=state, action="beta_backup", backup_path=join(world, "level.dat.backup"))
    print(f"\n  {C.GREEN}Done!{C.RESET} Beta APIs enabled for '{C.CYAN}{basename(world)}{C.RESET}'")
    print(f"  {C.YELLOW}Restart the server for this to take effect (a running server may overwrite level.dat).{C.RESET}")
    if state is not None:
        state.record("beta_toggle", "Enabled beta APIs", world_dir=world, changed=True)
    return {"changed": True}


def do_set_gamemode(target: Target, world: str, gamemode: str, state: AppState | None = None) -> dict:
    dat_path = _level_dat_or_warn(target, world, "gamemode update", state, action="set_gamemode", gamemode=gamemode)
    if dat_path is None:
        return {"changed": False}

    gamemode_label = GAMEMODE_LABELS[gamemode]
    section(f"Set World Gamemode: {gamemode_label}", state=state, action="set_gamemode_section", gamemode=gamemode)
    if not set_world_gamemode(target.storage, dat_path, gamemode):
        print(f"\n  World gamemode already set to {C.GREEN}{gamemode_label}{C.RESET} for '{basename(world)}'")
        if state is not None:
            state.record("set_gamemode", "World gamemode already set", world_dir=world, gamemode=gamemode, changed=False)
        return {"changed": False}

    info("Backup saved as level.dat.backup", state=state, action="gamemode_backup", backup_path=join(world, "level.dat.backup"))
    print(f"\n  {C.GREEN}Done!{C.RESET} World gamemode set to {C.CYAN}{gamemode_label}{C.RESET} for '{C.CYAN}{basename(world)}{C.RESET}'")
    print(f"  {C.YELLOW}Restart the server for this to take effect (a running server may overwrite level.dat).{C.RESET}")
    if state is not None:
        state.record("set_gamemode", "Updated world gamemode", world_dir=world, gamemode=gamemode, changed=True)
    return {"changed": True}


def _selected_gamemode(flags: set[str]) -> str | None:
    for flag in flags:
        if not flag.startswith("--gamemode="):
            continue
        gamemode = flag.split("=", 1)[1]
        if gamemode in GAMEMODE_VALUES:
            return gamemode
    return None


def _selected_uninstall_flags(flags: set[str]) -> set[str]:
    return {flag for flag in flags if flag.startswith("--uninstall-pack=")}


def _keep_uninstall_files(flags: set[str]) -> bool:
    return "--uninstall-keep-files" in flags


def _selected_zip_name(flags: set[str]) -> str | None:
    for flag in flags:
        if flag.startswith("--zip-name="):
            return flag.split("=", 1)[1]
    return None


def run(
    flags: set[str],
    target: Target,
    world: str | None,
    paths: ProjectPaths,
    state: AppState,
    duplicate_mode: DuplicateMode = "replace",
    *,
    reupload: bool = False,
    dry_run: bool = False,
) -> None:
    if not flags:
        do_install(target, world, paths, state, duplicate_mode=duplicate_mode, reupload=reupload, dry_run=dry_run)
        return

    if "--doctor" in flags:
        do_doctor(target, world, state)

    if "--uninstall" in flags:
        do_uninstall(target, world, paths, _selected_uninstall_flags(flags), state, keep_files=_keep_uninstall_files(flags))

    if "--cleanup-pack-folders" in flags:
        do_cleanup_pack_folders(target, world, state, dry_run=dry_run)

    if "--rebuild" in flags:
        do_rebuild(target, world, state)

    if "--beta" in flags:
        do_beta(target, world, state)

    gamemode = _selected_gamemode(flags)
    if gamemode is not None:
        do_set_gamemode(target, world, gamemode, state)

    if "--zip" in flags:
        do_zip(target, paths, state, zip_name=_selected_zip_name(flags))
