import os
import zipfile
from datetime import datetime
from pathlib import Path

from .console import AppState, C, error, info, print_warnings, section, warn
from .install import DuplicateMode, do_install
from .manifests import get_pack_dependencies, get_pack_info, read_manifest
from .nbt import enable_beta_apis
from .paths import ProjectPaths
from .worlds import load_world_json, save_world_json


def _load_registered_ids(world_json: Path) -> set[str]:
    if not world_json.exists():
        return set()
    return {entry.get("pack_id", "") for entry in load_world_json(world_json)}


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
            print(f"  {C.GREEN}[BP]{C.RESET} {name} (v{'.'.join(str(v) for v in version)})")

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
            print(f"  {C.CYAN}[RP]{C.RESET} {name} (v{'.'.join(str(v) for v in version)})")

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


def do_zip(paths: ProjectPaths, state: AppState) -> None:
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    zip_name = f"Bedrock_Packs_{timestamp}.zip"
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


def run(flags: set[str], world_dir: Path | None, paths: ProjectPaths, state: AppState, duplicate_mode: DuplicateMode = "replace") -> None:
    if not flags:
        do_install(world_dir, paths, state, duplicate_mode=duplicate_mode)
        return

    if "--doctor" in flags:
        do_doctor(world_dir, paths, state)

    if "--rebuild" in flags:
        do_rebuild(world_dir, paths, state)

    if "--beta" in flags:
        do_beta(world_dir, state)

    if "--zip" in flags:
        do_zip(paths, state)
