import io
import struct
import sys
import zipfile

import bedrock_pack_manager.commands as commands
import nbtlib
import pytest
from bedrock_pack_manager.commands import (
    collect_uninstall_candidates,
    do_beta,
    do_cleanup_pack_folders,
    do_doctor,
    do_rebuild,
    do_set_gamemode,
    do_uninstall,
    do_zip,
    world_status,
)
from bedrock_pack_manager.console import AppState
from bedrock_pack_manager.nbt import read_level_dat
from tests.conftest import FIXTURES
from tests.helpers import PACK_UUID, PACK_VERSION, read_json, run_setup, write_manifest, write_world_json

OTHER_UUID = "33333333-3333-3333-3333-333333333333"


def write_level_dat(path, game_type=0, beta=False):
    root = nbtlib.Compound({"GameType": nbtlib.Int(game_type), "LevelName": nbtlib.String("Test Level")})
    if beta:
        root["experiments"] = nbtlib.Compound({"gametest": nbtlib.Byte(1)})
    buf = io.BytesIO()
    nbtlib.File(root).write(buf, byteorder="little")
    body = buf.getvalue()
    path.write_bytes(struct.pack("<II", 10, len(body)) + body)


def register(world_dir, kind, entries):
    name = "world_behavior_packs.json" if kind == "bp" else "world_resource_packs.json"
    write_world_json(world_dir / name, entries)


# ---- status & audit -------------------------------------------------------------------------------


def test_world_status_classifies_every_pack(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "Ok", name="Ok Pack", dependencies=[{"uuid": "deadbeef-0000-0000-0000-000000000000", "version": [1, 0, 0]}])
    write_manifest(paths.behavior_packs_dir / "Old", uuid=OTHER_UUID, version=[1, 0, 0], name="Old")
    write_manifest(paths.resource_packs_dir / "Stray", uuid="44444444-4444-4444-4444-444444444444", module_type="resources", name="Stray")
    register(
        world_dir,
        "bp",
        [
            {"pack_id": PACK_UUID, "version": PACK_VERSION},
            {"pack_id": OTHER_UUID, "version": [2, 0, 0]},
            {"pack_id": "55555555-5555-5555-5555-555555555555", "version": [1, 0, 0]},
            {"version": [1, 0, 0]},
        ],
    )
    write_level_dat(world_dir / "level.dat", game_type=1)

    status = world_status(target, world)

    by_name = {row["name"]: row for row in status["packs"]}
    assert by_name["Ok Pack"]["status"] == "ok"
    assert by_name["Old"]["status"] == "version-mismatch"
    assert by_name["Old"]["on_server_versions"] == ["1.0.0"]
    assert by_name["55555555-5555-5555-5555-555555555555"]["status"] == "missing"
    assert by_name["Stray"]["status"] == "unregistered"
    assert by_name["Stray"]["flag"] == ""
    assert any("no pack_id" in problem for problem in status["problems"])
    assert any("deadbeef" in problem for problem in status["problems"])
    assert status["level"] == {"exists": True, "beta": False, "gamemode": "creative", "level_name": "Test Level", "error": None}
    assert status["install_dirs"]["bp"].endswith("behavior_packs")


def test_world_status_reports_unreadable_level_dat(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    (world_dir / "level.dat").write_bytes(b"x")

    status = world_status(target, world)

    assert status["level"]["exists"] is True
    assert status["level"]["error"]


def test_doctor_reports_clean_state(tmp_path, capsys):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "Ok")
    register(world_dir, "bp", [{"pack_id": PACK_UUID, "version": PACK_VERSION}])
    state = AppState()

    do_doctor(target, world, state)

    assert state.warnings == []
    assert "Audit clean." in capsys.readouterr().out
    assert any(action.kind == "doctor_summary" for action in state.actions)


def test_doctor_reports_problems(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "Old", uuid=OTHER_UUID)
    write_manifest(paths.resource_packs_dir / "Stray", uuid="44444444-4444-4444-4444-444444444444", module_type="resources")
    (paths.resource_packs_dir / "leftover").mkdir()
    register(world_dir, "bp", [{"pack_id": PACK_UUID, "version": PACK_VERSION}, {"pack_id": OTHER_UUID, "version": [2, 0, 0]}])
    state = AppState()

    do_doctor(target, world, state)

    warnings = "\n".join(state.warnings)
    assert "missing on the server" in warnings
    assert "that version is not installed (found 1.0.0)" in warnings
    assert "installed but not registered" in warnings
    assert "leftover has no manifest.json" in warnings


# ---- rebuild & cleanup ----------------------------------------------------------------------------


def test_rebuild_registers_newest_version_of_each_pack(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "A v1", version=[1, 0, 0])
    write_manifest(paths.behavior_packs_dir / "A v2", version=[2, 0, 0])
    write_manifest(paths.resource_packs_dir / "R", uuid=OTHER_UUID, module_type="resources")
    write_manifest(paths.behavior_packs_dir / "Wrap" / "Nested", uuid="77777777-7777-7777-7777-777777777777")
    register(world_dir, "bp", [{"pack_id": "stale", "version": [1, 0, 0]}])
    state = AppState()

    result = do_rebuild(target, world, state)

    assert result == {"behavior_packs": 1, "resource_packs": 1}
    assert read_json(world_dir / "world_behavior_packs.json") == [{"pack_id": PACK_UUID, "version": [2, 0, 0]}]
    assert read_json(world_dir / "world_resource_packs.json") == [{"pack_id": OTHER_UUID, "version": PACK_VERSION}]
    assert any("several versions installed" in warning for warning in state.warnings)
    assert any("nested one folder too deep" in warning for warning in state.warnings)


def test_cleanup_deletes_only_unused_folders(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "Used")
    write_manifest(paths.behavior_packs_dir / "Unused", uuid=OTHER_UUID)
    write_manifest(paths.behavior_packs_dir / "Shared", uuid="88888888-8888-8888-8888-888888888888")
    register(world_dir, "bp", [{"pack_id": PACK_UUID, "version": PACK_VERSION}])
    other = paths.worlds_dir / "Other"
    register(other, "bp", [{"pack_id": "88888888-8888-8888-8888-888888888888", "version": PACK_VERSION}])

    preview = do_cleanup_pack_folders(target, world, AppState(), dry_run=True)
    assert [path.split("\\")[-1].split("/")[-1] for path in preview["deleted"]] == ["Unused"]
    assert (paths.behavior_packs_dir / "Unused").exists()

    state = AppState()
    result = do_cleanup_pack_folders(target, world, state)

    assert sorted(p.name for p in paths.behavior_packs_dir.iterdir()) == ["Shared", "Used"]
    assert len(result["deleted"]) == 1 and len(result["kept"]) == 1
    assert any(action.kind == "keep_shared_cleanup_pack" for action in state.actions)


def test_builtin_packs_are_hidden_and_never_touched(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "vanilla_1.21", uuid=OTHER_UUID, name="resourcePack.vanilla_server.name")
    write_manifest(paths.behavior_packs_dir / "Mine")

    status = world_status(target, world)
    assert [row["uuid"] for row in status["packs"]] == [PACK_UUID]
    assert status["hidden_builtin"] == 1

    do_cleanup_pack_folders(target, world, AppState())
    assert (paths.behavior_packs_dir / "vanilla_1.21").exists()
    assert not (paths.behavior_packs_dir / "Mine").exists()

    write_manifest(paths.behavior_packs_dir / "Mine")
    do_rebuild(target, world, AppState())
    assert read_json(world_dir / "world_behavior_packs.json") == [{"pack_id": PACK_UUID, "version": PACK_VERSION}]


def test_cleanup_reports_nothing_to_do(tmp_path, capsys):
    _paths, target, world, _ = run_setup(tmp_path)

    do_cleanup_pack_folders(target, world, AppState())

    assert "No unregistered pack folders to delete." in capsys.readouterr().out


# ---- uninstall ------------------------------------------------------------------------------------


def test_collect_uninstall_candidates(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "Pack-BP", name="Pack")
    register(world_dir, "bp", [{"pack_id": PACK_UUID, "version": PACK_VERSION}, {"pack_id": OTHER_UUID, "version": [1, 0, 0]}, {"pack_id": "x", "version": "bad"}])

    candidates = collect_uninstall_candidates(target, world)

    assert [candidate["name"] for candidate in candidates] == [OTHER_UUID, "Pack"]
    assert candidates[0]["details"] == "missing on the server"
    assert candidates[1]["flag"] == f"--uninstall-pack=bp:{PACK_UUID}:1.0.0"


def test_uninstall_removes_registration_and_files(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "Pack-BP")
    register(world_dir, "bp", [{"pack_id": PACK_UUID, "version": PACK_VERSION}])

    result = do_uninstall(target, world, paths, {f"--uninstall-pack=bp:{PACK_UUID}:1.0.0"}, AppState())

    assert result["removed"] == 1 and len(result["deleted"]) == 1
    assert read_json(world_dir / "world_behavior_packs.json") == []
    assert not (paths.behavior_packs_dir / "Pack-BP").exists()


def test_uninstall_keeps_files_used_by_another_world(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "Pack-BP")
    register(world_dir, "bp", [{"pack_id": PACK_UUID, "version": PACK_VERSION}])
    register(paths.worlds_dir / "Other", "bp", [{"pack_id": PACK_UUID, "version": PACK_VERSION}])
    state = AppState()

    do_uninstall(target, world, paths, {f"--uninstall-pack=bp:{PACK_UUID}:1.0.0"}, state)

    assert (paths.behavior_packs_dir / "Pack-BP").exists()
    assert any(action.kind == "keep_shared_pack_files" for action in state.actions)


def test_uninstall_deletes_world_local_copy_even_if_others_use_uuid(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_manifest(world_dir / "behavior_packs" / "Local")
    register(world_dir, "bp", [{"pack_id": PACK_UUID, "version": PACK_VERSION}])
    register(paths.worlds_dir / "Other", "bp", [{"pack_id": PACK_UUID, "version": PACK_VERSION}])

    do_uninstall(target, world, paths, {f"--uninstall-pack=bp:{PACK_UUID}:1.0.0"}, AppState())

    assert not (world_dir / "behavior_packs" / "Local").exists()


def test_uninstall_keep_files(tmp_path, capsys):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "Pack-BP")
    register(world_dir, "bp", [{"pack_id": PACK_UUID, "version": PACK_VERSION}])

    do_uninstall(target, world, paths, {f"--uninstall-pack=bp:{PACK_UUID}:1.0.0"}, AppState(), keep_files=True)

    assert (paths.behavior_packs_dir / "Pack-BP").exists()
    assert read_json(world_dir / "world_behavior_packs.json") == []
    assert "Kept installed pack folders" in capsys.readouterr().out


def test_uninstall_stale_registration(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    register(world_dir, "bp", [{"pack_id": PACK_UUID, "version": PACK_VERSION}])
    state = AppState()

    do_uninstall(target, world, paths, {f"--uninstall-pack=bp:{PACK_UUID}:1.0.0"}, state)

    assert any(action.message == "Removed stale pack registration" for action in state.actions)


def test_uninstall_rejects_unknown_selection(tmp_path):
    paths, target, world, _ = run_setup(tmp_path)

    with pytest.raises(ValueError, match="Unknown uninstall selection"):
        do_uninstall(target, world, paths, {"--uninstall-pack=bp:nope:1.0.0"}, AppState())


def test_uninstall_from_queue(tmp_path):
    import shutil

    paths, target, world, world_dir = run_setup(tmp_path)
    shutil.copy(FIXTURES / "installed" / "addon.mcaddon", paths.uninstall_dir / "addon.mcaddon")
    write_manifest(paths.behavior_packs_dir / "Addon BP-BP", uuid="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
    register(world_dir, "bp", [{"pack_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "version": [1, 0, 0]}])
    state = AppState()

    assert commands.has_uninstall_queue_entries(paths)
    do_uninstall(target, world, paths, set(), state)

    assert read_json(world_dir / "world_behavior_packs.json") == []
    assert (paths.uninstalled_dir / "addon.mcaddon").exists()
    assert any(action.kind == "skip_uninstall_queue_pack" for action in state.actions)


def test_uninstall_with_empty_queue_raises(tmp_path):
    paths, target, world, _ = run_setup(tmp_path)

    with pytest.raises(ValueError, match="No packs from run/uninstall"):
        do_uninstall(target, world, paths, set(), AppState())


# ---- zip ------------------------------------------------------------------------------------------


def test_zip_includes_worlds_and_pack_folders(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    (world_dir / "level.dat").write_bytes(b"L")
    write_manifest(paths.behavior_packs_dir / "B")
    state = AppState()

    result = do_zip(target, paths, state, zip_name="backup")

    assert result["zip_name"] == "backup.zip"
    with zipfile.ZipFile(paths.base_dir / "backup.zip") as zf:
        assert set(zf.namelist()) == {"worlds/ExampleWorld/level.dat", "behavior_packs/B/manifest.json"}
    assert any(action.kind == "create_zip" for action in state.actions)


def test_zip_single_world_to_output_dir(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    (world_dir / "level.dat").write_bytes(b"L")
    (paths.worlds_dir / "Other").mkdir()
    (paths.worlds_dir / "Other" / "level.dat").write_bytes(b"O")

    result = do_zip(target, paths, AppState(), output_dir=paths.backups_dir, world=world)

    with zipfile.ZipFile(result["zip_path"]) as zf:
        assert zf.namelist() == ["worlds/ExampleWorld/level.dat"]
    assert result["zip_name"].startswith("Bedrock_Packs_")


def test_zip_warns_for_missing_folders(tmp_path):
    paths, target, _world, _ = run_setup(tmp_path)
    paths.resource_packs_dir.rmdir()
    state = AppState()

    do_zip(target, paths, state)

    assert any("does not exist" in warning for warning in state.warnings)


# ---- level.dat edits ------------------------------------------------------------------------------


def test_beta_and_gamemode_edit_level_dat_with_backup(tmp_path, capsys):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_level_dat(world_dir / "level.dat")
    state = AppState()

    assert do_beta(target, world, state) == {"changed": True}
    assert do_beta(target, world, state) == {"changed": False}
    assert do_set_gamemode(target, world, "adventure", state) == {"changed": True}
    assert do_set_gamemode(target, world, "adventure", state) == {"changed": False}

    level = read_level_dat(target.storage, f"{world}/level.dat")
    assert level.beta_enabled and level.gamemode == "adventure"
    assert (world_dir / "level.dat.backup").exists()
    output = capsys.readouterr().out
    assert "already" in output and "Restart the server" in output


def test_level_dat_edits_skip_when_missing(tmp_path, capsys):
    _paths, target, world, _ = run_setup(tmp_path)
    state = AppState()

    assert do_beta(target, world, state) == {"changed": False}
    assert do_set_gamemode(target, world, "creative", state) == {"changed": False}
    assert "No level.dat found" in capsys.readouterr().out


def test_level_dat_edits_report_missing_nbtlib(tmp_path, monkeypatch, capsys):
    _paths, target, world, world_dir = run_setup(tmp_path)
    (world_dir / "level.dat").write_bytes(b"x")
    monkeypatch.setitem(sys.modules, "nbtlib", None)

    assert do_beta(target, world, AppState()) == {"changed": False}
    assert "nbtlib is required" in capsys.readouterr().out


# ---- dispatch -------------------------------------------------------------------------------------


def test_run_dispatches_requested_commands(tmp_path, monkeypatch):
    paths, target, world, _ = run_setup(tmp_path)
    calls = []
    for name in ["do_doctor", "do_uninstall", "do_cleanup_pack_folders", "do_rebuild", "do_beta", "do_set_gamemode", "do_zip", "do_install"]:
        monkeypatch.setattr(commands, name, lambda *args, _name=name, **kwargs: calls.append((_name, kwargs)))

    commands.run(
        {
            "--doctor",
            "--uninstall",
            "--uninstall-pack=bp:x:1",
            "--uninstall-keep-files",
            "--cleanup-pack-folders",
            "--rebuild",
            "--beta",
            "--gamemode=creative",
            "--zip",
            "--zip-name=a.zip",
        },
        target,
        world,
        paths,
        AppState(),
    )
    commands.run(set(), target, world, paths, AppState(), duplicate_mode="skip", reupload=True, dry_run=True)

    names = [name for name, _ in calls]
    assert names == ["do_doctor", "do_uninstall", "do_cleanup_pack_folders", "do_rebuild", "do_beta", "do_set_gamemode", "do_zip", "do_install"]
    assert calls[1][1] == {"keep_files": True}
    assert calls[6][1] == {"zip_name": "a.zip"}
    assert calls[7][1] == {"duplicate_mode": "skip", "reupload": True, "dry_run": True}


def test_parse_uninstall_flag():
    assert commands._parse_uninstall_flag("--uninstall-pack=bp:uuid:1.0.0") == ("bp", "uuid", "1.0.0")
    assert commands._parse_uninstall_flag("--uninstall-pack=bad") is None
    assert commands._parse_uninstall_flag("--other") is None
    assert commands._selected_gamemode({"--gamemode=bogus"}) is None
