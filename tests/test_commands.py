import json
import sys
import types
import zipfile

import bedrock_pack_installer.commands as commands
from bedrock_pack_installer.commands import do_beta, do_doctor, do_rebuild, do_zip
from bedrock_pack_installer.console import AppState
from bedrock_pack_installer.paths import build_paths
from tests.helpers import PACK_UUID, PACK_VERSION, write_manifest, write_world_json


def test_do_zip_creates_archive_with_run_contents(tmp_path):
    paths = build_paths(tmp_path)
    paths.worlds_dir.mkdir(parents=True, exist_ok=True)
    paths.behavior_packs_dir.mkdir(parents=True, exist_ok=True)
    paths.resource_packs_dir.mkdir(parents=True, exist_ok=True)

    (paths.worlds_dir / "world.txt").write_text("world", encoding="utf-8")
    (paths.behavior_packs_dir / "bp.txt").write_text("bp", encoding="utf-8")
    (paths.resource_packs_dir / "rp.txt").write_text("rp", encoding="utf-8")

    state = AppState()
    do_zip(paths, state)

    zip_files = list(tmp_path.glob("Bedrock_Packs_*.zip"))
    assert len(zip_files) == 1

    with zipfile.ZipFile(zip_files[0]) as zf:
        assert set(zf.namelist()) == {
            "run/worlds/world.txt",
            "run/behavior_packs/bp.txt",
            "run/resource_packs/rp.txt",
        }
    assert any(action.kind == "create_zip" for action in state.actions)


def test_do_rebuild_rewrites_world_jsons_from_installed_packs(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True, exist_ok=True)
    write_manifest(paths.behavior_packs_dir / "BP One-BP", uuid="bp-uuid", version=PACK_VERSION, name="BP One")
    write_manifest(
        paths.resource_packs_dir / "RP One-RP",
        uuid="rp-uuid",
        version=PACK_VERSION,
        name="RP One",
        module_type="resources",
    )

    state = AppState()
    do_rebuild(world_dir, paths, state)

    assert (world_dir / "world_behavior_packs.json").read_text(encoding="utf-8").count("bp-uuid") == 1
    assert (world_dir / "world_resource_packs.json").read_text(encoding="utf-8").count("rp-uuid") == 1
    assert any(action.kind == "rebuild_world_json" for action in state.actions)


def test_do_rebuild_warns_for_missing_manifest_and_uuid(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True, exist_ok=True)
    (paths.behavior_packs_dir / "NoManifest").mkdir(parents=True, exist_ok=True)
    bad_rp = paths.resource_packs_dir / "NoUuid"
    write_manifest(bad_rp, uuid="", name="No Uuid", module_type="resources")

    state = AppState()
    do_rebuild(world_dir, paths, state)

    assert len(state.warnings) == 2
    assert "has no manifest.json" in state.warnings[0]
    assert "has no UUID" in state.warnings[1]


def test_do_beta_returns_when_level_dat_missing(tmp_path, capsys):
    world_dir = tmp_path / "ExampleWorld"
    world_dir.mkdir()

    do_beta(world_dir)

    assert "No level.dat found" in capsys.readouterr().out


def test_do_beta_enables_world_when_helper_returns_true(tmp_path, monkeypatch, capsys):
    world_dir = tmp_path / "ExampleWorld"
    world_dir.mkdir()
    (world_dir / "level.dat").write_bytes(b"dummy")

    monkeypatch.setitem(sys.modules, "nbtlib", types.SimpleNamespace())
    monkeypatch.setattr("bedrock_pack_installer.commands.enable_beta_apis", lambda _path: True)

    state = AppState()
    do_beta(world_dir, state)

    output = capsys.readouterr().out
    assert "Backup saved as level.dat.backup" in output
    assert "Beta APIs enabled" in output
    assert any(action.kind == "beta_backup" for action in state.actions)
    assert any(action.kind == "beta_toggle" and action.details["changed"] is True for action in state.actions)


def test_do_beta_reports_already_enabled_when_helper_returns_false(tmp_path, monkeypatch, capsys):
    world_dir = tmp_path / "ExampleWorld"
    world_dir.mkdir()
    (world_dir / "level.dat").write_bytes(b"dummy")

    monkeypatch.setitem(sys.modules, "nbtlib", types.SimpleNamespace())
    monkeypatch.setattr("bedrock_pack_installer.commands.enable_beta_apis", lambda _path: False)

    state = AppState()
    do_beta(world_dir, state)

    assert "already" in capsys.readouterr().out.lower()
    assert any(action.kind == "beta_toggle" and action.details["changed"] is False for action in state.actions)


def test_do_beta_reports_missing_nbtlib_when_level_dat_exists(tmp_path, monkeypatch, capsys):
    world_dir = tmp_path / "ExampleWorld"
    world_dir.mkdir()
    (world_dir / "level.dat").write_bytes(b"dummy")
    monkeypatch.delitem(sys.modules, "nbtlib", raising=False)

    real_import = __import__

    def fake_import(name, *args, **kwargs):
        if name == "nbtlib":
            raise ImportError("missing")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", fake_import)

    do_beta(world_dir)

    assert "nbtlib is required" in capsys.readouterr().out


def test_do_zip_warns_for_missing_run_folders(tmp_path):
    paths = build_paths(tmp_path)
    state = AppState()

    do_zip(paths, state)

    assert len(state.warnings) == 3


def test_run_dispatches_requested_commands(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "World"
    state = AppState()
    calls = []

    monkeypatch.setattr(commands, "do_doctor", lambda *_args: calls.append("doctor"))
    monkeypatch.setattr(commands, "do_rebuild", lambda *_args: calls.append("rebuild"))
    monkeypatch.setattr(commands, "do_beta", lambda *_args: calls.append("beta"))
    monkeypatch.setattr(commands, "do_zip", lambda *_args: calls.append("zip"))
    monkeypatch.setattr(commands, "do_install", lambda *_args, **_kwargs: calls.append("install"))

    commands.run(set(), world_dir, paths, state, duplicate_mode="keep-both")
    commands.run({"--beta", "--zip", "--rebuild", "--doctor"}, world_dir, paths, state)

    assert calls == ["install", "doctor", "rebuild", "beta", "zip"]


def test_do_doctor_reports_clean_state(tmp_path, capsys):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True, exist_ok=True)
    write_manifest(paths.behavior_packs_dir / "BP One-BP", uuid="bp-uuid", version=PACK_VERSION, name="BP One")
    write_manifest(paths.resource_packs_dir / "RP One-RP", uuid="rp-uuid", version=PACK_VERSION, name="RP One", module_type="resources")
    write_world_json(world_dir / "world_behavior_packs.json", [{"pack_id": "bp-uuid", "version": PACK_VERSION}])
    write_world_json(world_dir / "world_resource_packs.json", [{"pack_id": "rp-uuid", "version": PACK_VERSION}])

    state = AppState()
    do_doctor(world_dir, paths, state)

    output = capsys.readouterr().out
    assert "Audit clean." in output
    assert not state.warnings
    assert any(action.kind == "doctor_summary" for action in state.actions)


def test_do_doctor_reports_registration_and_dependency_problems(tmp_path, capsys):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "ExampleWorld"
    world_dir.mkdir(parents=True, exist_ok=True)
    write_manifest(paths.behavior_packs_dir / "BP One-BP", uuid=PACK_UUID, version=PACK_VERSION, name="BP One")
    write_world_json(world_dir / "world_behavior_packs.json", [{"pack_id": "missing-bp", "version": PACK_VERSION}])
    write_world_json(world_dir / "world_resource_packs.json", [])

    dep_manifest_dir = paths.resource_packs_dir / "RP One-RP"
    write_manifest(dep_manifest_dir, uuid="rp-uuid", version=PACK_VERSION, name="RP One", module_type="resources")
    dep_manifest_dir.joinpath("manifest.json").write_text(
        json.dumps(
            {
                "format_version": 2,
                "header": {"name": "RP One", "uuid": "rp-uuid", "version": [1, 0, 0]},
                "modules": [{"type": "resources", "uuid": "module-rp", "version": [1, 0, 0]}],
                "dependencies": [{"uuid": "missing-dep", "version": [1, 0, 0]}],
            }
        ),
        encoding="utf-8",
    )

    state = AppState()
    do_doctor(world_dir, paths, state)

    output = capsys.readouterr().out
    assert "missing on disk" in output
    assert "not registered" in output
    assert "depends on UUID missing-dep" in output
