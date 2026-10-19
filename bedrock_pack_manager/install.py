"""Install flow: unpack sources locally, plan against the server, then apply.

Sources can be ``.mcaddon`` / ``.mcpack`` / ``.zip`` files (nested any number of times),
any other file that is secretly a zip, or plain folders holding one or many packs.
Only finished pack folders and world JSON files are sent to the server.
"""

import os
import re
import shutil
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from .console import AppState, C, info, ok, print_warnings, section, warn
from .constants import ARCHIVE_EXTS, NON_PACK_TYPES
from .layout import PackKind, Target
from .manifests import ManifestError, classify_pack, format_version, get_pack_dependencies, get_pack_info, parse_manifest
from .nbt import read_level_dat
from .pack_index import InstalledPack, PackIndex, uuid_key
from .paths import ProjectPaths
from .storage import JUNK_NAMES, StorageError, basename, join
from .worlds import load_world_json, save_world_json, upsert_entry

DuplicateMode = Literal["skip", "replace", "keep-both"]
DUPLICATE_MODES = ("skip", "replace", "keep-both")
MAX_NESTED_DEPTH = 6
GENERIC_PACK_NAMES = {
    "",
    "addon",
    "addonname",
    "behaviorpack",
    "name",
    "pack",
    "packname",
    "resourcepack",
    "unknown",
}
KIND_LABELS = {"bp": "Behavior Pack", "rp": "Resource Pack"}


class UnsafeArchivePathError(Exception):
    pass


# ---- local unpacking -------------------------------------------------------------------------------


def _safe_extract_archive(zf: zipfile.ZipFile, dest: Path) -> None:
    """Reject archive members that would escape the target directory when extracted."""

    dest_root = dest.resolve()
    for member in zf.infolist():
        member_path = Path(member.filename)
        if member_path.is_absolute() or member.filename.startswith(("/", "\\")):
            raise UnsafeArchivePathError(f"Archive member '{member.filename}' uses an absolute path")
        target_path = (dest_root / member.filename).resolve()
        if os.path.commonpath([str(dest_root), str(target_path)]) != str(dest_root):
            raise UnsafeArchivePathError(f"Archive member '{member.filename}' would extract outside the target folder")
    zf.extractall(dest)


def is_archive_file(path: Path) -> bool:
    return path.is_file() and (path.suffix.lower() in ARCHIVE_EXTS or zipfile.is_zipfile(path))


def extract_archive(archive_path: Path, dest: Path) -> Path:
    extract_to = dest / f"_extracted_{archive_path.stem}"
    if extract_to.exists():
        shutil.rmtree(extract_to)
    with zipfile.ZipFile(archive_path, "r") as zf:
        _safe_extract_archive(zf, extract_to)
    return extract_to


def extract_nested_archives(folder: Path, state: AppState) -> bool:
    """Unpack archives inside archives, repeating until none are left."""

    found_any = False
    for _depth in range(MAX_NESTED_DEPTH):
        nested = [
            path
            for path in folder.rglob("*")
            if path.is_file() and path.suffix.lower() in ARCHIVE_EXTS and not any(part in JUNK_NAMES for part in path.parts)
        ]
        if not nested:
            break
        for file_path in nested:
            found_any = True
            info(f"Found nested archive: {file_path.name} - extracting", state=state, action="extract_nested_archive", archive=str(file_path))
            try:
                nested_dest = file_path.parent / f"_nested_{file_path.stem}"
                with zipfile.ZipFile(file_path, "r") as zf:
                    _safe_extract_archive(zf, nested_dest)
            except zipfile.BadZipFile:
                warn(state, f"Nested file {file_path.name} is not a valid archive, skipping it")
            except UnsafeArchivePathError as exc:
                warn(state, f"Nested file {file_path.name} is unsafe to extract, skipping it ({exc})")
            file_path.unlink(missing_ok=True)
    return found_any


def find_all_packs(folder: Path) -> list[Path]:
    packs = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = sorted(name for name in dirs if name not in JUNK_NAMES)
        if any(name.lower() == "manifest.json" for name in files):
            packs.append(Path(root))
    return packs


def _manifest_file(folder: Path) -> Path | None:
    for child in folder.iterdir():
        if child.is_file() and child.name.lower() == "manifest.json":
            return child
    return None


# ---- naming ----------------------------------------------------------------------------------------


def _normalize_pack_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def _clean_source_name(source_name: str) -> str:
    cleaned = Path(source_name).stem
    cleaned = re.sub(r"\s*[\[(](?:bp|rp|beh|res|bh|rs)[\])]\s*", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"(?i)\s+v\d+(?:\.\d+)*$", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip(" -_")


def _effective_pack_name(pack_name: str, pack_folder: Path, source_name: str = "") -> str:
    """Prefer manifest names, but fall back to cleaner source names for generic pack titles."""

    if _normalize_pack_name(pack_name) not in GENERIC_PACK_NAMES:
        return pack_name
    if source_name:
        cleaned_source_name = _clean_source_name(source_name)
        if cleaned_source_name:
            return cleaned_source_name
    return pack_folder.name


def pack_folder_name(display_name: str, pack_folder: Path, kind: PackKind, taken: set[str]) -> str:
    """A stable, human-readable folder name that does not clash with ``taken`` (lower-cased)."""

    safe_name = "".join(char if char.isalnum() or char in " -_" else "" for char in display_name).strip()
    if not safe_name:
        safe_name = "".join(char if char.isalnum() or char in " -_" else "" for char in pack_folder.name).strip() or "pack"
    if not safe_name.upper().endswith(("-BP", "-RP", "-BH", "-RS", "-BEH", "-RES")):
        safe_name += "-BP" if kind == "bp" else "-RP"

    candidate = safe_name
    counter = 2
    while candidate.lower() in taken:
        candidate = f"{safe_name}_{counter}"
        counter += 1
    return candidate


# ---- reading incoming packs -----------------------------------------------------------------------


@dataclass
class IncomingPack:
    folder: Path
    uuid: str
    version: list
    name: str
    display_name: str
    kind: PackKind
    dependencies: list[dict]
    source_name: str
    uses_beta: bool = False
    exclude: set[Path] = field(default_factory=set)

    @property
    def version_label(self) -> str:
        return format_version(self.version)


def read_incoming_pack(pack_folder: Path, source_name: str, state: AppState, *, beta_enabled: bool | None = None) -> IncomingPack | None:
    manifest_path = _manifest_file(pack_folder)
    if manifest_path is None:
        warn(state, f"Folder '{pack_folder.name}' has no manifest.json - not a valid pack")
        return None
    try:
        manifest = parse_manifest(manifest_path.read_bytes())
    except ManifestError as exc:
        warn(state, f"Corrupt manifest.json in '{pack_folder.name}' from {source_name}: {exc}")
        return None

    pack_type = classify_pack(manifest)
    uuid, version, name = get_pack_info(manifest)
    display_name = _effective_pack_name(name, pack_folder, source_name)

    if not pack_type:
        modules = manifest.get("modules", []) if isinstance(manifest.get("modules"), list) else []
        types = [module.get("type", "???") for module in modules if isinstance(module, dict)]
        if set(types) & NON_PACK_TYPES:
            warn(state, f"'{display_name}' is a {', '.join(types)}, not a behavior or resource pack - skipping")
        else:
            warn(state, f"Cannot determine type for '{display_name}' (module types: {types}) - skipping")
        return None
    if not uuid:
        warn(state, f"Pack '{display_name}' has no UUID in manifest - skipping (broken pack?)")
        return None

    fmt_ver = manifest.get("format_version")
    if fmt_ver is None:
        warn(state, f"Pack '{display_name}' is missing format_version - may be an old/broken pack")
    elif isinstance(fmt_ver, (int, float)) and fmt_ver < 2:
        warn(state, f"Pack '{display_name}' uses format_version {fmt_ver} (old format, may have issues)")

    dependencies = manifest.get("dependencies", []) if isinstance(manifest.get("dependencies"), list) else []
    uses_beta = any("beta" in str(dep.get("version", "")).lower() for dep in dependencies if isinstance(dep, dict))
    if uses_beta and beta_enabled is not True:
        warn(state, f"Pack '{display_name}' uses beta API versions - enable Beta APIs for this world (--beta)")

    return IncomingPack(
        folder=pack_folder,
        uuid=uuid,
        version=version,
        name=name,
        display_name=display_name,
        kind=pack_type,
        dependencies=get_pack_dependencies(manifest),
        source_name=source_name,
        uses_beta=uses_beta,
    )


@dataclass
class PreparedSource:
    entry: Path
    packs: list[IncomingPack] = field(default_factory=list)
    extracted: Path | None = None
    ok: bool = True


def prepare_source(entry: Path, scratch_dir: Path, state: AppState, *, beta_enabled: bool | None = None) -> PreparedSource:
    """Unpack one install source locally and read every pack inside it."""

    print(f"\n{C.BOLD}>> {entry.name}{C.RESET}")
    source = PreparedSource(entry=entry)

    if entry.is_file():
        if not is_archive_file(entry):
            warn(state, f"Unknown file type '{entry.suffix}' for '{entry.name}' - only {', '.join(sorted(ARCHIVE_EXTS))} (or zip files) are supported")
            source.ok = False
            return source
        if entry.suffix.lower() not in ARCHIVE_EXTS:
            info(f"'{entry.name}' is a zip file with an unusual extension - treating it as an archive")
        try:
            source.extracted = extract_archive(entry, scratch_dir)
        except zipfile.BadZipFile:
            warn(state, f"'{entry.name}' is not a valid zip archive - file may be corrupt")
            source.ok = False
            return source
        except UnsafeArchivePathError as exc:
            warn(state, f"'{entry.name}' contains unsafe archive paths - skipping it ({exc})")
            source.ok = False
            return source
        except Exception as exc:
            warn(state, f"Failed to extract '{entry.name}': {exc}")
            source.ok = False
            return source
        extract_nested_archives(source.extracted, state)
        search_root = source.extracted
    elif entry.is_dir():
        extract_nested_archives(entry, state)
        search_root = entry
    else:
        warn(state, f"'{entry.name}' is not a file or folder - skipping")
        source.ok = False
        return source

    pack_folders = find_all_packs(search_root)
    if not pack_folders:
        what = "archive may not be a valid Minecraft pack" if entry.is_file() else "not a valid pack or addon"
        warn(state, f"No manifest.json found anywhere inside '{entry.name}' - {what}")
        source.ok = False
        return source

    if len(pack_folders) > 1 or pack_folders[0] != search_root:
        info(f"Found {len(pack_folders)} pack(s) inside")

    suffix = entry.suffix.lower() if entry.is_file() else ""
    if suffix == ".mcpack" and len(pack_folders) > 1:
        warn(state, f"'{entry.name}' is a .mcpack but contains {len(pack_folders)} packs - unusual, processing all")

    for folder in pack_folders:
        pack = read_incoming_pack(folder, entry.name, state, beta_enabled=beta_enabled)
        if pack is None:
            source.ok = False
            continue
        # A pack folder that contains other pack folders must not upload them twice.
        pack.exclude = {other for other in pack_folders if other != folder and folder in other.parents}
        source.packs.append(pack)

    if suffix == ".mcaddon" and len(source.packs) == 1:
        missing = "Resource Pack" if source.packs[0].kind == "bp" else "Behavior Pack"
        warn(state, f"'{entry.name}' is an .mcaddon but only contains 1 pack - might be missing its {missing}")

    return source


# ---- planning ------------------------------------------------------------------------------------------


@dataclass
class PlannedPack:
    pack: IncomingPack
    action: Literal["upload", "register", "skip"]
    reason: str
    target_dir: str = ""
    target_folder: str = ""
    replace: list[InstalledPack] = field(default_factory=list)
    keep: list[InstalledPack] = field(default_factory=list)
    registration: str = "unchanged"

    def as_dict(self, target: Target | None = None) -> dict:
        def _where(path: str) -> str:
            return target.describe(path) if target else path

        return {
            "name": self.pack.display_name,
            "uuid": self.pack.uuid,
            "version": self.pack.version,
            "version_label": self.pack.version_label,
            "kind": self.pack.kind,
            "source": self.pack.source_name,
            "action": self.action,
            "reason": self.reason,
            "target": _where(join(self.target_dir, self.target_folder)) if self.target_folder else "",
            "replace": [_where(pack.path) for pack in self.replace],
            "keep": [_where(pack.path) for pack in self.keep],
            "registration": self.registration,
        }


def plan_install(
    target: Target,
    world: str,
    incoming: list[IncomingPack],
    index: PackIndex,
    world_packs: dict[str, list],
    *,
    duplicate_mode: DuplicateMode = "replace",
    reupload: bool = False,
) -> list[PlannedPack]:
    """Decide what to do with each incoming pack without touching the server."""

    plans: list[PlannedPack] = []
    batch_keys: dict[tuple, PlannedPack] = {}
    taken_names: dict[str, set[str]] = {}
    pending_registrations = {kind: [dict(entry) for entry in entries] for kind, entries in world_packs.items()}

    def _taken(directory: str) -> set[str]:
        if directory not in taken_names:
            try:
                taken_names[directory] = {entry.name.lower() for entry in target.storage.list_dir(directory)}
            except (FileNotFoundError, NotADirectoryError):
                taken_names[directory] = set()
        return taken_names[directory]

    for pack in incoming:
        key = (uuid_key(pack.uuid), tuple(pack.version), pack.kind)
        if key in batch_keys:
            plans.append(PlannedPack(pack, "skip", f"Same pack already queued from {batch_keys[key].pack.source_name}"))
            continue

        existing = index.find(pack.uuid, pack.kind)
        same_version = [copy for copy in existing if copy.version == pack.version]

        if same_version and not reupload:
            registration = upsert_entry(pending_registrations[pack.kind], pack.uuid, pack.version)
            if registration == "unchanged":
                plan = PlannedPack(pack, "skip", "Same UUID and version already installed and registered", registration=registration)
            else:
                plan = PlannedPack(pack, "register", "Same version already on the server - registering without uploading", registration=registration)
            plan.keep = same_version
            plans.append(plan)
            batch_keys[key] = plan
            continue

        if existing and duplicate_mode == "skip":
            versions = ", ".join(copy.version_label for copy in existing)
            plans.append(PlannedPack(pack, "skip", f"UUID already on the server (installed: {versions}) and duplicate mode is 'skip'", keep=existing))
            continue

        target_dir = target.install_dir(world, pack.kind)
        plan = PlannedPack(pack, "upload", "", target_dir=target_dir)
        if existing and duplicate_mode == "replace":
            plan.replace = [copy for copy in existing if copy.scope != "dev"]
            plan.keep = [copy for copy in existing if copy.scope == "dev"]
            versions = ", ".join(copy.version_label for copy in plan.replace)
            plan.reason = f"Replacing v{versions}" if plan.replace else "Upload (development copy left alone)"
        elif existing:
            plan.keep = existing
            plan.reason = "Uploading alongside existing copies (keep-both)"
        else:
            plan.reason = "New pack"
        if same_version and reupload:
            plan.reason = "Re-uploading the same version"

        taken = _taken(target_dir)
        freed = {copy.folder.lower() for copy in plan.replace if copy.pack_dir == target_dir}
        plan.target_folder = pack_folder_name(pack.display_name, pack.folder, pack.kind, taken - freed)
        taken.add(plan.target_folder.lower())
        plan.registration = upsert_entry(pending_registrations[pack.kind], pack.uuid, pack.version)
        plans.append(plan)
        batch_keys[key] = plan

    return plans


def print_plan(target: Target, plans: list[PlannedPack]) -> None:
    for plan in plans:
        pack = plan.pack
        color = {"upload": C.GREEN, "register": C.CYAN, "skip": C.DIM}[plan.action]
        print(f"\n    {C.BOLD}[{KIND_LABELS[pack.kind]}]{C.RESET} {pack.display_name} (v{pack.version_label})")
        print(f"    UUID: {C.DIM}{pack.uuid}{C.RESET}")
        print(f"    {color}{plan.action.upper()}{C.RESET} {plan.reason}")
        if plan.target_folder:
            print(f"    -> {target.describe(join(plan.target_dir, plan.target_folder))}")
        for copy in plan.replace:
            print(f"    {C.YELLOW}removes{C.RESET} {target.describe(copy.path)}")


# ---- applying ------------------------------------------------------------------------------------------


def _upload_pack(target: Target, plan: PlannedPack, state: AppState) -> str:
    """Upload a pack. When replacing a same-named folder, upload beside it first so a failed
    transfer never leaves the server without the pack."""

    storage = target.storage
    final_path = join(plan.target_dir, plan.target_folder)
    clashes = [copy for copy in plan.replace if copy.path.lower() == final_path.lower()]
    upload_path = f"{final_path}.bpm-upload" if clashes else final_path

    if clashes and storage.exists(upload_path):
        storage.remove_tree(upload_path)
    count = storage.upload_tree(plan.pack.folder, upload_path, exclude=plan.pack.exclude)

    for copy in plan.replace:
        storage.remove_tree(copy.path)
        info(f"Removed old copy {target.describe(copy.path)}", state=state, action="remove_existing_packs", uuid=plan.pack.uuid, removed_paths=[copy.path])

    if upload_path != final_path:
        try:
            storage.rename(upload_path, final_path)
        except Exception:
            info(f"Server refused the rename; pack kept as {basename(upload_path)} (Bedrock does not care about folder names)")
            final_path = upload_path

    ok(
        f"Uploaded {count} file(s) to {target.describe(final_path)}",
        state=state,
        action="copy_pack",
        source=str(plan.pack.folder),
        target=final_path,
        uuid=plan.pack.uuid,
        version=plan.pack.version,
        pack_type=plan.pack.kind,
    )
    return final_path


def apply_install(
    target: Target,
    world: str,
    plans: list[PlannedPack],
    index: PackIndex,
    world_packs: dict[str, list],
    stats: dict,
    state: AppState,
) -> None:
    """Carry out a plan. World JSONs are written once at the end, only if they changed."""

    changed_kinds: set[str] = set()
    for plan in plans:
        pack = plan.pack
        print(f"\n    {C.BOLD}[{KIND_LABELS[pack.kind]}]{C.RESET} {pack.display_name} (v{pack.version_label})")
        print(f"    UUID: {C.DIM}{pack.uuid}{C.RESET}")

        if plan.action == "skip":
            info(plan.reason, state=state, action="skip_pack", reason=plan.reason, uuid=pack.uuid, version=pack.version, source=pack.source_name)
            stats["skipped"] += 1
            continue

        if plan.action == "upload":
            try:
                final_path = _upload_pack(target, plan, state)
            except (StorageError, OSError) as exc:
                warn(state, f"Upload of '{pack.display_name}' failed: {exc}")
                stats["errors"] += 1
                continue
            for copy in plan.replace:
                index.remove(copy.path)
            index.add(
                InstalledPack(
                    uuid=pack.uuid,
                    version=pack.version,
                    name=pack.display_name,
                    kind=pack.kind,
                    dir_kind=pack.kind,
                    scope="world" if plan.target_dir.startswith(f"{world}/") else "shared",
                    path=final_path,
                    pack_dir=plan.target_dir,
                    dependencies=pack.dependencies,
                )
            )
        else:
            info(plan.reason, state=state, action="reuse_installed_pack", uuid=pack.uuid, version=pack.version, source=pack.source_name)

        world_json = target.world_json(world, pack.kind)
        registration = upsert_entry(world_packs[pack.kind], pack.uuid, pack.version)
        details = {"world_json": world_json, "uuid": pack.uuid, "version": pack.version, "registration_action": registration}
        if registration == "added":
            changed_kinds.add(pack.kind)
            ok(f"Registered in {basename(world_json)}", state=state, action="register_world_pack", **details)
        elif registration == "updated":
            changed_kinds.add(pack.kind)
            info(f"Updated {basename(world_json)} to v{pack.version_label}", state=state, action="register_world_pack", **details)
        else:
            state.record("register_world_pack", f"{basename(world_json)} already references v{pack.version_label}", **details)

        stats["installed"] += 1
        state.installed_packs.append(
            {"uuid": pack.uuid, "name": pack.display_name, "type": pack.kind, "version": pack.version, "dependencies": pack.dependencies, "source": pack.source_name}
        )

    for kind in sorted(changed_kinds):
        save_world_json(target.storage, target.world_json(world, kind), world_packs[kind])


def check_dependencies(index: PackIndex, world_packs: dict[str, list], state: AppState) -> list[str]:
    known_uuids = index.uuids()
    for entries in world_packs.values():
        known_uuids.update(uuid_key(entry.get("pack_id", "")) for entry in entries)

    dep_warnings = []
    for pack in state.installed_packs:
        for dep in pack["dependencies"]:
            dep_uuid = uuid_key(dep.get("uuid", ""))
            if not dep_uuid or dep_uuid == uuid_key(pack["uuid"]):
                continue
            if dep_uuid not in known_uuids:
                dep_warnings.append(
                    f"'{pack['name']}' depends on UUID {dep.get('uuid')} (v{format_version(dep.get('version', '?'))}) "
                    f"which is NOT installed - it may not work correctly! Make sure the matching pack is also installed."
                )
    return dep_warnings


def world_beta_status(target: Target, world: str) -> bool | None:
    try:
        return read_level_dat(target.storage, target.level_dat(world)).beta_enabled
    except Exception:
        return None


def load_world_packs(target: Target, world: str) -> dict[str, list]:
    return {kind: load_world_json(target.storage, target.world_json(world, kind)) for kind in ("bp", "rp")}


# ---- orchestration -------------------------------------------------------------------------------------


def move_to_processed(entry: Path, processed_dir: Path) -> None:
    processed_dir.mkdir(parents=True, exist_ok=True)
    target = processed_dir / entry.name
    counter = 2
    original = target
    while target.exists():
        stem = original.stem if original.is_file() or entry.is_file() else original.name
        suffix = original.suffix if original.is_file() or entry.is_file() else ""
        target = processed_dir / f"{stem}_{counter}{suffix}"
        counter += 1
    shutil.move(str(entry), str(target))


def queued_entries(queue_dir: Path) -> list[Path]:
    if not queue_dir.exists():
        return []
    return sorted(
        (entry for entry in queue_dir.iterdir() if not entry.name.startswith(("_extracted_", ".")) and entry.name not in JUNK_NAMES),
        key=lambda path: path.name.lower(),
    )


def do_install(
    target: Target,
    world: str,
    paths: ProjectPaths,
    state: AppState,
    duplicate_mode: DuplicateMode = "replace",
    *,
    reupload: bool = False,
    dry_run: bool = False,
    sources: list[Path] | None = None,
    processed_dir: Path | None = None,
) -> dict:
    """Install every source (default: everything queued in ``run/install``) into ``world``.

    Returns a JSON-friendly summary with the plan and stats.
    """

    section("Install Packs" + (" (dry run)" if dry_run else ""), state=state, action="install", dry_run=dry_run)
    print(f"  Server: {C.CYAN}{target.label}{C.RESET}")
    print(f"  World: {C.CYAN}{basename(world)}{C.RESET}")

    from_queue = sources is None
    entries = queued_entries(paths.install_dir) if from_queue else list(sources)
    if from_queue and processed_dir is None:
        processed_dir = paths.installed_dir
    result = {"plan": [], "stats": {"installed": 0, "skipped": 0, "errors": 0}, "applied": False, "dry_run": dry_run}

    if not entries:
        print("\n  No files found to install.")
        if from_queue:
            print("  Drop .mcaddon, .mcpack, .zip files or folders into:")
            print(f"    {C.CYAN}{paths.install_dir}{C.RESET}")
        state.record("install_summary", "No files found in install folder", installed=0, skipped=0, warnings=0, errors=0)
        return result

    print(f"\n  Found {len(entries)} item(s) to install")

    world_packs = load_world_packs(target, world)
    for kind in ("bp", "rp"):
        if not target.storage.exists(target.world_json(world, kind)):
            warn(state, f"{basename(target.world_json(world, kind))} does not exist - will be created")

    beta_enabled = world_beta_status(target, world)
    scratch_dir = paths.staging_dir / "unpack"
    scratch_dir.mkdir(parents=True, exist_ok=True)

    stats = result["stats"]
    prepared: list[PreparedSource] = []
    try:
        for entry in entries:
            source = prepare_source(entry, scratch_dir, state, beta_enabled=beta_enabled)
            if not source.packs:
                stats["errors"] += 1
            prepared.append(source)

        incoming = [pack for source in prepared for pack in source.packs]
        print(f"\n  Scanning installed packs on {C.CYAN}{target.label}{C.RESET} ...")
        index = PackIndex.build(target, world)
        plans = plan_install(target, world, incoming, index, world_packs, duplicate_mode=duplicate_mode, reupload=reupload)
        result["plan"] = [plan.as_dict(target) for plan in plans]

        if dry_run:
            section("Planned Changes", state=state, action="install_plan")
            print_plan(target, plans)
            uploads = sum(1 for plan in plans if plan.action == "upload")
            registers = sum(1 for plan in plans if plan.action == "register")
            skips = sum(1 for plan in plans if plan.action == "skip")
            print(f"\n  Would upload {C.GREEN}{uploads}{C.RESET}, register {C.CYAN}{registers}{C.RESET}, skip {skips}. Nothing was changed.")
            state.record("install_plan", "Dry run complete", uploads=uploads, registers=registers, skips=skips)
            print_warnings(state.warnings)
            return result

        if plans:
            section("Applying", state=state, action="install_apply")
        apply_install(target, world, plans, index, world_packs, stats, state)
        result["applied"] = True

        for dep_warning in check_dependencies(index, world_packs, state):
            state.warnings.append(dep_warning)

        if processed_dir is not None:
            for source in prepared:
                if source.packs and source.entry.exists():
                    move_to_processed(source.entry, processed_dir)
    finally:
        for source in prepared:
            if source.extracted is not None:
                shutil.rmtree(source.extracted, ignore_errors=True)

    if stats["errors"] == 0 and not state.warnings:
        print(f"\n  {C.GREEN}Done! All clean.{C.RESET}")
    else:
        print(f"\n  {C.BOLD}Done!{C.RESET}")
    print(
        f"  Installed: {C.GREEN}{stats['installed']}{C.RESET}  "
        f"Skipped: {stats['skipped']}  "
        f"Warnings: {C.YELLOW}{len(state.warnings)}{C.RESET}  "
        f"Errors: {C.RED}{stats['errors']}{C.RESET}"
    )
    bp_count, rp_count = len(world_packs["bp"]), len(world_packs["rp"])
    print(f"\n  World now has {C.CYAN}{bp_count}{C.RESET} behavior pack(s) and {C.CYAN}{rp_count}{C.RESET} resource pack(s)")

    state.record(
        "install_summary",
        "Install complete",
        installed=stats["installed"],
        skipped=stats["skipped"],
        warnings=len(state.warnings),
        errors=stats["errors"],
        behavior_packs=bp_count,
        resource_packs=rp_count,
        duplicate_mode=duplicate_mode,
    )
    print_warnings(state.warnings)
    return result
