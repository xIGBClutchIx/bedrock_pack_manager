import sys

import bedrock_pack_installer.cli as cli
from bedrock_pack_installer.cli import parse_args
from bedrock_pack_installer.logger import capture_run_logs


def test_parse_args_defaults_to_no_flags():
    args = parse_args([])

    assert args.rebuild is False
    assert args.zip is False
    assert args.beta is False
    assert args.doctor is False
    assert args.duplicate_mode == "replace"
    assert args.world_name is None
    assert args.world_path is None


def test_parse_args_accepts_combined_flags():
    args = parse_args(["--rebuild", "--beta", "--zip", "--doctor", "--duplicate-mode", "keep-both", "--world-name", "ExampleWorld"])

    assert args.rebuild is True
    assert args.beta is True
    assert args.zip is True
    assert args.doctor is True
    assert args.duplicate_mode == "keep-both"
    assert args.world_name == "ExampleWorld"


def test_configure_output_uses_reconfigure_when_available(monkeypatch):
    calls = []
    ansi_calls = []

    class FakeStream:
        def reconfigure(self, **kwargs):
            calls.append(kwargs)

    monkeypatch.setattr(sys, "stdout", FakeStream())
    monkeypatch.setattr(sys, "stderr", FakeStream())
    monkeypatch.setattr(cli, "enable_virtual_terminal", lambda: ansi_calls.append("enabled"))

    cli.configure_output()

    assert calls == [
        {"encoding": "utf-8", "errors": "replace"},
        {"encoding": "utf-8", "errors": "replace"},
    ]
    assert ansi_calls == ["enabled"]


def test_flags_from_args_converts_namespace_to_flag_set():
    args = parse_args(["--rebuild", "--zip"])

    assert cli.flags_from_args(args) == {"--rebuild", "--zip"}


def test_log_launch_context_writes_to_log_only(tmp_path, capsys):
    args = parse_args(["--beta", "--duplicate-mode", "keep-both", "--world-path", "ExampleWorld"])
    logs_dir = tmp_path / "logs"

    with capture_run_logs(logs_dir):
        cli.log_launch_context(["--beta", "--duplicate-mode", "keep-both", "--world-path", "ExampleWorld"], args)

    assert capsys.readouterr().out == ""
    log_text = (logs_dir / "latest.txt").read_text(encoding="utf-8")
    assert "Launch args: --beta --duplicate-mode keep-both --world-path ExampleWorld" in log_text
    assert "rebuild: False (default)" in log_text
    assert "beta: True (arg)" in log_text
    assert "duplicate_mode: keep-both (arg)" in log_text
    assert "world_name: (none) (default)" in log_text
    assert "world_path: ExampleWorld (arg)" in log_text


def test_log_run_settings_writes_to_log_only(tmp_path, capsys):
    logs_dir = tmp_path / "logs"

    with capture_run_logs(logs_dir):
        cli.log_run_settings({"--beta", "--rebuild"}, "interactive prompt")

    assert capsys.readouterr().out == ""
    log_text = (logs_dir / "latest.txt").read_text(encoding="utf-8")
    assert "Selection source: interactive prompt" in log_text
    assert "Effective flags: --beta, --rebuild" in log_text


def test_resolve_world_rejects_conflicting_world_flags(tmp_path):
    paths = cli.build_paths(tmp_path)
    args = parse_args(["--world-name", "WorldA", "--world-path", "WorldB"])

    try:
        cli.resolve_world(args, paths)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "either --world-name or --world-path" in str(exc)


def test_resolve_world_uses_world_name_when_provided(tmp_path):
    paths = cli.build_paths(tmp_path)
    world_dir = paths.worlds_dir / "WorldA"
    world_dir.mkdir(parents=True)
    args = parse_args(["--world-name", "WorldA"])

    resolved_world, source = cli.resolve_world(args, paths)

    assert resolved_world == world_dir
    assert source == "--world-name"


def test_resolve_world_raises_for_unknown_world_name(tmp_path):
    paths = cli.build_paths(tmp_path)
    args = parse_args(["--world-name", "MissingWorld"])

    try:
        cli.resolve_world(args, paths)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "MissingWorld" in str(exc)


def test_resolve_world_uses_world_path_when_provided(tmp_path):
    paths = cli.build_paths(tmp_path)
    world_dir = paths.worlds_dir / "WorldA"
    world_dir.mkdir(parents=True)
    args = parse_args(["--world-path", "WorldA"])

    resolved_world, source = cli.resolve_world(args, paths)

    assert resolved_world == world_dir.resolve()
    assert source == "--world-path"


def test_resolve_world_falls_back_to_prompt_selection(tmp_path, monkeypatch):
    paths = cli.build_paths(tmp_path)
    world_dir = paths.worlds_dir / "WorldA"
    world_dir.mkdir(parents=True)
    args = parse_args([])
    monkeypatch.setattr(cli, "select_world", lambda _worlds_dir: world_dir)

    resolved_world, source = cli.resolve_world(args, paths)

    assert resolved_world == world_dir
    assert source == "prompt"


def test_move_cursor_wraps_up_and_down():
    assert cli._move_cursor(0, 3, "up") == 2
    assert cli._move_cursor(2, 3, "down") == 0
    assert cli._move_cursor(1, 3, "noop") == 1


def test_toggle_flag_adds_and_removes_selection():
    assert cli._toggle_flag(set(), "--beta") == {"--beta"}
    assert cli._toggle_flag({"--beta"}, "--beta") == set()


def test_prompt_mode_returns_install_when_enter_is_pressed(monkeypatch):
    monkeypatch.setattr(cli, "read_keypress", lambda: "\n")

    assert cli.prompt_mode() == "install"


def test_prompt_mode_uses_arrows_and_enter_to_select_doctor(monkeypatch):
    keys = iter(["\x1b[B", "\n"])
    monkeypatch.setattr(cli, "read_keypress", lambda: next(keys))

    assert cli.prompt_mode() == "--doctor"


def test_prompt_install_flags_uses_arrows_and_space_to_select(monkeypatch):
    keys = iter([" ", "\x1b[B", " ", "\n"])
    monkeypatch.setattr(cli, "read_keypress", lambda: next(keys))

    assert cli.prompt_install_flags() == {"--rebuild", "--beta"}


def test_mode_menu_lines_show_primary_choices():
    lines = cli._mode_menu_lines(0)

    assert "Choose what to do" in lines[0]
    assert "Install Packs" in lines[2]
    assert "Audit World And Installed Packs" in lines[3]


def test_install_menu_lines_show_selection_count():
    lines = cli._install_menu_lines({"--rebuild"}, 0)

    assert lines[0] == ""
    assert "Install Packs (1 extra option(s))" in lines[1]
    assert "Select any extra steps before continuing" in lines[2]
    assert "Rebuild World Pack JSONs" in lines[4]


def test_prompt_mode_quits_on_q(monkeypatch):
    monkeypatch.setattr(cli, "read_keypress", lambda: "q")

    try:
        cli.prompt_mode()
        assert False, "expected MenuExit"
    except cli.MenuExit:
        pass


def test_prompt_install_flags_quits_on_ctrl_c(monkeypatch):
    monkeypatch.setattr(cli, "read_keypress", lambda: "\x03")

    try:
        cli.prompt_install_flags()
        assert False, "expected MenuExit"
    except cli.MenuExit:
        pass


def test_pause_before_exit_waits_in_interactive_terminal(monkeypatch):
    calls = []
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr("builtins.input", lambda prompt: calls.append(prompt) or "")

    cli.pause_before_exit()

    assert len(calls) == 1
    assert "Press Enter to exit..." in calls[0]


def test_pause_before_exit_is_noop_when_not_interactive(monkeypatch):
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)
    monkeypatch.setattr(
        "builtins.input",
        lambda _prompt: (_ for _ in ()).throw(AssertionError("input should not be called")),
    )

    cli.pause_before_exit()
