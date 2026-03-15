"""Top-level command handlers for install, uninstall, rebuild, audit, zip, and world edits."""

import os
import shutil
import zipfile
from datetime import datetime
from pathlib import Path

from .console import AppState, C, display_path, error, info, ok, print_warnings, section, warn
from .constants import ARCHIVE_EXTS
from .install import (
    DuplicateMode,
    UnsafeArchivePathError,
    do_install,
    extract_archive,
    extract_nested_archives,
    find_all_packs,
    find_packs_on_disk,
    move_to_processed,
)
from .manifests import classify_pack, get_pack_dependencies, get_pack_info, read_manifest
from .nbt import GAMEMODE_VALUES, enable_beta_apis, set_world_gamemode
from .paths import ProjectPaths
from .worlds import load_world_json, remove_pack, save_world_json

GAMEMODE_LABELS = {
    "survival": "Survival",
    "creative": "Creative",
    "adventure": "Adventure",
}
PACK_TYPE_LABELS = {
    "bp": "Behavior Pack",
    "rp": "Resource Pack",
}


def _format_version(version: list) -> str:
    return ".".join(str(value) for value in version)


def _print_pack_summary(pack_type: str, name: str, version: list) -> None:
    color = C.GREEN if pack_type == "bp" else C.CYAN
    print(f"  {color}[{pack_type.upper()}]{C.RESET} {name} (v{_format_version(version)})")


def _load_registered_ids(world_json: Path) -> set[str]:
    if not world_json.exists():
        return set()
    return {entry.get("pack_id", "") for entry in load_world_json(world_json)}


def _uninstall_flag(pack_type: str, uuid: str, version: list) -> str:
    return f"--uninstall-pack={pack_type}:{uuid}:{_format_version(version)}"


def _parse_uninstall_flag(flag: str) -> tuple[str, str, str] | None:
    if not flag.startswith("--uninstall-pack="):
        return None
    payload = flag.split("=", 1)[1]
    parts = payload.split(":", 2)
    if len(parts) != 3:
        return None
    return parts[0], parts[1], parts[2]


def _matching_installed_packs(dest_dir: Path, uuid: str, version: list) -> list[dict]:
    return [pack for pack in find_packs_on_disk(dest_dir, uuid) if pack["version"] == version]


def collect_uninstall_candidates(world_dir: Path, paths: ProjectPaths) -> list[dict]:
    """Collect registered packs and the matching on-disk details shown in uninstall mode."""

    candidates = []
    for pack_type, world_json_name, dest_dir in [
        ("bp", "world_behavior_packs.json", paths.behavior_packs_dir),
        ("rp", "world_resource_packs.json", paths.resource_packs_dir),
    ]:
        world_json = world_dir / world_json_name
        for entry in load_world_json(world_json):
            uuid = entry.get("pack_id", "")
            version = entry.get("version", [])
            if not uuid or not isinstance(version, list):
                continue

            installed_packs = find_packs_on_disk(dest_dir, uuid)
            exact_matches = [pack for pack in installed_packs if pack["version"] == version]
            name = exact_matches[0]["name"] if exact_matches else (installed_packs[0]["name"] if installed_packs else uuid)

            if exact_matches:
                details = display_path(exact_matches[0]["path"])
            elif installed_packs:
                details = f"registered v{_format_version(version)}, other version(s) on disk"
            else:
                details = "missing on disk"

            candidates.append(
                {
                    "flag": _uninstall_flag(pack_type, uuid, version),
                    "type": pack_type,
                    "type_label": PACK_TYPE_LABELS[pack_type],
                    "uuid": uuid,
                    "version": version,
                    "version_label": _format_version(version),
                    "name": name,
                    "label": f"[{pack_type.upper()}] {name} (v{_format_version(version)})",
                    "details": details,
                    "world_json": world_dir / world_json_name,
                    "installed_paths": [pack["path"] for pack in exact_matches],
                }
            )

    return sorted(candidates, key=lambda candidate: (candidate["type"], candidate["name"].lower(), candidate["version_label"]))


def has_uninstall_queue_entries(paths: ProjectPaths) -> bool:
    if not paths.uninstall_dir.exists():
        return False
    return any(
        not entry.name.startswith(".") and not entry.name.startswith("_extracted_")
        for entry in paths.uninstall_dir.iterdir()
    )


def _read_uninstall_source_pack(pack_folder: Path, state: AppState) -> dict | None:
    manifest_path = pack_folder / "manifest.json"
    if not manifest_path.exists():
        warn(state, f"Folder '{pack_folder.name}' has no manifest.json - not a valid pack")
        return None

    manifest = read_manifest(manifest_path)
    if not manifest:
        return None

    pack_type = classify_pack(manifest)
    uuid, _version, name = get_pack_info(manifest)
    if not pack_type:
        modules = manifest.get("modules", [])
        types = [module.get("type", "???") for module in modules]
        warn(state, f"Cannot determine type for '{name}' (module types: {types}) - skipping")
        return None
    if not uuid:
        warn(state, f"Pack '{name}' has no UUID in manifest - skipping (broken pack?)")
        return None

    return {
        "type": pack_type,
        "type_label": PACK_TYPE_LABELS[pack_type],
        "uuid": uuid,
        "name": name,
    }


def _collect_uninstall_source_packs(entry: Path, paths: ProjectPaths, state: AppState) -> list[dict]:
    print(f"\n{C.BOLD}>> {entry.name}{C.RESET}")

    if entry.is_file() and entry.suffix.lower() not in ARCHIVE_EXTS:
        warn(
            state,
            f"Unknown file type '{entry.suffix}' for '{entry.name}' - "
            f"only {', '.join(sorted(ARCHIVE_EXTS))} are supported",
        )
        return []

    pack_folders: list[Path] = []
    extracted_dir: Path | None = None

    if entry.is_file() and entry.suffix.lower() in ARCHIVE_EXTS:
        try:
            extracted_dir = extract_archive(entry, paths.uninstall_dir)
        except zipfile.BadZipFile:
            warn(state, f"'{entry.name}' is not a valid zip archive - file may be corrupt")
            return []
        except UnsafeArchivePathError as exc:
            warn(state, f"'{entry.name}' contains unsafe archive paths - skipping it ({exc})")
            return []
        except Exception as exc:
            warn(state, f"Failed to extract '{entry.name}': {exc}")
            return []

        extract_nested_archives(extracted_dir, state)
        pack_folders = find_all_packs(extracted_dir)
        if not pack_folders:
            warn(
                state,
                f"No manifest.json found anywhere inside '{entry.name}' - "
                f"archive may not be a valid Minecraft pack",
            )
            shutil.rmtree(extracted_dir, ignore_errors=True)
            return []

        info(f"Found {len(pack_folders)} pack(s) inside", state=state, action="inspect_uninstall_source", source=str(entry))
    elif entry.is_dir() and not entry.name.startswith("_extracted_"):
        pack_folders = find_all_packs(entry)
        if not pack_folders:
            warn(state, f"Folder '{entry.name}' contains no manifest.json - not a valid pack or addon")
            return []
        if len(pack_folders) > 1 or pack_folders[0] != entry:
            info(f"Found {len(pack_folders)} pack(s) inside folder", state=state, action="inspect_uninstall_source", source=str(entry))

    source_packs = []
    for pack_folder in pack_folders:
        source_pack = _read_uninstall_source_pack(pack_folder, state)
        if source_pack is not None:
            source_packs.append(source_pack)

    if extracted_dir is not None:
        shutil.rmtree(extracted_dir, ignore_errors=True)

    if source_packs:
        move_to_processed(entry, paths.uninstalled_dir)
    return source_packs


def _collect_uninstall_queue_candidates(world_dir: Path, paths: ProjectPaths, state: AppState) -> list[dict]:
    """Resolve `run/uninstall/` inputs into uninstall flags for the selected world."""

    if not paths.uninstall_dir.exists():
        return []

    queued_entries = sorted(
        entry
        for entry in paths.uninstall_dir.iterdir()
        if not entry.name.startswith(".") and not entry.name.startswith("_extracted_")
    )
    if not queued_entries:
        return []

    registered_candidates = collect_uninstall_candidates(world_dir, paths)
    candidate_by_key = {
        (candidate["type"], candidate["uuid"]): candidate
        for candidate in registered_candidates
    }
    selected_candidates: dict[str, dict] = {}

    section("Resolve Uninstall Queue", state=state, action="uninstall_queue")

    for entry in queued_entries:
        for source_pack in _collect_uninstall_source_packs(entry, paths, state):
            candidate = candidate_by_key.get((source_pack["type"], source_pack["uuid"]))
            if candidate is None:
                info(
                    f"{source_pack['type_label']} '{source_pack['name']}' is not registered in {world_dir.name} - skipping",
                    state=state,
                    action="skip_uninstall_queue_pack",
                    source=str(entry),
                    uuid=source_pack["uuid"],
                    pack_type=source_pack["type"],
                )
                continue

            if candidate["flag"] in selected_candidates:
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
            selected_candidates[candidate["flag"]] = candidate

    return [selected_candidates[flag] for flag in sorted(selected_candidates)]


def _other_world_references(paths: ProjectPaths, world_dir: Path, pack_type: str, uuid: str, version: list) -> list[str]:
    world_json_name = "world_behavior_packs.json" if pack_type == "bp" else "world_resource_packs.json"
    references = []

    for other_world in sorted(paths.worlds_dir.iterdir(), key=lambda path: path.name.lower()):
        if not other_world.is_dir() or other_world.name.startswith(".") or other_world.resolve() == world_dir.resolve():
            continue
        for entry in load_world_json(other_world / world_json_name):
            if entry.get("pack_id") == uuid and entry.get("version") == version:
                references.append(other_world.name)
                break

    return references


def _scan_installed_packs(pack_dir: Path, label: str, state: AppState) -> list[dict]:
    packs = []
    if not pack_dir.exists():
        warn(state, f"{pack_dir.name}/ does not exist")
        return packs

    for subfolder in sorted(pack_dir.iterdir()):
        if not subfolder.is_dir():
            continue
        manifest_path = subfolder / "manifest.json"
        if not manifest_path.exists():
            warn(state, f"{pack_dir.name}/{subfolder.name} has no manifest.json - skipping")
            continue
        manifest = read_manifest(manifest_path)
        if not manifest:
            continue
        uuid, version, name = get_pack_info(manifest)
        if not uuid:
            warn(state, f"{pack_dir.name}/{subfolder.name} has no UUID - skipping")
            continue
        packs.append(
            {
                "uuid": uuid,
                "version": version,
                "name": name,
                "dependencies": get_pack_dependencies(manifest),
                "path": subfolder,
                "label": label,
            }
        )
    return packs


def _pack_map(packs: list[dict]) -> dict[str, list[dict]]:
    mapping: dict[str, list[dict]] = {}
    for pack in packs:
        mapping.setdefault(pack["uuid"], []).append(pack)
    return mapping


def _audit_world_json(world_json: Path, label: str, installed_map: dict[str, list[dict]], state: AppState) -> int:
    if not world_json.exists():
        warn(state, f"{world_json.name} does not exist")
        return 0

    count = 0
    for entry in load_world_json(world_json):
        count += 1
        pack_id = entry.get("pack_id", "")
        version = entry.get("version", [])
        if not pack_id:
            warn(state, f"{world_json.name} contains an entry with no pack_id")
            continue
        installed_versions = installed_map.get(pack_id, [])
        if not installed_versions:
            warn(state, f"{label} UUID {pack_id} is registered in {world_json.name} but missing on disk")
            continue
        if version and not any(pack["version"] == version for pack in installed_versions):
            warn(
                state,
                f"{label} UUID {pack_id} is registered in {world_json.name} at v{'.'.join(str(v) for v in version)} but that version is not installed on disk",
            )
    return count


def do_doctor(world_dir: Path, paths: ProjectPaths, state: AppState) -> None:
    section("Audit World And Installed Packs", state=state, action="doctor")

    behavior_packs = _scan_installed_packs(paths.behavior_packs_dir, "Behavior Pack", state)
    resource_packs = _scan_installed_packs(paths.resource_packs_dir, "Resource Pack", state)
    all_packs = behavior_packs + resource_packs

    for pack in behavior_packs:
        _print_pack_summary("bp", pack["name"], pack["version"])
    for pack in resource_packs:
        _print_pack_summary("rp", pack["name"], pack["version"])

    state.installed_packs = [
        {
            "uuid": pack["uuid"],
            "name": pack["name"],
            "type": "bp" if pack["label"] == "Behavior Pack" else "rp",
            "version": pack["version"],
            "dependencies": pack["dependencies"],
            "source": pack["path"].name,
        }
        for pack in all_packs
    ]

    behavior_map = _pack_map(behavior_packs)
    resource_map = _pack_map(resource_packs)

    registered_bp_count = _audit_world_json(world_dir / "world_behavior_packs.json", "Behavior Pack", behavior_map, state)
    registered_rp_count = _audit_world_json(world_dir / "world_resource_packs.json", "Resource Pack", resource_map, state)

    registered_bp_ids = _load_registered_ids(world_dir / "world_behavior_packs.json")
    registered_rp_ids = _load_registered_ids(world_dir / "world_resource_packs.json")

    for pack in behavior_packs:
        if pack["uuid"] not in registered_bp_ids:
            warn(state, f"Behavior Pack '{pack['name']}' is installed on disk but not registered in world_behavior_packs.json")
    for pack in resource_packs:
        if pack["uuid"] not in registered_rp_ids:
            warn(state, f"Resource Pack '{pack['name']}' is installed on disk but not registered in world_resource_packs.json")

    installed_ids = {installed_pack["uuid"] for installed_pack in state.installed_packs}
    dep_warnings = {
        (
            f"'{pack['name']}' depends on UUID {dep.get('uuid', '')} "
            f"(v{dep.get('version', '?')}) which is NOT installed - "
            "it may not work correctly! Make sure the matching pack is also installed."
        )
        for pack in state.installed_packs
        for dep in pack["dependencies"]
        if dep.get("uuid") and dep.get("uuid") != pack["uuid"] and dep.get("uuid") not in installed_ids
    }
    for dep_warning in dep_warnings:
        state.warnings.append(dep_warning)

    print(f"  Installed on disk: {C.CYAN}{len(behavior_packs)}{C.RESET} BP, {C.CYAN}{len(resource_packs)}{C.RESET} RP")
    print(f"  Registered in world: {C.CYAN}{registered_bp_count}{C.RESET} BP, {C.CYAN}{registered_rp_count}{C.RESET} RP")

    if not state.warnings:
        print(f"  {C.GREEN}Audit clean.{C.RESET}")
    state.record(
        "doctor_summary",
        "Audit complete",
        behavior_packs=len(behavior_packs),
        resource_packs=len(resource_packs),
        registered_behavior_packs=registered_bp_count,
        registered_resource_packs=registered_rp_count,
        warnings=len(state.warnings),
    )
    print_warnings(state.warnings)


def do_rebuild(world_dir: Path, paths: ProjectPaths, state: AppState) -> None:
    section("Rebuild World Pack JSONs", state=state, action="rebuild")

    bp_entries = []
    rp_entries = []
    bp_count = 0
    rp_count = 0

    if paths.behavior_packs_dir.exists():
        for subfolder in sorted(paths.behavior_packs_dir.iterdir()):
            if not subfolder.is_dir():
                continue
            manifest_path = subfolder / "manifest.json"
            if not manifest_path.exists():
                warn(state, f"{paths.behavior_packs_dir.name}/{subfolder.name} has no manifest.json - skipping")
                continue
            manifest = read_manifest(manifest_path)
            if not manifest:
                continue
            uuid, version, name = get_pack_info(manifest)
            if not uuid:
                warn(state, f"{paths.behavior_packs_dir.name}/{subfolder.name} has no UUID - skipping")
                continue
            bp_entries.append({"pack_id": uuid, "version": version})
            bp_count += 1
            _print_pack_summary("bp", name, version)

    if paths.resource_packs_dir.exists():
        for subfolder in sorted(paths.resource_packs_dir.iterdir()):
            if not subfolder.is_dir():
                continue
            manifest_path = subfolder / "manifest.json"
            if not manifest_path.exists():
                warn(state, f"{paths.resource_packs_dir.name}/{subfolder.name} has no manifest.json - skipping")
                continue
            manifest = read_manifest(manifest_path)
            if not manifest:
                continue
            uuid, version, name = get_pack_info(manifest)
            if not uuid:
                warn(state, f"{paths.resource_packs_dir.name}/{subfolder.name} has no UUID - skipping")
                continue
            rp_entries.append({"pack_id": uuid, "version": version})
            rp_count += 1
            _print_pack_summary("rp", name, version)

    save_world_json(world_dir / "world_behavior_packs.json", bp_entries)
    save_world_json(world_dir / "world_resource_packs.json", rp_entries)

    print(
        f"  {C.GREEN}Done!{C.RESET} Registered {C.CYAN}{bp_count}{C.RESET} behavior pack(s) "
        f"and {C.CYAN}{rp_count}{C.RESET} resource pack(s)"
    )

    state.record(
        "rebuild_world_json",
        "Rebuilt world pack JSON files",
        world_dir=str(world_dir),
        behavior_packs=bp_count,
        resource_packs=rp_count,
        behavior_json=str(world_dir / "world_behavior_packs.json"),
        resource_json=str(world_dir / "world_resource_packs.json"),
    )
    print_warnings(state.warnings)


def _resolve_zip_name(zip_name: str | None = None) -> str:
    if zip_name:
        normalized_name = Path(zip_name).name.strip()
        if not normalized_name.lower().endswith(".zip"):
            normalized_name += ".zip"
        return normalized_name

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    return f"Bedrock_Packs_{timestamp}.zip"


def do_zip(paths: ProjectPaths, state: AppState, zip_name: str | None = None) -> None:
    zip_name = _resolve_zip_name(zip_name)
    zip_path = paths.base_dir / zip_name

    section("Zip Pack Folders", state=state, action="zip")

    folder_paths = [paths.worlds_dir, paths.behavior_packs_dir, paths.resource_packs_dir]
    file_count = 0

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for folder_path in folder_paths:
            if not folder_path.exists():
                warn(state, f"{folder_path.relative_to(paths.base_dir)}/ does not exist - skipping")
                continue
            for root, _dirs, files in os.walk(folder_path):
                for filename in files:
                    file_path = Path(root) / filename
                    zf.write(file_path, file_path.relative_to(paths.base_dir))
                    file_count += 1

    size_mb = zip_path.stat().st_size / (1024 * 1024)
    print(f"\n  {C.GREEN}Done!{C.RESET} {file_count} files zipped")
    print(f"  {C.CYAN}{zip_name}{C.RESET} ({size_mb:.1f} MB)")
    print(f"  Saved to: {zip_path}")
    state.record(
        "create_zip",
        "Created zip archive",
        zip_path=str(zip_path),
        file_count=file_count,
        size_mb=round(size_mb, 1),
    )


def do_uninstall(world_dir: Path, paths: ProjectPaths, selected_flags: set[str], state: AppState, keep_files: bool = False) -> None:
    if selected_flags:
        candidates = {candidate["flag"]: candidate for candidate in collect_uninstall_candidates(world_dir, paths)}
        unknown_flags = sorted(flag for flag in selected_flags if flag not in candidates)
        if unknown_flags:
            raise ValueError(f"Unknown uninstall selection(s): {', '.join(unknown_flags)}")
        chosen_candidates = [candidates[flag] for flag in sorted(selected_flags)]
    else:
        chosen_candidates = _collect_uninstall_queue_candidates(world_dir, paths, state)
        if not chosen_candidates:
            raise ValueError("No packs from run/uninstall matched this world's registered packs.")

    section("Uninstall Packs", state=state, action="uninstall", keep_files=keep_files)

    removed_from_world = 0
    deleted_folders = 0

    for candidate in chosen_candidates:
        print(f"\n    {C.BOLD}[{candidate['type_label']}]{C.RESET} {candidate['name']} (v{candidate['version_label']})")
        print(f"    UUID: {C.DIM}{candidate['uuid']}{C.RESET}")

        if remove_pack(candidate["world_json"], candidate["uuid"]):
            removed_from_world += 1
            ok(
                f"Removed from {candidate['world_json'].name}",
                state=state,
                action="uninstall_world_pack",
                world_json=str(candidate["world_json"]),
                uuid=candidate["uuid"],
                version=candidate["version"],
            )
        else:
            info(
                f"Already missing from {candidate['world_json'].name}",
                state=state,
                action="uninstall_world_pack",
                world_json=str(candidate["world_json"]),
                uuid=candidate["uuid"],
                version=candidate["version"],
            )

        other_worlds = _other_world_references(paths, world_dir, candidate["type"], candidate["uuid"], candidate["version"])
        if other_worlds:
            info(
                f"Kept installed files because still used by: {', '.join(other_worlds)}",
                state=state,
                action="keep_shared_pack_files",
                uuid=candidate["uuid"],
                version=candidate["version"],
                world_dir=str(world_dir),
                referenced_by=other_worlds,
            )
            state.record(
                "uninstall_pack",
                "Removed pack from world but kept shared files",
                uuid=candidate["uuid"],
                version=candidate["version"],
                pack_type=candidate["type"],
                removed_paths=[],
                referenced_by=other_worlds,
            )
            continue

        if not candidate["installed_paths"]:
            info(
                "No matching installed pack files found on disk",
                state=state,
                action="uninstall_missing_pack_files",
                uuid=candidate["uuid"],
                version=candidate["version"],
                pack_type=candidate["type"],
            )
            state.record(
                "uninstall_pack",
                "Removed stale pack registration",
                uuid=candidate["uuid"],
                version=candidate["version"],
                pack_type=candidate["type"],
                removed_paths=[],
                referenced_by=[],
                keep_files=False,
            )
            continue

        if keep_files:
            installed_paths = [str(installed_path) for installed_path in candidate["installed_paths"]]
            info(
                "Kept installed pack files on disk",
                state=state,
                action="keep_uninstall_pack_files",
                uuid=candidate["uuid"],
                version=candidate["version"],
                pack_type=candidate["type"],
                installed_paths=installed_paths,
            )
            state.record(
                "uninstall_pack",
                "Removed pack from world JSON and kept disk files",
                uuid=candidate["uuid"],
                version=candidate["version"],
                pack_type=candidate["type"],
                removed_paths=[],
                kept_paths=installed_paths,
                referenced_by=[],
                keep_files=True,
            )
            continue

        removed_paths = []
        for installed_path in candidate["installed_paths"]:
            shutil.rmtree(installed_path)
            removed_paths.append(str(installed_path))
            deleted_folders += 1
            ok(
                f"Deleted {display_path(installed_path)}",
                state=state,
                action="delete_installed_pack",
                uuid=candidate["uuid"],
                version=candidate["version"],
                pack_type=candidate["type"],
                deleted_path=str(installed_path),
            )

        state.record(
            "uninstall_pack",
            "Removed pack from world and disk",
            uuid=candidate["uuid"],
            version=candidate["version"],
            pack_type=candidate["type"],
            removed_paths=removed_paths,
            referenced_by=[],
            keep_files=False,
        )

    print(f"\n  {C.GREEN}Done!{C.RESET} Removed {C.CYAN}{removed_from_world}{C.RESET} pack(s) from '{C.CYAN}{world_dir.name}{C.RESET}'")
    if keep_files:
        print("  Kept installed pack folders on disk")
    else:
        print(f"  Deleted {C.CYAN}{deleted_folders}{C.RESET} installed folder(s)")


def do_beta(world_dir: Path, state: AppState | None = None) -> None:
    dat_path = world_dir / "level.dat"
    if not dat_path.exists():
        print(f"  {C.YELLOW}[WARNING]{C.RESET} No level.dat found in '{world_dir.name}' - skipping beta toggle")
        if state is not None:
            state.record("beta_toggle", "Skipped beta toggle because level.dat is missing", world_dir=str(world_dir), changed=False)
        return

    try:
        import nbtlib  # noqa: F401
    except ImportError:
        error("nbtlib is required. Install it with: pip install nbtlib", state=state, action="beta_toggle", world_dir=str(world_dir), changed=False)
        return

    section("Enable Beta APIs", state=state, action="beta")

    if not enable_beta_apis(dat_path):
        print(f"\n  Beta APIs already {C.GREEN}enabled{C.RESET} for '{world_dir.name}'")
        if state is not None:
            state.record("beta_toggle", "Beta APIs already enabled", world_dir=str(world_dir), changed=False)
        return

    info("Backup saved as level.dat.backup", state=state, action="beta_backup", backup_path=str(dat_path.with_name("level.dat.backup")))

    print(f"\n  {C.GREEN}Done!{C.RESET} Beta APIs enabled for '{C.CYAN}{world_dir.name}{C.RESET}'")
    if state is not None:
        state.record("beta_toggle", "Enabled beta APIs", world_dir=str(world_dir), changed=True)


def do_set_gamemode(world_dir: Path, gamemode: str, state: AppState | None = None) -> None:
    dat_path = world_dir / "level.dat"
    if not dat_path.exists():
        print(f"  {C.YELLOW}[WARNING]{C.RESET} No level.dat found in '{world_dir.name}' - skipping gamemode update")
        if state is not None:
            state.record("set_gamemode", "Skipped gamemode update because level.dat is missing", world_dir=str(world_dir), gamemode=gamemode, changed=False)
        return

    try:
        import nbtlib  # noqa: F401
    except ImportError:
        error("nbtlib is required. Install it with: pip install nbtlib", state=state, action="set_gamemode", world_dir=str(world_dir), gamemode=gamemode, changed=False)
        return

    gamemode_label = GAMEMODE_LABELS[gamemode]
    section(f"Set World Gamemode: {gamemode_label}", state=state, action="set_gamemode_section", gamemode=gamemode)

    if not set_world_gamemode(dat_path, gamemode):
        print(f"\n  World gamemode already set to {C.GREEN}{gamemode_label}{C.RESET} for '{world_dir.name}'")
        if state is not None:
            state.record("set_gamemode", "World gamemode already set", world_dir=str(world_dir), gamemode=gamemode, changed=False)
        return

    info("Backup saved as level.dat.backup", state=state, action="gamemode_backup", backup_path=str(dat_path.with_name("level.dat.backup")))

    print(f"\n  {C.GREEN}Done!{C.RESET} World gamemode set to {C.CYAN}{gamemode_label}{C.RESET} for '{C.CYAN}{world_dir.name}{C.RESET}'")
    if state is not None:
        state.record("set_gamemode", "Updated world gamemode", world_dir=str(world_dir), gamemode=gamemode, changed=True)


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


def run(flags: set[str], world_dir: Path | None, paths: ProjectPaths, state: AppState, duplicate_mode: DuplicateMode = "replace") -> None:
    if not flags:
        do_install(world_dir, paths, state, duplicate_mode=duplicate_mode)
        return

    if "--doctor" in flags:
        do_doctor(world_dir, paths, state)

    if "--uninstall" in flags:
        do_uninstall(world_dir, paths, _selected_uninstall_flags(flags), state, keep_files=_keep_uninstall_files(flags))

    if "--rebuild" in flags:
        do_rebuild(world_dir, paths, state)

    if "--beta" in flags:
        do_beta(world_dir, state)

    gamemode = _selected_gamemode(flags)
    if gamemode is not None:
        do_set_gamemode(world_dir, gamemode, state)

    if "--zip" in flags:
        do_zip(paths, state, zip_name=_selected_zip_name(flags))
