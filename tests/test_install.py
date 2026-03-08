import json
import shutil
import zipfile

from bedrock_pack_installer.console import AppState
from bedrock_pack_installer.install import (
    check_dependencies,
    do_install,
    extract_nested_archives,
    move_to_installed,
    pack_exists_on_disk,
    process_entry,
    process_pack,
)
from bedrock_pack_installer.paths import build_paths
from tests.conftest import FIXTURES
from tests.helpers import PACK_UUID, PACK_VERSION, make_zip_from_dir, write_manifest, write_world_json


FIXTURE_PACK_ARCHIVE = "pack.mcpack"
FIXTURE_ADDON_ARCHIVE = "addon.mcaddon"


def test_process_pack_restores_files_when_registered_but_missing_on_disk(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True)

    source_pack = tmp_path / "source" / "test_pack"
    write_manifest(source_pack)

    world_json = world_dir / "world_behavior_packs.json"
    write_world_json(world_json, [{"pack_id": PACK_UUID, "version": PACK_VERSION}])

    stats = {"installed": 0, "skipped": 0, "errors": 0}
    state = AppState()

    process_pack(source_pack, stats, world_dir, paths, state, source_name="source_pack")

    copied_manifests = list(paths.behavior_packs_dir.glob("*/manifest.json"))
    assert len(copied_manifests) == 1
    assert stats == {"installed": 1, "skipped": 0, "errors": 0}
    assert len(json.loads(world_json.read_text(encoding="utf-8"))) == 1


def test_process_pack_skips_when_registered_and_already_on_disk(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True)

    source_pack = tmp_path / "source" / "test_pack"
    write_manifest(source_pack)

    existing_pack = paths.behavior_packs_dir / "Existing Pack-BP"
    write_manifest(existing_pack)

    world_json = world_dir / "world_behavior_packs.json"
    write_world_json(world_json, [{"pack_id": PACK_UUID, "version": PACK_VERSION}])

    stats = {"installed": 0, "skipped": 0, "errors": 0}
    state = AppState()

    process_pack(source_pack, stats, world_dir, paths, state, source_name="source_pack")

    copied_manifests = list(paths.behavior_packs_dir.glob("*/manifest.json"))
    assert len(copied_manifests) == 1
    assert stats == {"installed": 0, "skipped": 1, "errors": 0}
    assert len(json.loads(world_json.read_text(encoding="utf-8"))) == 1


def test_process_entry_warns_for_unknown_file_type(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True)
    unknown_file = paths.install_dir / "notes.txt"
    paths.install_dir.mkdir(parents=True)
    unknown_file.write_text("nope", encoding="utf-8")

    stats = {"installed": 0, "skipped": 0, "errors": 0}
    state = AppState()

    process_entry(unknown_file, stats, world_dir, paths, state)

    assert stats == {"installed": 0, "skipped": 0, "errors": 1}
    assert len(state.warnings) == 1


def test_process_entry_installs_from_extracted_folder_and_moves_source(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True)
    folder_entry = paths.install_dir / "folder_pack"
    write_manifest(folder_entry, name="Folder Pack")

    stats = {"installed": 0, "skipped": 0, "errors": 0}
    state = AppState()

    process_entry(folder_entry, stats, world_dir, paths, state)

    assert stats == {"installed": 1, "skipped": 0, "errors": 0}
    assert (paths.installed_dir / "folder_pack").exists()
    assert list(paths.behavior_packs_dir.glob("Folder Pack-BP*/manifest.json"))


def test_process_entry_installs_from_zip_archive(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True)
    paths.install_dir.mkdir(parents=True)

    source_dir = tmp_path / "archive_src"
    write_manifest(source_dir / "zip_pack", name="Zip Pack")
    zip_path = paths.install_dir / "pack.zip"
    make_zip_from_dir(source_dir, zip_path)

    stats = {"installed": 0, "skipped": 0, "errors": 0}
    state = AppState()

    process_entry(zip_path, stats, world_dir, paths, state)

    assert stats == {"installed": 1, "skipped": 0, "errors": 0}
    assert (paths.installed_dir / "pack.zip").exists()
    assert list(paths.behavior_packs_dir.glob("Zip Pack-BP*/manifest.json"))


def test_process_entry_extracts_nested_archive_from_mcaddon(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True)
    paths.install_dir.mkdir(parents=True)

    inner_source = tmp_path / "inner_src"
    write_manifest(inner_source / "nested_pack", name="Nested Pack")
    inner_mcpack = tmp_path / "nested.mcpack"
    make_zip_from_dir(inner_source, inner_mcpack)

    outer_mcaddon = paths.install_dir / "addon.mcaddon"
    with zipfile.ZipFile(outer_mcaddon, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(inner_mcpack, "nested.mcpack")

    stats = {"installed": 0, "skipped": 0, "errors": 0}
    state = AppState()

    process_entry(outer_mcaddon, stats, world_dir, paths, state)

    assert stats == {"installed": 1, "skipped": 0, "errors": 0}
    assert list(paths.behavior_packs_dir.glob("Nested Pack-BP*/manifest.json"))


def test_process_entry_reports_invalid_archive(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True)
    paths.install_dir.mkdir(parents=True)

    bad_zip = paths.install_dir / "bad.zip"
    bad_zip.write_text("not a zip", encoding="utf-8")

    stats = {"installed": 0, "skipped": 0, "errors": 0}
    state = AppState()

    process_entry(bad_zip, stats, world_dir, paths, state)

    assert stats == {"installed": 0, "skipped": 0, "errors": 1}
    assert len(state.warnings) == 1


def test_extract_nested_archives_warns_for_invalid_nested_archive(tmp_path):
    folder = tmp_path / "folder"
    folder.mkdir()
    nested = folder / "bad.mcpack"
    nested.write_text("bad", encoding="utf-8")
    state = AppState()

    found = extract_nested_archives(folder, state)

    assert found is True
    assert len(state.warnings) == 1


def test_move_to_installed_renames_when_target_exists(tmp_path):
    paths = build_paths(tmp_path)
    paths.installed_dir.mkdir(parents=True)
    existing = paths.installed_dir / "pack.zip"
    existing.write_text("existing", encoding="utf-8")
    source = tmp_path / "pack.zip"
    source.write_text("new", encoding="utf-8")

    move_to_installed(source, paths)

    assert (paths.installed_dir / "pack_2.zip").exists()


def test_pack_exists_on_disk_handles_missing_manifest_and_invalid_manifest(tmp_path):
    paths = build_paths(tmp_path)
    no_manifest = paths.behavior_packs_dir / "NoManifest"
    no_manifest.mkdir(parents=True)
    bad_manifest = paths.behavior_packs_dir / "BadManifest"
    bad_manifest.mkdir(parents=True)
    (bad_manifest / "manifest.json").write_text("{bad", encoding="utf-8")

    assert pack_exists_on_disk(paths.behavior_packs_dir, "missing-uuid") is False


def test_process_pack_errors_when_manifest_missing(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "World"
    world_dir.mkdir(parents=True)
    pack_dir = tmp_path / "broken"
    pack_dir.mkdir()
    stats = {"installed": 0, "skipped": 0, "errors": 0}
    state = AppState()

    process_pack(pack_dir, stats, world_dir, paths, state)

    assert stats["errors"] == 1


def test_process_pack_errors_for_unknown_type_and_missing_uuid(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "World"
    world_dir.mkdir(parents=True)
    stats = {"installed": 0, "skipped": 0, "errors": 0}
    state = AppState()

    unknown = tmp_path / "unknown"
    write_manifest(unknown, uuid=PACK_UUID, name="Unknown", module_type="foo")
    process_pack(unknown, stats, world_dir, paths, state)

    no_uuid = tmp_path / "no_uuid"
    write_manifest(no_uuid, uuid="", name="No UUID")
    process_pack(no_uuid, stats, world_dir, paths, state)

    assert stats["errors"] == 2


def test_process_pack_collects_format_and_beta_warnings(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "World"
    world_dir.mkdir(parents=True)
    pack_dir = tmp_path / "warn_pack"
    pack_dir.mkdir()
    manifest = {
        "format_version": 1,
        "header": {"name": "Warn Pack", "uuid": PACK_UUID, "version": PACK_VERSION},
        "modules": [{"type": "data", "uuid": "22222222-2222-2222-2222-222222222222", "version": PACK_VERSION}],
        "dependencies": [{"uuid": "dep", "version": "beta"}],
    }
    (pack_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    stats = {"installed": 0, "skipped": 0, "errors": 0}
    state = AppState()

    process_pack(pack_dir, stats, world_dir, paths, state)

    assert stats["installed"] == 1
    assert len(state.warnings) == 2


def test_check_dependencies_reports_missing_dependency_only(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True)
    write_world_json(world_dir / "world_behavior_packs.json", [])
    write_world_json(world_dir / "world_resource_packs.json", [])

    state = AppState()
    state.installed_packs = [
        {
            "uuid": PACK_UUID,
            "name": "Primary Pack",
            "type": "bp",
            "version": PACK_VERSION,
            "dependencies": [
                {"uuid": "missing-dep", "version": [1, 0, 0]},
                {"uuid": PACK_UUID, "version": [1, 0, 0]},
            ],
            "source": "test",
        }
    ]

    warnings = check_dependencies(world_dir, paths, state)

    assert len(warnings) == 1
    assert "missing-dep" in warnings[0]


def test_check_dependencies_accepts_dependency_present_on_disk(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True)
    write_world_json(world_dir / "world_behavior_packs.json", [])
    write_world_json(world_dir / "world_resource_packs.json", [])

    write_manifest(paths.behavior_packs_dir / "Dependency Pack-BP", uuid="dep-uuid", name="Dependency Pack")

    state = AppState()
    state.installed_packs = [
        {
            "uuid": PACK_UUID,
            "name": "Primary Pack",
            "type": "bp",
            "version": PACK_VERSION,
            "dependencies": [{"uuid": "dep-uuid", "version": [1, 0, 0]}],
            "source": "test",
        }
    ]

    assert check_dependencies(world_dir, paths, state) == []


def test_process_entry_folder_without_manifest_errors(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True)
    paths.install_dir.mkdir(parents=True)
    folder = paths.install_dir / "bad_folder"
    folder.mkdir()
    stats = {"installed": 0, "skipped": 0, "errors": 0}
    state = AppState()

    process_entry(folder, stats, world_dir, paths, state)

    assert stats["errors"] == 1


def test_process_entry_archive_without_manifest_errors(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True)
    paths.install_dir.mkdir(parents=True)
    zip_path = paths.install_dir / "empty.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("readme.txt", "no manifest")
    stats = {"installed": 0, "skipped": 0, "errors": 0}
    state = AppState()

    process_entry(zip_path, stats, world_dir, paths, state)

    assert stats["errors"] == 1


def test_process_entry_mcpack_warns_when_multiple_packs_found(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True)
    paths.install_dir.mkdir(parents=True)
    source_dir = tmp_path / "multi"
    write_manifest(source_dir / "pack_a", uuid="uuid-a", name="Pack A")
    write_manifest(source_dir / "pack_b", uuid="uuid-b", name="Pack B")
    zip_path = paths.install_dir / "multi.mcpack"
    make_zip_from_dir(source_dir, zip_path)
    stats = {"installed": 0, "skipped": 0, "errors": 0}
    state = AppState()

    process_entry(zip_path, stats, world_dir, paths, state)

    assert stats["installed"] == 2
    assert any(".mcpack but contains 2 packs" in warning for warning in state.warnings)


def test_do_install_creates_missing_world_json_and_handles_empty_install(tmp_path, capsys):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "World"
    world_dir.mkdir(parents=True)
    state = AppState()

    do_install(world_dir, paths, state)

    output = capsys.readouterr().out
    assert "No files found in the install folder." in output
    assert (world_dir / "world_behavior_packs.json").exists()
    assert (world_dir / "world_resource_packs.json").exists()


def test_process_entry_installs_real_mcpack_fixture(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True)
    paths.install_dir.mkdir(parents=True, exist_ok=True)

    archive_name = FIXTURE_PACK_ARCHIVE
    archive_path = paths.install_dir / archive_name
    shutil.copy2(FIXTURES / "installed" / archive_name, archive_path)

    stats = {"installed": 0, "skipped": 0, "errors": 0}
    state = AppState()

    process_entry(archive_path, stats, world_dir, paths, state)

    assert stats == {"installed": 1, "skipped": 0, "errors": 0}
    assert (paths.installed_dir / archive_name).exists()
    assert len(list(paths.resource_packs_dir.glob("*/manifest.json"))) == 1
    assert len(list(paths.resource_packs_dir.glob("*/pack.txt"))) == 1
    assert len(json.loads((world_dir / "world_resource_packs.json").read_text(encoding="utf-8"))) == 1


def test_process_entry_installs_real_mcaddon_fixture(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True)
    paths.install_dir.mkdir(parents=True, exist_ok=True)

    archive_name = FIXTURE_ADDON_ARCHIVE
    archive_path = paths.install_dir / archive_name
    shutil.copy2(FIXTURES / "installed" / archive_name, archive_path)

    stats = {"installed": 0, "skipped": 0, "errors": 0}
    state = AppState()

    process_entry(archive_path, stats, world_dir, paths, state)

    assert stats == {"installed": 2, "skipped": 0, "errors": 0}
    assert (paths.installed_dir / archive_name).exists()
    assert len(list(paths.behavior_packs_dir.glob("*/manifest.json"))) == 1
    assert len(list(paths.resource_packs_dir.glob("*/manifest.json"))) == 1
    assert len(list(paths.behavior_packs_dir.glob("*/notes.txt"))) == 1
    assert len(list(paths.resource_packs_dir.glob("*/notes.txt"))) == 1
    assert len(json.loads((world_dir / "world_behavior_packs.json").read_text(encoding="utf-8"))) == 1
    assert len(json.loads((world_dir / "world_resource_packs.json").read_text(encoding="utf-8"))) == 1


def test_do_install_restores_real_fixtures_from_existing_world_json(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "World"
    world_dir.mkdir(parents=True, exist_ok=True)
    paths.install_dir.mkdir(parents=True, exist_ok=True)

    shutil.copy2(FIXTURES / "worlds" / "World" / "world_behavior_packs.json", world_dir / "world_behavior_packs.json")
    shutil.copy2(FIXTURES / "worlds" / "World" / "world_resource_packs.json", world_dir / "world_resource_packs.json")
    shutil.copy2(
        FIXTURES / "installed" / FIXTURE_PACK_ARCHIVE,
        paths.install_dir / FIXTURE_PACK_ARCHIVE,
    )
    shutil.copy2(
        FIXTURES / "installed" / FIXTURE_ADDON_ARCHIVE,
        paths.install_dir / FIXTURE_ADDON_ARCHIVE,
    )

    state = AppState()

    do_install(world_dir, paths, state)

    behavior_entries = json.loads((world_dir / "world_behavior_packs.json").read_text(encoding="utf-8"))
    resource_entries = json.loads((world_dir / "world_resource_packs.json").read_text(encoding="utf-8"))

    assert len(behavior_entries) == 1
    assert len(resource_entries) == 2
    assert len(list(paths.behavior_packs_dir.glob("*/manifest.json"))) == 1
    assert len(list(paths.resource_packs_dir.glob("*/manifest.json"))) == 2
    assert (paths.installed_dir / FIXTURE_PACK_ARCHIVE).exists()
    assert (paths.installed_dir / FIXTURE_ADDON_ARCHIVE).exists()
