import os
import shutil
import zipfile
from pathlib import Path
from typing import Literal

from .console import AppState, C, display_path, info, ok, print_warnings, section, warn
from .constants import ARCHIVE_EXTS
from .manifests import classify_pack, get_pack_dependencies, get_pack_info, read_manifest
from .paths import ProjectPaths
from .worlds import (
    load_world_json,
    save_world_json,
    upsert_pack,
)

DuplicateMode = Literal["skip", "replace", "keep-both"]


def extract_archive(archive_path: Path, dest: Path) -> Path:
    extract_to = dest / f"_extracted_{archive_path.stem}"
    if extract_to.exists():
        shutil.rmtree(extract_to)
    with zipfile.ZipFile(archive_path, "r") as zf:
        zf.extractall(extract_to)
    return extract_to


def extract_nested_archives(folder: Path, state: AppState) -> bool:
    found_nested = False
    for file_path in list(folder.rglob("*")):
        if file_path.is_file() and file_path.suffix.lower() in ARCHIVE_EXTS:
            found_nested = True
            info(f"Found nested archive: {file_path.name} - extracting")
            try:
                nested_dest = file_path.parent / f"_nested_{file_path.stem}"
                with zipfile.ZipFile(file_path, "r") as zf:
                    zf.extractall(nested_dest)
                file_path.unlink()
            except zipfile.BadZipFile:
                warn(state, f"Nested file {file_path.name} is not a valid archive, skipping it")
    return found_nested


def find_all_packs(folder: Path) -> list[Path]:
    packs = []
    for root, _dirs, files in os.walk(folder):
        if "manifest.json" in files:
            packs.append(Path(root))
    return packs


def move_pack(pack_folder: Path, dest_dir: Path, pack_name: str, pack_type: str) -> Path:
    safe_name = "".join(char if char.isalnum() or char in " -_" else "" for char in pack_name).strip()
    if not safe_name:
        safe_name = pack_folder.name
    suffix = "-BP" if pack_type == "bp" else "-RP"
    if not safe_name.upper().endswith(("-BP", "-RP", "-BH", "-RS", "-BEH", "-RES")):
        safe_name += suffix

    target = dest_dir / safe_name
    counter = 2
    original_target = target
    while target.exists():
        target = dest_dir / f"{original_target.name}_{counter}"
        counter += 1

    shutil.copytree(pack_folder, target)
    return target


def find_packs_on_disk(dest_dir: Path, uuid: str) -> list[dict]:
    if not dest_dir.exists():
        return []

    matches = []
    for subfolder in dest_dir.iterdir():
        if not subfolder.is_dir():
            continue
        manifest_path = subfolder / "manifest.json"
        if not manifest_path.exists():
            continue
        manifest = read_manifest(manifest_path)
        if not manifest:
            continue
        existing_uuid, existing_version, existing_name = get_pack_info(manifest)
        if existing_uuid != uuid:
            continue
        matches.append({"path": subfolder, "version": existing_version, "name": existing_name})

    return sorted(matches, key=lambda match: match["path"].name.lower())


def pack_exists_on_disk(dest_dir: Path, uuid: str) -> bool:
    return bool(find_packs_on_disk(dest_dir, uuid))


def _format_version(version: list) -> str:
    return ".".join(str(value) for value in version)


def _record_installed_pack(
    state: AppState,
    uuid: str,
    name: str,
    pack_type: str,
    version: list,
    deps: list[dict],
    source_name: str,
) -> None:
    state.installed_packs.append(
        {
            "uuid": uuid,
            "name": name,
            "type": pack_type,
            "version": version,
            "dependencies": deps,
            "source": source_name,
        }
    )


def _sync_world_registration(world_json: Path, uuid: str, version: list) -> str:
    action = upsert_pack(world_json, uuid, version)
    if action == "added":
        ok(f"Registered in {world_json.name}")
    elif action == "updated":
        info(f"Updated {world_json.name} to v{_format_version(version)}")
    return action


def _remove_existing_packs(existing_packs: list[dict]) -> None:
    for existing_pack in existing_packs:
        shutil.rmtree(existing_pack["path"])


def process_pack(
    pack_folder: Path,
    stats: dict,
    world_dir: Path,
    paths: ProjectPaths,
    state: AppState,
    duplicate_mode: DuplicateMode = "replace",
    source_name: str = "",
) -> None:
    manifest_path = pack_folder / "manifest.json"
    if not manifest_path.exists():
        warn(state, f"Folder '{pack_folder.name}' has no manifest.json - not a valid pack")
        stats["errors"] += 1
        return

    manifest = read_manifest(manifest_path)
    if not manifest:
        stats["errors"] += 1
        return

    pack_type = classify_pack(manifest)
    uuid, version, name = get_pack_info(manifest)
    deps = get_pack_dependencies(manifest)

    if not pack_type:
        modules = manifest.get("modules", [])
        types = [module.get("type", "???") for module in modules]
        warn(state, f"Cannot determine type for '{name}' (module types: {types}) - skipping")
        stats["errors"] += 1
        return

    if not uuid:
        warn(state, f"Pack '{name}' has no UUID in manifest - skipping (broken pack?)")
        stats["errors"] += 1
        return

    fmt_ver = manifest.get("format_version")
    if fmt_ver is None:
        warn(state, f"Pack '{name}' is missing format_version - may be an old/broken pack")
    elif fmt_ver < 2:
        warn(state, f"Pack '{name}' uses format_version {fmt_ver} (old format, may have issues)")

    if any("beta" in str(dep.get("version", "")) for dep in manifest.get("dependencies", [])):
        warn(state, f"Pack '{name}' uses beta API versions - run with --beta to enable experiments")

    type_label = "Behavior Pack" if pack_type == "bp" else "Resource Pack"
    dest_dir = paths.behavior_packs_dir if pack_type == "bp" else paths.resource_packs_dir
    world_json = world_dir / (
        "world_behavior_packs.json" if pack_type == "bp" else "world_resource_packs.json"
    )
    ver_str = _format_version(version)

    print(f"\n    {C.BOLD}[{type_label}]{C.RESET} {name} (v{ver_str})")
    print(f"    UUID: {C.DIM}{uuid}{C.RESET}")

    existing_packs = find_packs_on_disk(dest_dir, uuid)
    matching_version_packs = [existing_pack for existing_pack in existing_packs if existing_pack["version"] == version]

    if matching_version_packs:
        registration_action = _sync_world_registration(world_json, uuid, version)
        if registration_action == "added":
            info("Matching pack already installed on disk - registered without copying")
            stats["installed"] += 1
            _record_installed_pack(state, uuid, name, pack_type, version, deps, source_name)
            return
        if registration_action == "updated":
            info("Matching pack already installed on disk - updated registration without copying")
            stats["installed"] += 1
            _record_installed_pack(state, uuid, name, pack_type, version, deps, source_name)
            return
        info("Matching UUID and version already installed - skipping")
        stats["skipped"] += 1
        return

    if existing_packs and duplicate_mode == "skip":
        existing_versions = ", ".join(_format_version(existing_pack["version"]) for existing_pack in existing_packs)
        warn(
            state,
            f"Pack '{name}' already exists on disk with UUID {uuid} (installed: {existing_versions}) - skipping incoming v{ver_str}",
        )
        stats["skipped"] += 1
        return

    if existing_packs and duplicate_mode == "replace":
        info(f"Replacing {len(existing_packs)} existing pack copy/copies for UUID {uuid}")
        _remove_existing_packs(existing_packs)
    elif existing_packs and duplicate_mode == "keep-both":
        info(f"Keeping {len(existing_packs)} existing pack copy/copies for UUID {uuid}")

    final_path = move_pack(pack_folder, dest_dir, name, pack_type)
    ok(f"Copied to {final_path.relative_to(paths.base_dir)}")
    registration_action = _sync_world_registration(world_json, uuid, version)
    if existing_packs and registration_action == "unchanged":
        info(f"{world_json.name} already references v{ver_str}")

    stats["installed"] += 1
    _record_installed_pack(state, uuid, name, pack_type, version, deps, source_name)


def move_to_installed(entry: Path, paths: ProjectPaths) -> None:
    paths.installed_dir.mkdir(exist_ok=True)
    target = paths.installed_dir / entry.name
    counter = 2
    original = target
    while target.exists():
        stem = original.stem if original.is_file() else original.name
        suffix = original.suffix if original.is_file() else ""
        target = paths.installed_dir / f"{stem}_{counter}{suffix}"
        counter += 1
    shutil.move(str(entry), str(target))


def process_entry(
    entry: Path,
    stats: dict,
    world_dir: Path,
    paths: ProjectPaths,
    state: AppState,
    duplicate_mode: DuplicateMode = "replace",
) -> None:
    print(f"\n{C.BOLD}>> {entry.name}{C.RESET}")

    if entry.is_file() and entry.suffix.lower() not in ARCHIVE_EXTS:
        warn(
            state,
            f"Unknown file type '{entry.suffix}' for '{entry.name}' - "
            f"only {', '.join(sorted(ARCHIVE_EXTS))} are supported",
        )
        stats["errors"] += 1
        return

    if entry.is_file() and entry.suffix.lower() in ARCHIVE_EXTS:
        try:
            extracted = extract_archive(entry, paths.install_dir)
        except zipfile.BadZipFile:
            warn(state, f"'{entry.name}' is not a valid zip archive - file may be corrupt")
            stats["errors"] += 1
            return
        except Exception as exc:
            warn(state, f"Failed to extract '{entry.name}': {exc}")
            stats["errors"] += 1
            return

        extract_nested_archives(extracted, state)

        packs = find_all_packs(extracted)
        if not packs:
            warn(
                state,
                f"No manifest.json found anywhere inside '{entry.name}' - "
                f"archive may not be a valid Minecraft pack",
            )
            stats["errors"] += 1
            shutil.rmtree(extracted, ignore_errors=True)
            return

        info(f"Found {len(packs)} pack(s) inside")

        if entry.suffix.lower() == ".mcpack" and len(packs) > 1:
            warn(state, f"'{entry.name}' is a .mcpack but contains {len(packs)} packs - unusual, processing all")

        if entry.suffix.lower() == ".mcaddon" and len(packs) == 1:
            pack_manifest = read_manifest(packs[0] / "manifest.json")
            if pack_manifest:
                pack_type = classify_pack(pack_manifest)
                missing = "Resource Pack" if pack_type == "bp" else "Behavior Pack"
                warn(
                    state,
                    f"'{entry.name}' is an .mcaddon but only contains 1 pack - "
                    f"might be missing its {missing}",
                )

        for pack in packs:
            process_pack(pack, stats, world_dir, paths, state, duplicate_mode=duplicate_mode, source_name=entry.name)

        shutil.rmtree(extracted, ignore_errors=True)
        move_to_installed(entry, paths)
        return

    if entry.is_dir() and not entry.name.startswith("_extracted_"):
        packs = find_all_packs(entry)
        if not packs:
            warn(state, f"Folder '{entry.name}' contains no manifest.json - not a valid pack or addon")
            stats["errors"] += 1
            return

        if len(packs) == 1 and packs[0] == entry:
            process_pack(entry, stats, world_dir, paths, state, duplicate_mode=duplicate_mode, source_name=entry.name)
        else:
            info(f"Found {len(packs)} pack(s) inside folder")
            for pack in packs:
                process_pack(pack, stats, world_dir, paths, state, duplicate_mode=duplicate_mode, source_name=entry.name)

        move_to_installed(entry, paths)


def check_dependencies(world_dir: Path, paths: ProjectPaths, state: AppState) -> list[str]:
    known_uuids = set()

    for name in ["world_behavior_packs.json", "world_resource_packs.json"]:
        for pack in load_world_json(world_dir / name):
            known_uuids.add(pack.get("pack_id", ""))

    for pack_dir in [paths.behavior_packs_dir, paths.resource_packs_dir]:
        if pack_dir.exists():
            for subfolder in pack_dir.iterdir():
                manifest_path = subfolder / "manifest.json"
                if manifest_path.exists():
                    manifest = read_manifest(manifest_path)
                    if manifest:
                        uuid, _, _ = get_pack_info(manifest)
                        if uuid:
                            known_uuids.add(uuid)

    dep_warnings = []
    for pack in state.installed_packs:
        for dep in pack["dependencies"]:
            dep_uuid = dep.get("uuid", "")
            if dep_uuid == pack["uuid"]:
                continue
            if dep_uuid and dep_uuid not in known_uuids:
                dep_ver = dep.get("version", "?")
                dep_warnings.append(
                    f"'{pack['name']}' depends on UUID {dep_uuid} (v{dep_ver}) "
                    f"which is NOT installed - it may not work correctly! "
                    f"Make sure the matching pack is also installed."
                )

    return dep_warnings


def do_install(world_dir: Path, paths: ProjectPaths, state: AppState, duplicate_mode: DuplicateMode = "replace") -> None:
    section("Install Packs")

    for directory in [paths.install_dir, paths.behavior_packs_dir, paths.resource_packs_dir]:
        directory.mkdir(parents=True, exist_ok=True)

    for name in ["world_behavior_packs.json", "world_resource_packs.json"]:
        world_json = world_dir / name
        if not world_json.exists():
            warn(state, f"{name} does not exist - will be created")
            save_world_json(world_json, [])

    entries = sorted(
        entry
        for entry in paths.install_dir.iterdir()
        if not entry.name.startswith("_extracted_") and not entry.name.startswith(".")
    )

    if not entries:
        print("\n  No files found in the install folder.")
        print("  Drop .mcaddon, .mcpack, .zip files or folders into:")
        print(f"    {C.CYAN}{display_path(paths.install_dir)}{C.RESET}")
        return

    print(f"\n  Found {len(entries)} item(s) in install folder")

    stats = {"installed": 0, "skipped": 0, "errors": 0}
    for entry in entries:
        process_entry(entry, stats, world_dir, paths, state, duplicate_mode=duplicate_mode)

    for dep_warning in check_dependencies(world_dir, paths, state):
        state.warnings.append(dep_warning)

    if stats["errors"] == 0 and not state.warnings:
        print(f"  {C.GREEN}Done! All clean.{C.RESET}")
    else:
        print(f"  {C.BOLD}Done!{C.RESET}")

    print(
        f"  Installed: {C.GREEN}{stats['installed']}{C.RESET}  "
        f"Skipped: {stats['skipped']}  "
        f"Warnings: {C.YELLOW}{len(state.warnings)}{C.RESET}  "
        f"Errors: {C.RED}{stats['errors']}{C.RESET}"
    )

    bp_count = len(load_world_json(world_dir / "world_behavior_packs.json"))
    rp_count = len(load_world_json(world_dir / "world_resource_packs.json"))
    print(
        f"\n  World now has {C.CYAN}{bp_count}{C.RESET} behavior pack(s) "
        f"and {C.CYAN}{rp_count}{C.RESET} resource pack(s)"
    )

    print_warnings(state.warnings)
