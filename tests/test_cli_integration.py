import sys

from bedrock_pack_installer import cli
from bedrock_pack_installer.paths import build_paths


def test_main_writes_log_file_for_cli_run(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)

    def fail_select_world(_worlds_dir):
        raise AssertionError("select_world should not be called for --zip")

    monkeypatch.setattr(cli, "select_world", fail_select_world)

    def fake_run(_flags, _world_dir, _paths, _state, duplicate_mode="replace"):
        print("CLI run output")
        print(f"duplicate mode: {duplicate_mode}")

    monkeypatch.setattr(cli, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_installer.py", "--zip"])

    cli.main()

    assert (paths.logs_dir / "latest.txt").exists()
    log_text = (paths.logs_dir / "latest.txt").read_text(encoding="utf-8")
    assert "Launch Context" in log_text
    assert "Launch args: --zip" in log_text
    assert "zip: True (arg)" in log_text
    assert "duplicate_mode: replace (default)" in log_text
    assert "Run Settings" in log_text
    assert "Selection source: cli args/defaults" in log_text
    assert "Effective flags: --zip" in log_text
    assert "Bedrock Pack Installer" in log_text
    assert "CLI run output" in log_text
    assert "duplicate mode: replace" in log_text


def test_main_selects_world_for_doctor(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)
    selected_world = paths.worlds_dir / "ExampleWorld"
    calls = []

    monkeypatch.setattr(cli, "select_world", lambda _worlds_dir: selected_world)

    def fake_run(flags, world_dir, _paths, _state, duplicate_mode="replace"):
        calls.append((flags, world_dir, duplicate_mode))

    monkeypatch.setattr(cli, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_installer.py", "--doctor"])

    cli.main()

    assert calls == [({"--doctor"}, selected_world, "replace")]


def test_main_uses_interactive_menu_and_pauses_before_exit(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr(cli, "prompt_mode", lambda: "install")
    monkeypatch.setattr(cli, "prompt_install_flags", lambda: {"--beta"})
    monkeypatch.setattr(cli, "select_world", lambda _worlds_dir: paths.worlds_dir / "ExampleWorld")

    calls = []

    def fake_run(flags, world_dir, _paths, _state, duplicate_mode="replace"):
        calls.append((flags, world_dir, duplicate_mode))

    monkeypatch.setattr(cli, "run", fake_run)
    monkeypatch.setattr(cli, "pause_before_exit", lambda: calls.append(("pause", None)))
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_installer.py"])

    cli.main()

    assert calls[0][0] == {"--beta"}
    assert calls[0][2] == "replace"
    assert calls[1] == ("pause", None)


def test_main_cancels_cleanly_from_interactive_menu(tmp_path, monkeypatch, capsys):
    paths = build_paths(tmp_path)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr(cli, "prompt_mode", lambda: (_ for _ in ()).throw(cli.MenuExit()))
    monkeypatch.setattr(
        cli,
        "select_world",
        lambda _worlds_dir: (_ for _ in ()).throw(AssertionError("select_world should not run")),
    )
    monkeypatch.setattr(
        cli,
        "run",
        lambda *_args: (_ for _ in ()).throw(AssertionError("run should not execute")),
    )
    monkeypatch.setattr(
        cli,
        "pause_before_exit",
        lambda: (_ for _ in ()).throw(AssertionError("pause should not execute after cancel")),
    )
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_installer.py"])

    cli.main()

    assert "Cancelled." in capsys.readouterr().out
