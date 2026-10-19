import sys

import bedrock_pack_manager.cli as cli
from bedrock_pack_manager.cli import parse_args
from bedrock_pack_manager.layout import connect_target
from bedrock_pack_manager.logger import capture_run_logs
from bedrock_pack_manager.storage import LocalStorage, StorageError


def test_parse_args_defaults_to_no_flags():
    args = parse_args([])

    assert args.rebuild is False
    assert args.cleanup_pack_folders is False
    assert args.zip is False
    assert args.zip_name is None
    assert args.beta is False
    assert args.gamemode is None
    assert args.doctor is False
    assert args.uninstall is False
    assert args.uninstall_keep_files is False
    assert args.duplicate_mode == "replace"
    assert args.world_name is None
    assert args.world_path is None


def test_parse_args_accepts_combined_flags():
    args = parse_args(
        [
            "--rebuild",
            "--cleanup-pack-folders",
            "--beta",
            "--gamemode",
            "creative",
            "--zip",
            "--zip-name",
            "world.zip",
            "--doctor",
            "--uninstall",
            "--uninstall-keep-files",
            "--duplicate-mode",
            "keep-both",
            "--world-name",
            "ExampleWorld",
        ]
    )

    assert args.rebuild is True
    assert args.cleanup_pack_folders is True
    assert args.beta is True
    assert args.gamemode == "creative"
    assert args.zip is True
    assert args.zip_name == "world.zip"
    assert args.doctor is True
    assert args.uninstall is True
    assert args.uninstall_keep_files is True
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
    args = parse_args(["--rebuild", "--cleanup-pack-folders", "--zip-name", "world.zip", "--uninstall", "--uninstall-keep-files", "--gamemode", "adventure"])

    assert cli.flags_from_args(args) == {"--rebuild", "--cleanup-pack-folders", "--zip", "--zip-name=world.zip", "--uninstall", "--uninstall-keep-files", "--gamemode=adventure"}


def test_log_launch_context_writes_to_log_only(tmp_path, capsys):
    args = parse_args(
        [
            "--cleanup-pack-folders",
            "--beta",
            "--gamemode",
            "creative",
            "--zip-name",
            "world.zip",
            "--uninstall",
            "--uninstall-keep-files",
            "--duplicate-mode",
            "keep-both",
            "--world-path",
            "ExampleWorld",
        ]
    )
    logs_dir = tmp_path / "logs"

    with capture_run_logs(logs_dir):
        cli.log_launch_context(
            [
                "--cleanup-pack-folders",
                "--beta",
                "--gamemode",
                "creative",
                "--zip-name",
                "world.zip",
                "--uninstall",
                "--uninstall-keep-files",
                "--duplicate-mode",
                "keep-both",
                "--world-path",
                "ExampleWorld",
            ],
            args,
        )

    assert capsys.readouterr().out == ""
    log_text = (logs_dir / "latest.txt").read_text(encoding="utf-8")
    assert (
        "Launch args: --cleanup-pack-folders --beta --gamemode creative --zip-name world.zip "
        "--uninstall --uninstall-keep-files --duplicate-mode keep-both --world-path ExampleWorld"
    ) in log_text
    assert "rebuild: False (default)" in log_text
    assert "cleanup_pack_folders: True (arg)" in log_text
    assert "beta: True (arg)" in log_text
    assert "gamemode: creative (arg)" in log_text
    assert "zip_name: world.zip (arg)" in log_text
    assert "uninstall: True (arg)" in log_text
    assert "uninstall_keep_files: True (arg)" in log_text
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


def test_parse_args_accepts_remote_and_layout_flags():
    args = parse_args(
        [
            "--remote",
            "sftp://mc@host:2022/srv",
            "--password-env",
            "BPM_PW",
            "--key-file",
            "~/.ssh/id",
            "--trust-host-key",
            "SHA256:abc",
            "--allow-self-signed",
            "--active-mode",
            "--server-root",
            "bedrock",
            "--worlds-dir",
            "bedrock/worlds",
            "--bp-dir",
            "bp",
            "--rp-dir",
            "rp",
            "--pack-scope",
            "world",
            "--dry-run",
            "--reupload",
            "--serve",
            "--port",
            "9000",
            "--no-browser",
        ]
    )

    assert args.remote == "sftp://mc@host:2022/srv"
    assert args.pack_scope == "world"
    assert args.dry_run and args.reupload and args.serve and args.no_browser
    assert args.port == 9000
    overrides = cli.layout_overrides(args)
    assert (overrides.server_root, overrides.worlds_dir, overrides.bp_dir, overrides.rp_dir, overrides.pack_scope) == ("bedrock", "bedrock/worlds", "bp", "rp", "world")


def test_settings_from_args_reads_password_env_and_options(monkeypatch):
    monkeypatch.setenv("BPM_PW", "hunter2")
    args = parse_args(["--remote", "ftps://mc@host/mc", "--password-env", "BPM_PW", "--allow-self-signed", "--active-mode", "--trust-host-key", "SHA256:x"])

    settings = cli.settings_from_args(args)

    assert settings.protocol == "ftps"
    assert settings.password == "hunter2"
    assert settings.tls_verify is False
    assert settings.passive is False
    assert settings.trusted_fingerprint == "SHA256:x"


def test_settings_from_args_rejects_empty_password_env(monkeypatch):
    monkeypatch.delenv("BPM_MISSING", raising=False)
    args = parse_args(["--remote", "ftp://mc@host/", "--password-env", "BPM_MISSING"])

    try:
        cli.settings_from_args(args)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "BPM_MISSING" in str(exc)


def test_log_launch_context_redacts_passwords(tmp_path):
    argv = ["--remote", "ftp://mc:topsecret@host/"]
    with capture_run_logs(tmp_path / "logs"):
        cli.log_launch_context(argv, parse_args(argv))

    log_text = (tmp_path / "logs" / "latest.txt").read_text(encoding="utf-8")
    assert "topsecret" not in log_text
    assert "ftp://mc:***@host/" in log_text


def test_open_cli_target_defaults_to_run_folder(tmp_path):
    paths = cli.build_paths(tmp_path)
    cli.ensure_runtime_dirs(paths)

    target = cli.open_cli_target(cli.ConnectionSettings(), paths, cli.LayoutOverrides())

    assert target.storage.root == paths.run_dir
    assert target.layout.worlds_dir == "worlds"


def test_open_cli_target_prompts_to_trust_unknown_host_key(tmp_path, monkeypatch):
    from bedrock_pack_manager.storage.sftp import UnknownHostKeyError

    paths = cli.build_paths(tmp_path)
    calls = []

    def fake_open_storage(settings, **_kwargs):
        calls.append(settings.trusted_fingerprint)
        if not settings.trusted_fingerprint:
            raise UnknownHostKeyError("host", 22, "ssh-ed25519", "SHA256:abc")
        return LocalStorage(tmp_path)

    monkeypatch.setattr(cli, "open_storage", fake_open_storage)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _prompt: "y")

    target = cli.open_cli_target(cli.ConnectionSettings(protocol="sftp", host="host", username="mc"), paths, cli.LayoutOverrides())

    assert calls == ["", "SHA256:abc"]
    assert target.storage.root == tmp_path


def test_open_cli_target_explains_host_key_flag_when_not_interactive(tmp_path, monkeypatch):
    from bedrock_pack_manager.storage.sftp import UnknownHostKeyError

    def fake_open_storage(_settings, **_kwargs):
        raise UnknownHostKeyError("host", 22, "ssh-ed25519", "SHA256:abc")

    monkeypatch.setattr(cli, "open_storage", fake_open_storage)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)

    try:
        cli.open_cli_target(cli.ConnectionSettings(protocol="sftp", host="host"), cli.build_paths(tmp_path), cli.LayoutOverrides())
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "--trust-host-key SHA256:abc" in str(exc)


def test_open_cli_target_turns_storage_errors_into_value_errors(tmp_path, monkeypatch):
    def fake_open_storage(_settings, **_kwargs):
        raise StorageError("FTP login failed")

    monkeypatch.setattr(cli, "open_storage", fake_open_storage)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)

    try:
        cli.open_cli_target(cli.ConnectionSettings(protocol="ftp", host="host", password="x"), cli.build_paths(tmp_path), cli.LayoutOverrides())
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "login failed" in str(exc)


def _run_target(tmp_path):
    paths = cli.build_paths(tmp_path)
    cli.ensure_runtime_dirs(paths)
    return paths, connect_target(LocalStorage(paths.run_dir))


def test_resolve_world_rejects_conflicting_world_flags(tmp_path):
    _paths, target = _run_target(tmp_path)
    args = parse_args(["--world-name", "WorldA", "--world-path", "WorldB"])

    try:
        cli.resolve_world(args, target)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "either --world-name or --world-path" in str(exc)


def test_resolve_world_uses_world_name_when_provided(tmp_path):
    paths, target = _run_target(tmp_path)
    (paths.worlds_dir / "WorldA").mkdir(parents=True)
    args = parse_args(["--world-name", "WorldA"])

    resolved_world, source = cli.resolve_world(args, target)

    assert resolved_world == "worlds/WorldA"
    assert source == "--world-name"


def test_resolve_world_raises_for_unknown_world_name(tmp_path):
    _paths, target = _run_target(tmp_path)
    args = parse_args(["--world-name", "MissingWorld"])

    try:
        cli.resolve_world(args, target)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "MissingWorld" in str(exc)


def test_resolve_world_uses_world_path_when_provided(tmp_path):
    paths, target = _run_target(tmp_path)
    (paths.worlds_dir / "WorldA").mkdir(parents=True)
    args = parse_args(["--world-path", "WorldA"])

    resolved_world, source = cli.resolve_world(args, target)

    assert resolved_world == "worlds/WorldA"
    assert source == "--world-path"


def test_resolve_world_accepts_absolute_world_path(tmp_path):
    _paths, target = _run_target(tmp_path)
    elsewhere = tmp_path / "elsewhere" / "World"
    elsewhere.mkdir(parents=True)

    resolved_world, _source = cli.resolve_world(parse_args(["--world-path", str(elsewhere)]), target)

    assert target.storage.resolve(resolved_world) == elsewhere


def test_resolve_world_falls_back_to_prompt_selection(tmp_path, monkeypatch):
    _paths, target = _run_target(tmp_path)
    monkeypatch.setattr(cli, "select_world", lambda _target: "worlds/WorldA")

    resolved_world, source = cli.resolve_world(parse_args([]), target)

    assert resolved_world == "worlds/WorldA"
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
    keys = iter(["\x1b[B", "\x1b[B", "\x1b[B", "\n"])
    monkeypatch.setattr(cli, "read_keypress", lambda: next(keys))

    assert cli.prompt_mode() == "--doctor"


def test_prompt_mode_uses_arrows_and_enter_to_select_rebuild(monkeypatch):
    keys = iter(["\x1b[B", "\x1b[B", "\x1b[B", "\x1b[B", "\n"])
    monkeypatch.setattr(cli, "read_keypress", lambda: next(keys))

    assert cli.prompt_mode() == "--rebuild"


def test_prompt_mode_uses_arrows_and_enter_to_select_uninstall(monkeypatch):
    keys = iter(["\x1b[B", "\x1b[B", "\n"])
    monkeypatch.setattr(cli, "read_keypress", lambda: next(keys))

    assert cli.prompt_mode() == "uninstall"


def test_prompt_zip_name_returns_none_for_blank_input(monkeypatch):
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)
    monkeypatch.setattr("builtins.input", lambda _prompt: "")

    assert cli.prompt_zip_name() is None


def test_prompt_zip_name_returns_entered_name(monkeypatch):
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)
    monkeypatch.setattr("builtins.input", lambda _prompt: "world.zip")

    assert cli.prompt_zip_name() == "world.zip"


def test_prompt_zip_name_shows_selected_world(monkeypatch, capsys):
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)
    monkeypatch.setattr("builtins.input", lambda _prompt: "")

    assert cli.prompt_zip_name("worlds/ExampleWorld") is None
    output = capsys.readouterr().out
    assert output == ""


def test_prompt_zip_name_ctrl_c_raises_menu_exit(monkeypatch):
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr(cli, "read_keypress", lambda: "\x03")

    try:
        cli.prompt_zip_name()
        assert False, "expected MenuExit"
    except cli.MenuExit:
        pass


def test_prompt_zip_name_interactive_returns_entered_name(monkeypatch, capsys):
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    keys = iter(["w", "o", "r", "l", "d", ".", "z", "i", "p", "\n"])
    monkeypatch.setattr(cli, "read_keypress", lambda: next(keys))

    assert cli.prompt_zip_name() == "world.zip"
    assert "Zip output name" in capsys.readouterr().out


def test_prompt_edit_world_flags_uses_arrows_and_space_to_select(monkeypatch):
    keys = iter([" ", "\x1b[B", " ", "\n"])
    monkeypatch.setattr(cli, "read_keypress", lambda: next(keys))

    assert cli.prompt_edit_world_flags() == {"--beta", "--gamemode"}


def test_prompt_edit_world_flags_shows_selected_world(monkeypatch, capsys):
    monkeypatch.setattr(cli, "read_keypress", lambda: "\n")

    assert cli.prompt_edit_world_flags("worlds/ExampleWorld") == set()
    output = capsys.readouterr().out
    assert "Worlds" in output
    assert "Selected:" in output
    assert "ExampleWorld" in output
    assert "World: ExampleWorld" not in output


def test_prompt_gamemode_uses_arrows_and_enter(monkeypatch):
    keys = iter(["\x1b[B", "\n"])
    monkeypatch.setattr(cli, "read_keypress", lambda: next(keys))

    assert cli.prompt_gamemode() == "creative"


def test_prompt_gamemode_shows_selected_world(monkeypatch, capsys):
    monkeypatch.setattr(cli, "read_keypress", lambda: "\n")

    assert cli.prompt_gamemode("worlds/ExampleWorld") == "survival"
    output = capsys.readouterr().out
    assert "Worlds" in output
    assert "Selected:" in output
    assert "ExampleWorld" in output
    assert "World: ExampleWorld" not in output


def test_prompt_uninstall_mode_returns_remove_by_default(monkeypatch):
    monkeypatch.setattr(cli, "read_keypress", lambda: "\n")

    assert cli.prompt_uninstall_mode() == "remove"


def test_prompt_uninstall_mode_shows_selected_world(monkeypatch, capsys):
    monkeypatch.setattr(cli, "read_keypress", lambda: "\n")

    assert cli.prompt_uninstall_mode("worlds/ExampleWorld") == "remove"
    output = capsys.readouterr().out
    assert "Worlds" in output
    assert "Selected:" in output
    assert "ExampleWorld" in output
    assert "World: ExampleWorld" not in output


def test_prompt_uninstall_mode_uses_arrows_and_enter(monkeypatch):
    keys = iter(["\x1b[B", "\n"])
    monkeypatch.setattr(cli, "read_keypress", lambda: next(keys))

    assert cli.prompt_uninstall_mode() == "keep-files"


def test_prompt_uninstall_flags_uses_arrows_and_space_to_select(monkeypatch):
    candidates = [
        {"flag": "--uninstall-pack=bp:bp-uuid:1.0.0", "label": "[BP] BP One (v1.0.0)", "details": "behavior_packs/BP One-BP"},
        {"flag": "--uninstall-pack=rp:rp-uuid:1.0.0", "label": "[RP] RP One (v1.0.0)", "details": "resource_packs/RP One-RP"},
    ]
    keys = iter([" ", "\x1b[B", " ", "\n"])
    monkeypatch.setattr(cli, "read_keypress", lambda: next(keys))
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)

    assert cli.prompt_uninstall_flags(candidates) == {"--uninstall-pack=bp:bp-uuid:1.0.0", "--uninstall-pack=rp:rp-uuid:1.0.0"}


def test_prompt_uninstall_flags_uses_prompt_when_not_interactive(monkeypatch):
    candidates = [
        {"flag": "--uninstall-pack=bp:bp-uuid:1.0.0", "label": "[BP] BP One (v1.0.0)", "details": "behavior_packs/BP One-BP"},
        {"flag": "--uninstall-pack=rp:rp-uuid:1.0.0", "label": "[RP] RP One (v1.0.0)", "details": "resource_packs/RP One-RP"},
    ]
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)
    monkeypatch.setattr("builtins.input", lambda _prompt: "1,2")

    assert cli.prompt_uninstall_flags(candidates) == {"--uninstall-pack=bp:bp-uuid:1.0.0", "--uninstall-pack=rp:rp-uuid:1.0.0"}


def test_prompt_uninstall_flags_shows_selected_world_in_prompt_mode(monkeypatch, capsys):
    candidates = [
        {"flag": "--uninstall-pack=bp:bp-uuid:1.0.0", "label": "[BP] BP One (v1.0.0)", "details": "behavior_packs/BP One-BP"},
    ]
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)
    monkeypatch.setattr("builtins.input", lambda _prompt: "1")

    assert cli.prompt_uninstall_flags(candidates, "worlds/ExampleWorld") == {"--uninstall-pack=bp:bp-uuid:1.0.0"}
    output = capsys.readouterr().out
    assert "Worlds" in output
    assert "Selected:" in output
    assert "ExampleWorld" in output
    assert "World: ExampleWorld" not in output


def test_mode_menu_lines_show_primary_choices():
    lines = cli._mode_menu_lines(0)

    assert "Choose what to do" in lines[0]
    assert "Install Packs" in lines[2]
    assert "Edit World" in lines[3]
    assert "Uninstall Packs" in lines[4]
    assert "Audit World" in lines[5]
    assert "Rebuild JSONs (overwrites world pack JSONs)" in lines[6]
    assert "Cleanup Pack Folders (deletes unregistered pack folders)" in lines[7]
    assert "Connect To Remote Server" in lines[8]
    assert "Open Web UI" in lines[9]


def test_prompt_mode_shows_server_label(monkeypatch, capsys):
    monkeypatch.setattr(cli, "read_keypress", lambda: "\n")

    cli.prompt_mode("sftp://mc@host:22/")

    assert "Server: sftp://mc@host:22/" in capsys.readouterr().out


def test_selected_world_lines_mention_single_world():
    lines = cli._selected_world_lines("worlds/Only", 1)

    assert any("Only one world available" in line for line in lines)
    assert any("Only" in line for line in lines)
    assert cli._selected_world_lines(None) == []


def test_edit_world_menu_lines_show_selection_count():
    lines = cli._edit_world_menu_lines({"--beta"}, 0)

    assert lines[0] == ""
    assert "World Edits (1 change(s))" in lines[1]
    assert "write them to level.dat" in lines[2]
    assert "Enable Beta APIs" in lines[4]


def test_uninstall_menu_lines_show_selection_count():
    candidates = [
        {"flag": "--uninstall-pack=bp:bp-uuid:1.0.0", "label": "[BP] BP One (v1.0.0)", "details": "behavior_packs/BP One-BP"},
    ]
    lines = cli._uninstall_menu_lines(candidates, {"--uninstall-pack=bp:bp-uuid:1.0.0"}, 0)

    assert lines[0] == ""
    assert "Registered Packs (1 selected)" in lines[1]
    assert "Select one or more packs to remove from this world" in lines[2]
    assert "BP One" in lines[4]
    assert "behavior_packs/BP One-BP" in lines[5]


def test_uninstall_mode_menu_lines_show_choices():
    lines = cli._uninstall_mode_menu_lines(0)

    assert lines[0] == ""
    assert "Uninstall Mode" in lines[1]
    assert "removes now-unused pack folders" in lines[2]
    assert "Remove From World And Delete Unused Files" in lines[4]
    assert "Remove From World JSON Only" in lines[5]


def test_prompt_gamemode_menu_warns_about_level_dat_write(monkeypatch, capsys):
    monkeypatch.setattr(cli, "read_keypress", lambda: "\n")

    assert cli.prompt_gamemode() == "survival"
    output = capsys.readouterr().out
    assert "write to level.dat" in output


def test_prompt_mode_quits_on_q(monkeypatch):
    monkeypatch.setattr(cli, "read_keypress", lambda: "q")

    try:
        cli.prompt_mode()
        assert False, "expected MenuExit"
    except cli.MenuExit:
        pass


def test_prompt_edit_world_flags_quits_on_q(monkeypatch):
    monkeypatch.setattr(cli, "read_keypress", lambda: "q")

    try:
        cli.prompt_edit_world_flags()
        assert False, "expected MenuExit"
    except cli.MenuExit:
        pass


def test_prompt_uninstall_flags_quits_on_q(monkeypatch):
    candidates = [
        {"flag": "--uninstall-pack=bp:bp-uuid:1.0.0", "label": "[BP] BP One (v1.0.0)", "details": "behavior_packs/BP One-BP"},
    ]
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr(cli, "read_keypress", lambda: "q")

    try:
        cli.prompt_uninstall_flags(candidates)
        assert False, "expected MenuExit"
    except cli.MenuExit:
        pass


def test_prompt_uninstall_mode_quits_on_q(monkeypatch):
    monkeypatch.setattr(cli, "read_keypress", lambda: "q")

    try:
        cli.prompt_uninstall_mode()
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


def test_pause_before_exit_ignores_ctrl_c(monkeypatch):
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _prompt: (_ for _ in ()).throw(KeyboardInterrupt()))

    cli.pause_before_exit()


def test_pause_before_exit_is_noop_when_not_interactive(monkeypatch):
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)
    monkeypatch.setattr(
        "builtins.input",
        lambda _prompt: (_ for _ in ()).throw(AssertionError("input should not be called")),
    )

    cli.pause_before_exit()
