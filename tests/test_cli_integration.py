import shutil
import sys

import pytest
from bedrock_pack_manager import cli
from bedrock_pack_manager.paths import build_paths
from tests.conftest import FIXTURES
from tests.helpers import PACK_UUID, PACK_VERSION, read_json, write_manifest, write_world_json

ADDON = FIXTURES / "installed" / "addon.mcaddon"


@pytest.fixture
def app(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)

    def run_main(*argv):
        monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py", *argv])
        cli.main()

    return paths, run_main


def make_world(paths, name="ExampleWorld"):
    world = paths.worlds_dir / name
    world.mkdir(parents=True, exist_ok=True)
    return world


def test_zip_needs_no_world_and_writes_logs(app, monkeypatch):
    paths, run_main = app
    monkeypatch.setattr(cli, "select_world", lambda _target: (_ for _ in ()).throw(AssertionError("no world needed")))

    run_main("--zip-name", "backup.zip")

    assert (paths.base_dir / "backup.zip").exists()
    log_text = (paths.logs_dir / "latest.txt").read_text(encoding="utf-8")
    assert "Launch args: --zip-name backup.zip" in log_text
    assert "Effective flags: --zip, --zip-name=backup.zip" in log_text
    for directory in (paths.install_dir, paths.uninstall_dir, paths.installed_dir, paths.staging_dir, paths.backups_dir):
        assert directory.is_dir()


def test_default_run_installs_queue_into_named_world(app):
    paths, run_main = app
    world = make_world(paths)
    run_main("--world-name", "Missing")  # creates run/ and reports the error
    shutil.copy(ADDON, paths.install_dir / "addon.mcaddon")

    run_main("--world-name", "ExampleWorld")

    assert (paths.behavior_packs_dir / "Addon BP-BP" / "manifest.json").exists()
    assert len(read_json(world / "world_resource_packs.json")) == 1
    assert (paths.installed_dir / "addon.mcaddon").exists()


def test_dry_run_leaves_queue_alone(app, capsys):
    paths, run_main = app
    make_world(paths)
    run_main("--world-name", "Nope")
    shutil.copy(ADDON, paths.install_dir / "addon.mcaddon")

    run_main("--world-name", "ExampleWorld", "--dry-run")

    assert (paths.install_dir / "addon.mcaddon").exists()
    assert "Nothing was changed" in capsys.readouterr().out


def test_doctor_prompts_for_world_when_several_exist(app, monkeypatch, capsys):
    paths, run_main = app
    make_world(paths, "A")
    make_world(paths, "B")
    monkeypatch.setattr("builtins.input", lambda _prompt: "2")

    run_main("--doctor")

    output = capsys.readouterr().out
    assert "Selected: " in output and "B" in output
    assert "Audit World And Installed Packs" in output


def test_conflicting_world_flags_print_error(app, capsys):
    _paths, run_main = app

    run_main("--doctor", "--world-name", "A", "--world-path", "B")

    assert "either --world-name or --world-path" in capsys.readouterr().out


def test_corrupt_world_json_is_reported(app, capsys):
    paths, run_main = app
    world = make_world(paths)
    (world / "world_behavior_packs.json").write_text('[{"pack_id": "x"},', encoding="utf-8")

    run_main("--uninstall", "--world-name", "ExampleWorld")

    assert "Corrupt world pack JSON" in capsys.readouterr().out


def test_uninstall_picker_without_tty(app, monkeypatch):
    paths, run_main = app
    world = make_world(paths)
    write_manifest(paths.behavior_packs_dir / "Pack-BP")
    write_world_json(world / "world_behavior_packs.json", [{"pack_id": PACK_UUID, "version": PACK_VERSION}])
    monkeypatch.setattr("builtins.input", lambda _prompt: "1")

    run_main("--uninstall", "--world-name", "ExampleWorld")

    assert read_json(world / "world_behavior_packs.json") == []
    assert not (paths.behavior_packs_dir / "Pack-BP").exists()


def test_uninstall_with_nothing_registered(app, capsys):
    paths, run_main = app
    make_world(paths)

    run_main("--uninstall", "--world-name", "ExampleWorld")

    assert "No behavior or resource packs are registered" in capsys.readouterr().out


def test_remote_ftp_install(app, ftp_server, monkeypatch):
    paths, run_main = app
    server = ftp_server["root"]
    (server / "bedrock" / "worlds" / "Survival").mkdir(parents=True)
    (server / "bedrock" / "server.properties").write_text("level-name=Survival\n")
    monkeypatch.setenv("BPM_TEST_PW", "pw")
    run_main("--zip-name", "boot.zip")
    shutil.copy(ADDON, paths.install_dir / "addon.mcaddon")

    run_main("--remote", f"ftp://mc@127.0.0.1:{ftp_server['port']}/", "--password-env", "BPM_TEST_PW", "--world-name", "Survival")

    assert (server / "bedrock" / "behavior_packs" / "Addon BP-BP" / "manifest.json").exists()
    assert len(read_json(server / "bedrock" / "worlds" / "Survival" / "world_behavior_packs.json")) == 1
    assert "BPM_TEST_PW" not in (paths.logs_dir / "latest.txt").read_text(encoding="utf-8").split("Launch args:")[0]


def test_remote_connection_failure_is_reported(app, capsys):
    _paths, run_main = app

    run_main("--doctor", "--remote", "ftp://mc:pw@127.0.0.1:1/")

    assert "Could not connect" in capsys.readouterr().out


def test_serve_starts_web_ui_with_settings(app, monkeypatch):
    _paths, run_main = app
    calls = []
    monkeypatch.setattr("bedrock_pack_manager.web.server.run_server", lambda paths, **kwargs: calls.append(kwargs))

    run_main("--serve", "--no-browser", "--port", "9999", "--remote", "sftp://mc@host/srv", "--pack-scope", "world")

    assert calls[0]["port"] == 9999
    assert calls[0]["open_browser"] is False
    assert calls[0]["initial_settings"].host == "host"
    assert calls[0]["overrides"].pack_scope == "world"


# ---- interactive flows ----------------------------------------------------------------------------


@pytest.fixture
def interactive(app, monkeypatch):
    paths, run_main = app
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    events = []
    monkeypatch.setattr(cli, "pause_before_exit", lambda: events.append("pause"))
    monkeypatch.setattr(cli, "run", lambda flags, target, world, *_args, **_kwargs: events.append(("run", flags, world)))
    return paths, run_main, events


def test_interactive_mode_menu_then_world_then_edit(interactive, monkeypatch):
    paths, run_main, events = interactive
    make_world(paths)
    monkeypatch.setattr(cli, "prompt_mode", lambda _label=None: events.append("mode") or "edit")
    monkeypatch.setattr(cli, "prompt_edit_world_flags", lambda *_a: events.append("edit") or {"--beta", "--gamemode"})
    monkeypatch.setattr(cli, "prompt_gamemode", lambda *_a: "creative")

    run_main()

    assert events[:2] == ["mode", "edit"]
    assert events[2] == ("run", {"--beta", "--gamemode=creative"}, "worlds/ExampleWorld")
    assert events[-1] == "pause"


@pytest.mark.parametrize("mode, flags", [("--doctor", {"--doctor"}), ("--rebuild", {"--rebuild"}), ("--cleanup-pack-folders", {"--cleanup-pack-folders"})])
def test_interactive_simple_modes(interactive, monkeypatch, mode, flags):
    paths, run_main, events = interactive
    make_world(paths)
    monkeypatch.setattr(cli, "prompt_mode", lambda _label=None: mode)

    run_main()

    assert events[0] == ("run", flags, "worlds/ExampleWorld")


def test_interactive_install_mode_can_zip(interactive, monkeypatch):
    paths, run_main, events = interactive
    make_world(paths)
    monkeypatch.setattr(cli, "prompt_mode", lambda _label=None: "install")
    monkeypatch.setattr(cli, "prompt_zip_name", lambda *_a: "w.zip")

    run_main()

    assert events[0][1] == {"--zip", "--zip-name=w.zip"}


def test_interactive_uninstall_json_only(interactive, monkeypatch):
    paths, run_main, events = interactive
    world = make_world(paths)
    write_world_json(world / "world_behavior_packs.json", [{"pack_id": PACK_UUID, "version": PACK_VERSION}])
    monkeypatch.setattr(cli, "prompt_mode", lambda _label=None: "uninstall")
    monkeypatch.setattr(cli, "prompt_uninstall_mode", lambda *_a: "keep-files")
    monkeypatch.setattr(cli, "prompt_uninstall_flags", lambda candidates, *_a: {candidates[0]["flag"]})

    run_main()

    assert events[0][1] == {"--uninstall", "--uninstall-keep-files", f"--uninstall-pack=bp:{PACK_UUID}:1.0.0"}


def test_interactive_empty_edit_selection(interactive, monkeypatch, capsys):
    paths, run_main, _events = interactive
    make_world(paths)
    monkeypatch.setattr(cli, "prompt_mode", lambda _label=None: "edit")
    monkeypatch.setattr(cli, "prompt_edit_world_flags", lambda *_a: set())

    run_main()

    assert "Select at least one world edit option." in capsys.readouterr().out


def test_interactive_remote_then_serve(interactive, monkeypatch):
    _paths, run_main, _events = interactive
    modes = iter(["remote", "serve"])
    labels = []
    monkeypatch.setattr(cli, "prompt_mode", lambda label=None: labels.append(label) or next(modes))
    monkeypatch.setattr(cli, "prompt_text_value", lambda _label: "sftp://mc@host:2022/srv")
    served = []
    monkeypatch.setattr(cli, "serve", lambda _args, _paths, settings: served.append(settings))

    run_main()

    assert labels == [None, "sftp://mc@host:2022/srv"]
    assert served[0].port == 2022


def test_interactive_missing_worlds_message(interactive, monkeypatch, capsys):
    _paths, run_main, events = interactive
    monkeypatch.setattr(cli, "prompt_mode", lambda _label=None: "--doctor")

    run_main()

    assert "No worlds found in" in capsys.readouterr().out
    assert events == ["pause"]


def test_interactive_cancel(interactive, monkeypatch, capsys):
    _paths, run_main, events = interactive

    def cancel(_label=None):
        raise cli.MenuExit()

    monkeypatch.setattr(cli, "prompt_mode", cancel)

    run_main()

    assert "Cancelled." in capsys.readouterr().out
    assert events == ["pause"]
