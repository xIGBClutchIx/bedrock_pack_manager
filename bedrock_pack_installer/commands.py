import os
import zipfile
from datetime import datetime
from pathlib import Path

from .console import AppState, C, error, info, print_warnings, section, warn
from .install import do_install
from .manifests import get_pack_info, read_manifest
from .nbt import enable_beta_apis
from .paths import ProjectPaths
from .worlds import save_world_json


def do_rebuild(world_dir: Path, paths: ProjectPaths, state: AppState) -> None:
    section("Rebuild World Pack JSONs")

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

    print_warnings(state.warnings)


def do_zip(paths: ProjectPaths, state: AppState) -> None:
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    zip_name = f"Bedrock_Packs_{timestamp}.zip"
    zip_path = paths.base_dir / zip_name

    section("Zip Pack Folders")

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


def do_beta(world_dir: Path) -> None:
    dat_path = world_dir / "level.dat"
    if not dat_path.exists():
        print(f"  {C.YELLOW}[WARNING]{C.RESET} No level.dat found in '{world_dir.name}' - skipping beta toggle")
        return

    try:
        import nbtlib  # noqa: F401
    except ImportError:
        error("nbtlib is required. Install it with: pip install nbtlib")
        return

    section("Enable Beta APIs")

    if not enable_beta_apis(dat_path):
        print(f"\n  Beta APIs already {C.GREEN}enabled{C.RESET} for '{world_dir.name}'")
        return

    info("Backup saved as level.dat.backup")

    print(f"\n  {C.GREEN}Done!{C.RESET} Beta APIs enabled for '{C.CYAN}{world_dir.name}{C.RESET}'")


def run(flags: set[str], world_dir: Path | None, paths: ProjectPaths, state: AppState) -> None:
    if not flags:
        do_install(world_dir, paths, state)
        return

    if "--rebuild" in flags:
        do_rebuild(world_dir, paths, state)

    if "--beta" in flags:
        do_beta(world_dir)

    if "--zip" in flags:
        do_zip(paths, state)
