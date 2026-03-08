#!/usr/bin/env python3
"""
Minecraft Bedrock Pack Installer
---------------------------------
Drop .mcaddon, .mcpack, or .zip files (or already-extracted folders) into
the 'install' folder, then run this script.

It will:
  1. Extract any archive files (handles nested .mcpack inside .mcaddon)
  2. Detect pack type (behavior vs resource) from manifest.json
  3. Move each pack folder into behavior_packs/ or resource_packs/
  4. Register each pack in the world's JSON files
  5. Warn about missing dependencies, bad files, version issues
  6. Move processed files from install/ to installed/

Usage (flags can be combined):
  python bedrock_pack_installer.py                    # Install new packs from install/
  python bedrock_pack_installer.py --rebuild          # Rebuild world JSONs from existing packs
  python bedrock_pack_installer.py --zip              # Zip worlds/, behavior_packs/, resource_packs/
  python bedrock_pack_installer.py --beta             # Enable Beta APIs in a world's level.dat
  python bedrock_pack_installer.py --rebuild --beta   # Rebuild JSONs then enable beta APIs
"""

import json
import os
import re
import shutil
import sys
import zipfile
from pathlib import Path

# Force UTF-8 output so Minecraft § codes and non-Latin chars don't crash on Windows
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent
INSTALL_DIR = BASE_DIR / "install"
BP_DIR = BASE_DIR / "behavior_packs"
RP_DIR = BASE_DIR / "resource_packs"
WORLDS_DIR = BASE_DIR / "worlds"
INSTALLED_DIR = BASE_DIR / "installed"

# Archive extensions we handle
ARCHIVE_EXTS = {".mcaddon", ".mcpack", ".zip"}

# Pack module types that indicate behavior vs resource
BP_TYPES = {"data", "script", "client_data"}
RP_TYPES = {"resources"}

# Colors for terminal output
class C:
    RED = "\033[91m"
    YELLOW = "\033[93m"
    GREEN = "\033[92m"
    CYAN = "\033[96m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RESET = "\033[0m"


def strip_mc_formatting(text: str) -> str:
    """Strip Minecraft § color/formatting codes from text (e.g. §b, §7, §o)."""
    return re.sub(r"§.", "", text)


# ── Tracking ─────────────────────────────────────────────────────────────────
warnings = []   # Collected warnings to display at the end
installed_packs = []  # Track what we installed for dependency check


def warn(msg):
    """Add a warning to be displayed in the summary."""
    warnings.append(msg)
    print(f"  {C.YELLOW}[WARNING]{C.RESET} {msg}")


def error(msg):
    print(f"  {C.RED}[ERROR]{C.RESET} {msg}")


def ok(msg):
    print(f"  {C.GREEN}[OK]{C.RESET} {msg}")


def info(msg):
    print(f"  {C.CYAN}[INFO]{C.RESET} {msg}")


# ── World Selection ──────────────────────────────────────────────────────────

def select_world() -> Path:
    """Find worlds and let the user pick one. Auto-selects if only one exists."""
    if not WORLDS_DIR.exists():
        WORLDS_DIR.mkdir(parents=True, exist_ok=True)

    worlds = sorted([
        d for d in WORLDS_DIR.iterdir()
        if d.is_dir() and not d.name.startswith(".")
    ])

    if not worlds:
        print(f"\n  {C.RED}No worlds found in worlds/ folder.{C.RESET}")
        sys.exit(1)

    if len(worlds) == 1:
        print(f"\n  World: {C.CYAN}{worlds[0].name}{C.RESET}")
        return worlds[0]

    print(f"\n  Found {len(worlds)} world(s):\n")
    for i, w in enumerate(worlds, 1):
        # Show extra info if level.dat or pack JSONs exist
        extras = []
        if (w / "level.dat").exists():
            extras.append("level.dat")
        bp_json = w / "world_behavior_packs.json"
        rp_json = w / "world_resource_packs.json"
        if bp_json.exists():
            bp_count = len(load_world_json(bp_json))
            extras.append(f"{bp_count} BP")
        if rp_json.exists():
            rp_count = len(load_world_json(rp_json))
            extras.append(f"{rp_count} RP")
        extra_str = f" {C.DIM}({', '.join(extras)}){C.RESET}" if extras else ""
        print(f"    {C.BOLD}{i}.{C.RESET} {w.name}{extra_str}")

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


# ── Helpers ──────────────────────────────────────────────────────────────────

def read_manifest(manifest_path: Path) -> dict | None:
    try:
        with open(manifest_path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        error(f"Corrupt manifest.json in {manifest_path.parent.name}: {e}")
        return None
    except OSError as e:
        error(f"Can't read {manifest_path}: {e}")
        return None


def classify_pack(manifest: dict) -> str | None:
    """Return 'bp' or 'rp' based on the module types in the manifest."""
    modules = manifest.get("modules", [])
    types = {m.get("type", "").lower() for m in modules}

    if types & BP_TYPES:
        return "bp"
    if types & RP_TYPES:
        return "rp"
    return None


def get_pack_info(manifest: dict) -> tuple[str, list, str]:
    """Extract (uuid, version, name) from manifest header."""
    header = manifest.get("header", {})
    uuid = header.get("uuid", "")
    version = header.get("version", [0, 0, 0])
    name = strip_mc_formatting(header.get("name", "unknown"))
    return uuid, version, name


def get_pack_dependencies(manifest: dict) -> list[dict]:
    """Get UUID-based dependencies (not @minecraft/ module deps)."""
    deps = manifest.get("dependencies", [])
    return [d for d in deps if "uuid" in d and "module_name" not in d]


def load_world_json(path: Path) -> list:
    if not path.exists():
        return []
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def save_world_json(path: Path, data: list):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def is_already_registered(world_packs: list, uuid: str) -> bool:
    return any(p.get("pack_id") == uuid for p in world_packs)


def register_pack(world_json_path: Path, uuid: str, version: list) -> bool:
    """Add a pack entry to the world JSON if not already present."""
    packs = load_world_json(world_json_path)
    if is_already_registered(packs, uuid):
        return False
    packs.append({"pack_id": uuid, "version": version})
    save_world_json(world_json_path, packs)
    return True


def extract_archive(archive_path: Path, dest: Path) -> Path:
    """Extract a zip/mcaddon/mcpack to a temp folder and return the path."""
    extract_to = dest / f"_extracted_{archive_path.stem}"
    if extract_to.exists():
        shutil.rmtree(extract_to)
    with zipfile.ZipFile(archive_path, "r") as zf:
        zf.extractall(extract_to)
    return extract_to


def extract_nested_archives(folder: Path):
    """
    Some .mcaddon files contain .mcpack files inside instead of plain folders.
    Find and extract any nested archives in-place.
    """
    found_nested = False
    for f in list(folder.rglob("*")):
        if f.is_file() and f.suffix.lower() in ARCHIVE_EXTS:
            found_nested = True
            info(f"Found nested archive: {f.name} — extracting")
            try:
                nested_dest = f.parent / f"_nested_{f.stem}"
                with zipfile.ZipFile(f, "r") as zf:
                    zf.extractall(nested_dest)
                f.unlink()
            except zipfile.BadZipFile:
                warn(f"Nested file {f.name} is not a valid archive, skipping it")
    return found_nested


def find_all_packs(folder: Path) -> list[Path]:
    """
    Find all pack roots (directories containing manifest.json).
    Handles any nesting depth — addon with BP/RP subfolders, single pack, etc.
    """
    packs = []
    for root, _dirs, files in os.walk(folder):
        if "manifest.json" in files:
            packs.append(Path(root))
    return packs


def move_pack(pack_folder: Path, dest_dir: Path, pack_name: str, pack_type: str) -> Path:
    """Move a pack folder to dest_dir with a descriptive folder name."""
    safe_name = "".join(c if c.isalnum() or c in " -_" else "" for c in pack_name).strip()
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


# ── Core Processing ──────────────────────────────────────────────────────────

def process_pack(pack_folder: Path, stats: dict, world_dir: Path, source_name: str = ""):
    """Process a single pack folder: classify, move, register."""
    manifest_path = pack_folder / "manifest.json"
    if not manifest_path.exists():
        warn(f"Folder '{pack_folder.name}' has no manifest.json — not a valid pack")
        stats["errors"] += 1
        return

    manifest = read_manifest(manifest_path)
    if not manifest:
        stats["errors"] += 1
        return

    pack_type = classify_pack(manifest)
    uuid, version, name = get_pack_info(manifest)
    deps = get_pack_dependencies(manifest)

    # ── Validation warnings ──────────────────────────────────────────────

    if not pack_type:
        modules = manifest.get("modules", [])
        types = [m.get("type", "???") for m in modules]
        warn(f"Cannot determine type for '{name}' (module types: {types}) — skipping")
        stats["errors"] += 1
        return

    if not uuid:
        warn(f"Pack '{name}' has no UUID in manifest — skipping (broken pack?)")
        stats["errors"] += 1
        return

    # Check for format_version
    fmt_ver = manifest.get("format_version")
    if fmt_ver is None:
        warn(f"Pack '{name}' is missing format_version — may be an old/broken pack")
    elif fmt_ver < 2:
        warn(f"Pack '{name}' uses format_version {fmt_ver} (old format, may have issues)")

    # Check for beta API deps
    if any("beta" in str(d.get("version", "")) for d in manifest.get("dependencies", [])):
        warn(f"Pack '{name}' uses beta API versions — run with --beta to enable experiments")

    type_label = "Behavior Pack" if pack_type == "bp" else "Resource Pack"
    dest_dir = BP_DIR if pack_type == "bp" else RP_DIR
    world_json = world_dir / ("world_behavior_packs.json" if pack_type == "bp" else "world_resource_packs.json")
    ver_str = ".".join(str(v) for v in version)

    print(f"\n    {C.BOLD}[{type_label}]{C.RESET} {name} (v{ver_str})")
    print(f"    UUID: {C.DIM}{uuid}{C.RESET}")

    # Check if already registered
    world_packs = load_world_json(world_json)
    if is_already_registered(world_packs, uuid):
        info("Already registered in world — skipping")
        stats["skipped"] += 1
        return

    # Move pack folder
    final_path = move_pack(pack_folder, dest_dir, name, pack_type)
    ok(f"Copied to {final_path.relative_to(BASE_DIR)}")

    # Register in world JSON
    register_pack(world_json, uuid, version)
    ok(f"Registered in {world_json.name}")
    stats["installed"] += 1

    # Track for dependency check later
    installed_packs.append({
        "uuid": uuid,
        "name": name,
        "type": pack_type,
        "version": version,
        "dependencies": deps,
        "source": source_name,
    })


def move_to_installed(entry: Path):
    """Move a processed file or folder from install/ to installed/."""
    INSTALLED_DIR.mkdir(exist_ok=True)
    target = INSTALLED_DIR / entry.name
    counter = 2
    original = target
    while target.exists():
        stem = original.stem if original.is_file() else original.name
        suffix = original.suffix if original.is_file() else ""
        target = INSTALLED_DIR / f"{stem}_{counter}{suffix}"
        counter += 1
    shutil.move(str(entry), str(target))


def process_entry(entry: Path, stats: dict, world_dir: Path):
    """Process a single file or folder from the install directory."""
    print(f"\n{C.BOLD}>> {entry.name}{C.RESET}")

    # ── Handle unknown file types ────────────────────────────────────────
    if entry.is_file() and entry.suffix.lower() not in ARCHIVE_EXTS:
        warn(f"Unknown file type '{entry.suffix}' for '{entry.name}' — "
             f"only {', '.join(sorted(ARCHIVE_EXTS))} are supported")
        stats["errors"] += 1
        return

    # ── Handle archive files ─────────────────────────────────────────────
    if entry.is_file() and entry.suffix.lower() in ARCHIVE_EXTS:
        try:
            extracted = extract_archive(entry, INSTALL_DIR)
        except zipfile.BadZipFile:
            warn(f"'{entry.name}' is not a valid zip archive — file may be corrupt")
            stats["errors"] += 1
            return
        except Exception as e:
            warn(f"Failed to extract '{entry.name}': {e}")
            stats["errors"] += 1
            return

        # Handle nested archives (.mcaddon containing .mcpack files)
        extract_nested_archives(extracted)

        # Find all packs inside
        packs = find_all_packs(extracted)
        if not packs:
            warn(f"No manifest.json found anywhere inside '{entry.name}' — "
                 f"archive may not be a valid Minecraft pack")
            stats["errors"] += 1
            shutil.rmtree(extracted, ignore_errors=True)
            return

        info(f"Found {len(packs)} pack(s) inside")

        # Flag if an .mcpack has multiple packs (unusual)
        if entry.suffix.lower() == ".mcpack" and len(packs) > 1:
            warn(f"'{entry.name}' is a .mcpack but contains {len(packs)} packs — unusual, processing all")

        # Flag if an .mcaddon only has 1 pack (expected to have BP+RP)
        if entry.suffix.lower() == ".mcaddon" and len(packs) == 1:
            pack_manifest = read_manifest(packs[0] / "manifest.json")
            if pack_manifest:
                pt = classify_pack(pack_manifest)
                missing = "Resource Pack" if pt == "bp" else "Behavior Pack"
                warn(f"'{entry.name}' is an .mcaddon but only contains 1 pack — "
                     f"might be missing its {missing}")

        for pack in packs:
            process_pack(pack, stats, world_dir, source_name=entry.name)

        # Clean up temp extraction folder, move original to installed/
        shutil.rmtree(extracted, ignore_errors=True)
        move_to_installed(entry)

    # ── Handle already-extracted folders ──────────────────────────────────
    elif entry.is_dir() and not entry.name.startswith("_extracted_"):
        packs = find_all_packs(entry)
        if not packs:
            warn(f"Folder '{entry.name}' contains no manifest.json — not a valid pack or addon")
            stats["errors"] += 1
            return

        if len(packs) == 1 and packs[0] == entry:
            process_pack(entry, stats, world_dir, source_name=entry.name)
        else:
            info(f"Found {len(packs)} pack(s) inside folder")
            for pack in packs:
                process_pack(pack, stats, world_dir, source_name=entry.name)

        move_to_installed(entry)


# ── Dependency Check ─────────────────────────────────────────────────────────

def check_dependencies(world_dir: Path):
    """
    After all packs are installed, check that every UUID dependency is
    satisfied by either a newly installed pack or an already-registered one.
    """
    known_uuids = set()

    for name in ["world_behavior_packs.json", "world_resource_packs.json"]:
        for p in load_world_json(world_dir / name):
            known_uuids.add(p.get("pack_id", ""))

    for pack_dir in [BP_DIR, RP_DIR]:
        if pack_dir.exists():
            for subfolder in pack_dir.iterdir():
                mf = subfolder / "manifest.json"
                if mf.exists():
                    m = read_manifest(mf)
                    if m:
                        uid, _, _ = get_pack_info(m)
                        if uid:
                            known_uuids.add(uid)

    dep_warnings = []
    for pack in installed_packs:
        for dep in pack["dependencies"]:
            dep_uuid = dep.get("uuid", "")
            if dep_uuid == pack["uuid"]:
                continue
            if dep_uuid and dep_uuid not in known_uuids:
                dep_ver = dep.get("version", "?")
                dep_warnings.append(
                    f"'{pack['name']}' depends on UUID {dep_uuid} (v{dep_ver}) "
                    f"which is NOT installed — it may not work correctly! "
                    f"Make sure the matching pack is also installed."
                )

    return dep_warnings


# ── Install Mode ─────────────────────────────────────────────────────────────

def do_install(world_dir: Path):
    """Install new packs from the install/ folder."""
    print(f"\n{C.BOLD}{'=' * 56}")
    print(f"  Install Packs")
    print(f"{'=' * 56}{C.RESET}")

    # Ensure directories exist
    for d in [INSTALL_DIR, BP_DIR, RP_DIR]:
        d.mkdir(parents=True, exist_ok=True)

    # Check world JSON files exist
    for name in ["world_behavior_packs.json", "world_resource_packs.json"]:
        wj = world_dir / name
        if not wj.exists():
            warn(f"{name} does not exist — will be created")
            save_world_json(wj, [])

    # Gather entries to process
    entries = sorted([
        e for e in INSTALL_DIR.iterdir()
        if not e.name.startswith("_extracted_") and not e.name.startswith(".")
    ])

    if not entries:
        print(f"\n  No files found in the install folder.")
        print(f"  Drop .mcaddon, .mcpack, .zip files or folders into:")
        print(f"    {C.CYAN}{INSTALL_DIR}{C.RESET}")
        return

    print(f"\n  Found {len(entries)} item(s) in install folder")

    stats = {"installed": 0, "skipped": 0, "errors": 0}

    for entry in entries:
        process_entry(entry, stats, world_dir)

    # Dependency check
    dep_warnings = check_dependencies(world_dir)
    for dw in dep_warnings:
        warnings.append(dw)

    # Summary
    print(f"\n{C.BOLD}{'=' * 56}{C.RESET}")

    if stats["errors"] == 0 and not warnings:
        print(f"  {C.GREEN}Done! All clean.{C.RESET}")
    else:
        print(f"  {C.BOLD}Done!{C.RESET}")

    print(f"  Installed: {C.GREEN}{stats['installed']}{C.RESET}  "
          f"Skipped: {stats['skipped']}  "
          f"Errors: {C.RED}{stats['errors']}{C.RESET}")

    bp_json = world_dir / "world_behavior_packs.json"
    rp_json = world_dir / "world_resource_packs.json"
    bp_count = len(load_world_json(bp_json))
    rp_count = len(load_world_json(rp_json))
    print(f"\n  World now has {C.CYAN}{bp_count}{C.RESET} behavior pack(s) "
          f"and {C.CYAN}{rp_count}{C.RESET} resource pack(s)")

    if warnings:
        print(f"\n  {C.YELLOW}{C.BOLD}--- WARNINGS ({len(warnings)}) ---{C.RESET}")
        for i, w in enumerate(warnings, 1):
            print(f"  {C.YELLOW}{i}. {w}{C.RESET}")
        print()

    print(f"{'=' * 56}")


# ── Rebuild Mode ─────────────────────────────────────────────────────────────

def do_rebuild(world_dir: Path):
    """Scan existing behavior_packs/ and resource_packs/ folders and rebuild the world JSONs."""
    print(f"\n{C.BOLD}{'=' * 56}")
    print(f"  Rebuild World Pack JSONs")
    print(f"{'=' * 56}{C.RESET}")

    bp_entries = []
    rp_entries = []
    bp_count = 0
    rp_count = 0

    # Scan behavior packs
    if BP_DIR.exists():
        for subfolder in sorted(BP_DIR.iterdir()):
            if not subfolder.is_dir():
                continue
            mf = subfolder / "manifest.json"
            if not mf.exists():
                warn(f"behavior_packs/{subfolder.name} has no manifest.json — skipping")
                continue
            manifest = read_manifest(mf)
            if not manifest:
                continue
            uuid, version, name = get_pack_info(manifest)
            if not uuid:
                warn(f"behavior_packs/{subfolder.name} has no UUID — skipping")
                continue
            bp_entries.append({"pack_id": uuid, "version": version})
            bp_count += 1
            print(f"  {C.GREEN}[BP]{C.RESET} {name} (v{'.'.join(str(v) for v in version)})")

    # Scan resource packs
    if RP_DIR.exists():
        for subfolder in sorted(RP_DIR.iterdir()):
            if not subfolder.is_dir():
                continue
            mf = subfolder / "manifest.json"
            if not mf.exists():
                warn(f"resource_packs/{subfolder.name} has no manifest.json — skipping")
                continue
            manifest = read_manifest(mf)
            if not manifest:
                continue
            uuid, version, name = get_pack_info(manifest)
            if not uuid:
                warn(f"resource_packs/{subfolder.name} has no UUID — skipping")
                continue
            rp_entries.append({"pack_id": uuid, "version": version})
            rp_count += 1
            print(f"  {C.CYAN}[RP]{C.RESET} {name} (v{'.'.join(str(v) for v in version)})")

    # Write the JSONs
    bp_json = world_dir / "world_behavior_packs.json"
    rp_json = world_dir / "world_resource_packs.json"
    save_world_json(bp_json, bp_entries)
    save_world_json(rp_json, rp_entries)

    print(f"\n{C.BOLD}{'=' * 56}{C.RESET}")
    print(f"  {C.GREEN}Done!{C.RESET} Registered {C.CYAN}{bp_count}{C.RESET} behavior pack(s) "
          f"and {C.CYAN}{rp_count}{C.RESET} resource pack(s)")

    if warnings:
        print(f"\n  {C.YELLOW}{C.BOLD}--- WARNINGS ({len(warnings)}) ---{C.RESET}")
        for i, w in enumerate(warnings, 1):
            print(f"  {C.YELLOW}{i}. {w}{C.RESET}")

    print(f"{'=' * 56}")


# ── Zip Mode ─────────────────────────────────────────────────────────────────

def do_zip():
    """Zip worlds/, behavior_packs/, and resource_packs/ into a single archive."""
    from datetime import datetime

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    zip_name = f"Bedrock_Packs_{timestamp}.zip"
    zip_path = BASE_DIR / zip_name

    print(f"\n{C.BOLD}{'=' * 56}")
    print(f"  Zipping Pack Folders")
    print(f"{'=' * 56}{C.RESET}")

    folders = ["worlds", "behavior_packs", "resource_packs"]
    file_count = 0

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for folder in folders:
            folder_path = BASE_DIR / folder
            if not folder_path.exists():
                warn(f"{folder}/ does not exist — skipping")
                continue
            for root, _dirs, files in os.walk(folder_path):
                for f in files:
                    file_path = Path(root) / f
                    arcname = file_path.relative_to(BASE_DIR)
                    zf.write(file_path, arcname)
                    file_count += 1

    size_mb = zip_path.stat().st_size / (1024 * 1024)
    print(f"\n  {C.GREEN}Done!{C.RESET} {file_count} files zipped")
    print(f"  {C.CYAN}{zip_name}{C.RESET} ({size_mb:.1f} MB)")
    print(f"  Saved to: {zip_path}")
    print(f"{'=' * 56}")


# ── Beta APIs Mode ───────────────────────────────────────────────────────────

def do_beta(world_dir: Path):
    """Enable Beta APIs experiment in a world's level.dat."""
    import struct
    import io
    try:
        import nbtlib
    except ImportError:
        error("nbtlib is required. Install it with: pip install nbtlib")
        return

    print(f"\n{C.BOLD}{'=' * 56}")
    print(f"  Enable Beta APIs")
    print(f"{'=' * 56}{C.RESET}")

    dat_path = world_dir / "level.dat"
    if not dat_path.exists():
        warn(f"No level.dat found in '{world_dir.name}' — skipping beta toggle")
        return

    # Read level.dat (Bedrock format: 8-byte header + little-endian NBT)
    with open(dat_path, "rb") as f:
        header = f.read(8)
        version, _ = struct.unpack("<II", header)
        nbt_data = f.read()

    nbt_file = nbtlib.File.parse(io.BytesIO(nbt_data), byteorder="little")

    if "experiments" not in nbt_file:
        nbt_file["experiments"] = nbtlib.Compound()

    exp = nbt_file["experiments"]

    # Check current state
    current_beta = exp.get("gametest", nbtlib.Byte(0))
    if int(current_beta) == 1:
        print(f"\n  Beta APIs already {C.GREEN}enabled{C.RESET} for '{world_dir.name}'")
        print(f"{'=' * 56}")
        return

    # Backup and enable
    backup_path = dat_path.with_suffix(".dat.backup")
    shutil.copy2(dat_path, backup_path)
    info("Backup saved as level.dat.backup")

    exp["data_driven_items"] = nbtlib.Byte(1)
    exp["gametest"] = nbtlib.Byte(1)
    exp["experiments_ever_used"] = nbtlib.Byte(1)
    exp["saved_with_toggled_experiments"] = nbtlib.Byte(1)

    # Write back
    buf = io.BytesIO()
    nbt_file.write(buf, byteorder="little")
    nbt_bytes = buf.getvalue()

    with open(dat_path, "wb") as f:
        f.write(struct.pack("<II", version, len(nbt_bytes)))
        f.write(nbt_bytes)

    print(f"\n  {C.GREEN}Done!{C.RESET} Beta APIs enabled for '{C.CYAN}{world_dir.name}{C.RESET}'")
    print(f"{'=' * 56}")


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    args = set(sys.argv[1:])
    flags = args & {"--rebuild", "--zip", "--beta"}

    # Determine if we need world selection
    # --zip doesn't need a world, everything else does
    needs_world = not flags or flags != {"--zip"}

    print(f"\n{C.BOLD}{'=' * 56}")
    print(f"  Minecraft Bedrock Pack Installer")
    print(f"{'=' * 56}{C.RESET}")

    world_dir = None
    if needs_world:
        world_dir = select_world()

    # No flags = default install mode
    if not flags:
        do_install(world_dir)
        return

    # Run each flag in order
    if "--rebuild" in flags:
        do_rebuild(world_dir)

    if "--beta" in flags:
        do_beta(world_dir)

    if "--zip" in flags:
        do_zip()


if __name__ == "__main__":
    main()
