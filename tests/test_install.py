import json
import shutil
import zipfile

import pytest
from bedrock_pack_manager.console import AppState
from bedrock_pack_manager.install import (
    UnsafeArchivePathError,
    _clean_source_name,
    _effective_pack_name,
    _safe_extract_archive,
    check_dependencies,
    do_install,
    extract_nested_archives,
    find_all_packs,
    load_world_packs,
    move_to_processed,
    pack_folder_name,
    plan_install,
    prepare_source,
    read_incoming_pack,
)
from bedrock_pack_manager.layout import connect_target
from bedrock_pack_manager.pack_index import PackIndex
from bedrock_pack_manager.paths import build_paths, ensure_runtime_dirs
from tests.conftest import FIXTURES
from tests.helpers import PACK_UUID, PACK_VERSION, make_zip_from_dir, read_json, run_setup, write_manifest, write_world_json

ADDON = FIXTURES / "installed" / "addon.mcaddon"
MCPACK = FIXTURES / "installed" / "pack.mcpack"
ADDON_BP = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
ADDON_RP = "cccccccc-cccc-cccc-cccc-cccccccccccc"
PACK_RP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


def queue(paths, *sources):
    for source in sources:
        if source.is_dir():
            shutil.copytree(source, paths.install_dir / source.name)
        else:
            shutil.copy(source, paths.install_dir / source.name)


def bp_json(world_dir):
    return read_json(world_dir / "world_behavior_packs.json")


def rp_json(world_dir):
    return read_json(world_dir / "world_resource_packs.json")


# ---- full install from the run/install queue ------------------------------------------------------


def test_install_addon_and_mcpack_from_queue(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    queue(paths, ADDON, MCPACK)
    state = AppState()

    result = do_install(target, world, paths, state)

    assert result["stats"] == {"installed": 3, "skipped": 0, "errors": 0}
    assert result["applied"] is True
    assert sorted(p.name for p in paths.behavior_packs_dir.iterdir()) == ["Addon BP-BP"]
    # "Pack" is a generic manifest name, so the archive name is used instead.
    assert sorted(p.name for p in paths.resource_packs_dir.iterdir()) == ["Addon RP-RP", "pack-RP"]
    assert (paths.behavior_packs_dir / "Addon BP-BP" / "functions" / ".keep").exists()
    assert bp_json(world_dir) == [{"pack_id": ADDON_BP, "version": [1, 0, 0]}]
    assert {entry["pack_id"] for entry in rp_json(world_dir)} == {ADDON_RP, PACK_RP}
    assert sorted(p.name for p in paths.installed_dir.iterdir()) == ["addon.mcaddon", "pack.mcpack"]
    assert list(paths.install_dir.iterdir()) == []
    assert not any(paths.staging_dir.rglob("_extracted_*"))
    assert any(action.kind == "install_summary" for action in state.actions)


def test_install_again_skips_everything(tmp_path):
    paths, target, world, _ = run_setup(tmp_path)
    queue(paths, ADDON)
    do_install(target, world, paths, AppState())
    queue(paths, ADDON)

    result = do_install(target, world, paths, AppState())

    assert result["stats"] == {"installed": 0, "skipped": 2, "errors": 0}
    assert sorted(p.name for p in paths.installed_dir.iterdir()) == ["addon.mcaddon", "addon_2.mcaddon"]


def test_install_with_empty_queue_reports_nothing(tmp_path, capsys):
    paths, target, world, _ = run_setup(tmp_path)

    result = do_install(target, world, paths, AppState())

    assert result["plan"] == []
    assert "No files found" in capsys.readouterr().out


def test_dry_run_changes_nothing(tmp_path, capsys):
    paths, target, world, world_dir = run_setup(tmp_path)
    queue(paths, ADDON)

    result = do_install(target, world, paths, AppState(), dry_run=True)

    assert [item["action"] for item in result["plan"]] == ["upload", "upload"]
    assert result["applied"] is False
    assert list(paths.behavior_packs_dir.iterdir()) == []
    assert not (world_dir / "world_behavior_packs.json").exists()
    assert (paths.install_dir / "addon.mcaddon").exists()
    assert "Nothing was changed" in capsys.readouterr().out


def test_install_from_explicit_sources_keeps_them_in_place(tmp_path):
    paths, target, world, _ = run_setup(tmp_path)
    upload = tmp_path / "uploads" / "pack.mcpack"
    upload.parent.mkdir()
    shutil.copy(MCPACK, upload)

    do_install(target, world, paths, AppState(), sources=[upload])

    assert upload.exists()
    assert list(paths.installed_dir.iterdir()) == []


def test_install_registers_existing_same_version_without_copy(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "Already There")
    write_manifest(tmp_path / "src" / "pack")
    state = AppState()

    result = do_install(target, world, paths, state, sources=[tmp_path / "src" / "pack"])

    assert result["plan"][0]["action"] == "register"
    assert [p.name for p in paths.behavior_packs_dir.iterdir()] == ["Already There"]
    assert bp_json(world_dir) == [{"pack_id": PACK_UUID, "version": PACK_VERSION}]
    assert any(action.kind == "reuse_installed_pack" for action in state.actions)


def test_reupload_overwrites_same_version(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "Test Pack-BP")
    write_world_json(world_dir / "world_behavior_packs.json", [{"pack_id": PACK_UUID, "version": PACK_VERSION}])
    write_manifest(tmp_path / "src" / "pack")
    (tmp_path / "src" / "pack" / "new.txt").write_text("fresh")

    result = do_install(target, world, paths, AppState(), sources=[tmp_path / "src" / "pack"], reupload=True)

    assert result["plan"][0]["reason"] == "Re-uploading the same version"
    assert [p.name for p in paths.behavior_packs_dir.iterdir()] == ["Test Pack-BP"]
    assert (paths.behavior_packs_dir / "Test Pack-BP" / "new.txt").read_text() == "fresh"
    assert not any(p.name.endswith(".bpm-upload") for p in paths.behavior_packs_dir.iterdir())


@pytest.mark.parametrize(
    "mode, expected_folders, expected_version",
    [
        ("replace", ["Test Pack-BP"], [2, 0, 0]),
        ("skip", ["Test Pack-BP"], [1, 0, 0]),
        ("keep-both", ["Test Pack-BP", "Test Pack-BP_2"], [2, 0, 0]),
    ],
)
def test_duplicate_modes(tmp_path, mode, expected_folders, expected_version):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "Test Pack-BP", version=[1, 0, 0])
    write_world_json(world_dir / "world_behavior_packs.json", [{"pack_id": PACK_UUID, "version": [1, 0, 0]}])
    write_manifest(tmp_path / "src" / "new", version=[2, 0, 0])

    do_install(target, world, paths, AppState(), duplicate_mode=mode, sources=[tmp_path / "src" / "new"])

    assert sorted(p.name for p in paths.behavior_packs_dir.iterdir()) == expected_folders
    assert bp_json(world_dir) == [{"pack_id": PACK_UUID, "version": expected_version}]
    if mode == "replace":
        manifest = read_json(paths.behavior_packs_dir / "Test Pack-BP" / "manifest.json")
        assert manifest["header"]["version"] == [2, 0, 0]


def test_install_into_world_scope(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path, pack_scope="world")
    queue(paths, MCPACK)

    do_install(target, world, paths, AppState())

    assert (world_dir / "resource_packs" / "Pack-RP" / "manifest.json").exists()
    assert list(paths.resource_packs_dir.iterdir()) == []


def test_install_over_ftp(tmp_path, ftp_server, ftp_storage):
    server = ftp_server["root"]
    (server / "worlds" / "W").mkdir(parents=True)
    (server / "server.properties").write_text("level-name=W\n")
    paths = build_paths(tmp_path / "app")
    ensure_runtime_dirs(paths)
    target = connect_target(ftp_storage)
    source = tmp_path / "addon.mcaddon"
    shutil.copy(ADDON, source)

    result = do_install(target, target.default_world(), paths, AppState(), sources=[source])

    assert result["stats"]["installed"] == 2
    assert (server / "behavior_packs" / "Addon BP-BP" / "notes.txt").exists()
    assert read_json(server / "worlds" / "W" / "world_behavior_packs.json") == [{"pack_id": ADDON_BP, "version": [1, 0, 0]}]


def test_install_reports_bad_sources_as_errors(tmp_path):
    paths, target, world, _ = run_setup(tmp_path)
    (paths.install_dir / "notes.txt").write_text("hi")
    (paths.install_dir / "broken.mcpack").write_bytes(b"not a zip")
    (paths.install_dir / "empty folder").mkdir()
    state = AppState()

    result = do_install(target, world, paths, state)

    assert result["stats"]["errors"] == 3
    warnings = "\n".join(state.warnings)
    assert "Unknown file type" in warnings
    assert "not a valid zip archive" in warnings
    assert "No manifest.json found anywhere inside 'empty folder'" in warnings
    assert (paths.install_dir / "notes.txt").exists()


def test_install_warns_about_missing_dependencies(tmp_path):
    paths, target, world, _ = run_setup(tmp_path)
    write_manifest(tmp_path / "src" / "pack", dependencies=[{"uuid": "99999999-9999-9999-9999-999999999999", "version": [1, 0, 0]}, {"module_name": "@minecraft/server"}])
    state = AppState()

    do_install(target, world, paths, state, sources=[tmp_path / "src" / "pack"])

    assert any("99999999-9999-9999-9999-999999999999" in warning and "NOT installed" in warning for warning in state.warnings)


# ---- preparing sources ------------------------------------------------------------------------------


def test_prepare_source_handles_nested_archives_and_folders(tmp_path):
    state = AppState()
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    shutil.copy(ADDON, bundle / "inner.mcaddon")
    write_manifest(bundle / "loose" / "Loose BP", uuid="77777777-7777-7777-7777-777777777777", name="Loose")
    (bundle / "__MACOSX").mkdir()
    write_manifest(bundle / "__MACOSX" / "ghost", uuid="88888888-8888-8888-8888-888888888888")
    outer = tmp_path / "outer.zip"
    make_zip_from_dir(bundle, outer)
    scratch = tmp_path / "scratch"
    scratch.mkdir()

    source = prepare_source(outer, scratch, state)

    assert sorted(pack.display_name for pack in source.packs) == ["Addon BP", "Addon RP", "Loose"]
    assert source.extracted is not None


def test_prepare_source_accepts_disguised_zip(tmp_path):
    disguised = tmp_path / "download.mcpack (1)"
    shutil.copy(MCPACK, disguised)
    scratch = tmp_path / "scratch"
    scratch.mkdir()

    source = prepare_source(disguised, scratch, AppState())

    assert [pack.uuid for pack in source.packs] == [PACK_RP]


def test_prepare_source_warns_on_single_pack_mcaddon_and_multi_pack_mcpack(tmp_path):
    state = AppState()
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    single = tmp_path / "single.mcaddon"
    shutil.copy(MCPACK, single)
    multi = tmp_path / "multi.mcpack"
    shutil.copy(ADDON, multi)

    prepare_source(single, scratch, state)
    prepare_source(multi, scratch, state)

    assert any("only contains 1 pack" in warning and "Behavior Pack" in warning for warning in state.warnings)
    assert any("is a .mcpack but contains 2 packs" in warning for warning in state.warnings)


def test_prepare_source_rejects_unsafe_archive(tmp_path):
    archive = tmp_path / "evil.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("../escape.txt", "x")
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    state = AppState()

    source = prepare_source(archive, scratch, state)

    assert source.ok is False
    assert any("unsafe archive paths" in warning for warning in state.warnings)
    assert not (tmp_path / "escape.txt").exists()


def test_safe_extract_rejects_absolute_paths(tmp_path):
    archive = tmp_path / "abs.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("/abs.txt", "x")

    with zipfile.ZipFile(archive) as zf, pytest.raises(UnsafeArchivePathError):
        _safe_extract_archive(zf, tmp_path / "out")


def test_extract_nested_archives_warns_on_bad_nested_files(tmp_path):
    folder = tmp_path / "f"
    folder.mkdir()
    (folder / "bad.mcpack").write_bytes(b"nope")
    state = AppState()

    assert extract_nested_archives(folder, state) is True
    assert any("not a valid archive" in warning for warning in state.warnings)
    assert not (folder / "bad.mcpack").exists()


def test_read_incoming_pack_validation(tmp_path):
    state = AppState()
    write_manifest(tmp_path / "skin", module_type="skin_pack")
    write_manifest(tmp_path / "weird", module_type="mystery")
    write_manifest(tmp_path / "nouuid", uuid="")
    (tmp_path / "corrupt").mkdir()
    (tmp_path / "corrupt" / "manifest.json").write_text("{")
    write_manifest(tmp_path / "beta", dependencies=[{"module_name": "@minecraft/server", "version": "1.9.0-beta"}])
    old = tmp_path / "old"
    write_manifest(old)
    data = read_json(old / "manifest.json")
    data["format_version"] = 1
    (old / "manifest.json").write_text(json.dumps(data))

    assert read_incoming_pack(tmp_path / "skin", "s", state) is None
    assert read_incoming_pack(tmp_path / "weird", "s", state) is None
    assert read_incoming_pack(tmp_path / "nouuid", "s", state) is None
    assert read_incoming_pack(tmp_path / "corrupt", "s", state) is None
    assert read_incoming_pack(tmp_path / "beta", "s", state, beta_enabled=False).uses_beta is True
    assert read_incoming_pack(old, "s", state) is not None

    warnings = "\n".join(state.warnings)
    assert "not a behavior or resource pack" in warnings
    assert "Cannot determine type" in warnings
    assert "has no UUID" in warnings
    assert "Corrupt manifest.json" in warnings
    assert "beta API versions" in warnings
    assert "format_version 1" in warnings


# ---- planning -------------------------------------------------------------------------------------


def test_plan_skips_duplicate_packs_within_one_batch(tmp_path):
    paths, target, world, _ = run_setup(tmp_path)
    write_manifest(tmp_path / "a" / "pack")
    write_manifest(tmp_path / "b" / "pack")
    state = AppState()
    incoming = [read_incoming_pack(tmp_path / "a" / "pack", "a.zip", state), read_incoming_pack(tmp_path / "b" / "pack", "b.zip", state)]

    plans = plan_install(target, world, incoming, PackIndex.build(target, world), load_world_packs(target, world))

    assert [plan.action for plan in plans] == ["upload", "skip"]
    assert "a.zip" in plans[1].reason


def test_plan_avoids_folder_name_clashes(tmp_path):
    paths, target, world, _ = run_setup(tmp_path)
    (paths.behavior_packs_dir / "Test Pack-BP").mkdir()
    write_manifest(tmp_path / "src" / "pack")
    pack = read_incoming_pack(tmp_path / "src" / "pack", "src", AppState())

    plans = plan_install(target, world, [pack], PackIndex.build(target, world), load_world_packs(target, world))

    assert plans[0].target_folder == "Test Pack-BP_2"


def test_naming_helpers():
    assert _clean_source_name("Cool Addon [BP] v1.2.3.mcpack") == "Cool Addon"
    assert _effective_pack_name("pack.name", tmp := __import__("pathlib").Path("folder"), "Nice Thing.mcaddon") == "Nice Thing"
    assert _effective_pack_name("Real Name", tmp) == "Real Name"
    assert _effective_pack_name("pack", tmp) == "folder"
    assert pack_folder_name("Cool: Pack!", tmp, "rp", set()) == "Cool Pack-RP"
    assert pack_folder_name("Already-BP", tmp, "bp", {"already-bp"}) == "Already-BP_2"
    assert pack_folder_name("???", tmp, "bp", set()) == "folder-BP"


def test_find_all_packs_skips_junk(tmp_path):
    write_manifest(tmp_path / "a")
    write_manifest(tmp_path / "__MACOSX" / "a")

    assert find_all_packs(tmp_path) == [tmp_path / "a"]


def test_move_to_processed_avoids_overwrite(tmp_path):
    processed = tmp_path / "processed"
    for _ in range(2):
        (tmp_path / "x.mcpack").write_text("x")
        move_to_processed(tmp_path / "x.mcpack", processed)
    (tmp_path / "folder").mkdir()
    move_to_processed(tmp_path / "folder", processed)

    assert sorted(p.name for p in processed.iterdir()) == ["folder", "x.mcpack", "x_2.mcpack"]


def test_check_dependencies_ignores_self_and_known(tmp_path):
    paths, target, world, _ = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "Dep", uuid="12121212-1212-1212-1212-121212121212")
    state = AppState()
    state.installed_packs = [
        {"uuid": PACK_UUID, "name": "P", "dependencies": [{"uuid": PACK_UUID}, {"uuid": "12121212-1212-1212-1212-121212121212"}, {"uuid": "dead"}]}
    ]

    warnings = check_dependencies(PackIndex.build(target, world), {"bp": [], "rp": []}, state)

    assert len(warnings) == 1 and "dead" in warnings[0]
