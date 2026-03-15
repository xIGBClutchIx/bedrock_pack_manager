import sys

from bedrock_pack_manager import cli
from bedrock_pack_manager.paths import build_paths


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
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py", "--zip"])

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
    assert "Bedrock Pack Manager" in log_text
    assert "CLI run output" in log_text
    assert "duplicate mode: replace" in log_text


def test_main_creates_runtime_directories_on_startup(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)
    monkeypatch.setattr(cli, "select_world", lambda _worlds_dir: (_ for _ in ()).throw(AssertionError("select_world should not be called for --zip")))
    monkeypatch.setattr(cli, "run", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py", "--zip"])

    cli.main()

    assert paths.run_dir.is_dir()
    assert paths.logs_dir.is_dir()
    assert paths.install_dir.is_dir()
    assert paths.uninstall_dir.is_dir()
    assert paths.installed_dir.is_dir()
    assert paths.uninstalled_dir.is_dir()
    assert paths.behavior_packs_dir.is_dir()
    assert paths.resource_packs_dir.is_dir()
    assert paths.worlds_dir.is_dir()


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
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py", "--doctor"])

    cli.main()

    assert calls == [({"--doctor"}, selected_world, "replace")]


def test_main_uses_world_name_without_prompt(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    selected_world = paths.worlds_dir / "ExampleWorld"
    selected_world.mkdir(parents=True)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)

    def fail_select_world(_worlds_dir):
        raise AssertionError("select_world should not be called when --world-name is provided")

    monkeypatch.setattr(cli, "select_world", fail_select_world)

    calls = []

    def fake_run(flags, world_dir, _paths, _state, duplicate_mode="replace"):
        calls.append((flags, world_dir, duplicate_mode))

    monkeypatch.setattr(cli, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py", "--doctor", "--world-name", "ExampleWorld"])

    cli.main()

    assert calls == [({"--doctor"}, selected_world, "replace")]


def test_main_prints_error_for_conflicting_world_flags(tmp_path, monkeypatch, capsys):
    paths = build_paths(tmp_path)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)
    monkeypatch.setattr(
        cli,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("run should not execute")),
    )
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py", "--doctor", "--world-name", "A", "--world-path", "B"])

    cli.main()

    assert "either --world-name or --world-path" in capsys.readouterr().out


def test_main_prints_clear_error_for_corrupt_world_pack_json(tmp_path, monkeypatch, capsys):
    paths = build_paths(tmp_path)
    selected_world = paths.worlds_dir / "ExampleWorld"
    selected_world.mkdir(parents=True)
    (selected_world / "world_behavior_packs.json").write_text('[{"pack_id":"bp","version":[1,0,0]},\n', encoding="utf-8")
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)
    monkeypatch.setattr(cli, "select_world", lambda _worlds_dir: selected_world)
    monkeypatch.setattr(
        cli,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("run should not execute")),
    )
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py", "--uninstall"])

    cli.main()

    output = capsys.readouterr().out
    assert "Corrupt world pack JSON" in output
    assert str(selected_world / "world_behavior_packs.json") in output


def test_main_uses_interactive_menu_and_pauses_before_exit(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr(cli, "prompt_mode", lambda _world=None: "install")
    monkeypatch.setattr(cli, "prompt_zip_name", lambda _world=None: "world.zip")
    monkeypatch.setattr(cli, "select_world", lambda _worlds_dir: paths.worlds_dir / "ExampleWorld")

    calls = []

    def fake_run(flags, world_dir, _paths, _state, duplicate_mode="replace"):
        calls.append((flags, world_dir, duplicate_mode))

    monkeypatch.setattr(cli, "run", fake_run)
    monkeypatch.setattr(cli, "pause_before_exit", lambda: calls.append(("pause", None)))
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py"])

    cli.main()

    assert calls[0][0] == {"--zip", "--zip-name=world.zip"}
    assert calls[0][2] == "replace"
    assert calls[1] == ("pause", None)


def test_main_shows_interactive_mode_menu_before_selecting_world(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    selected_world = paths.worlds_dir / "ExampleWorld"
    selected_world.mkdir(parents=True)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    events = []

    def fake_select_world(_worlds_dir):
        events.append("select_world")
        return selected_world

    def fake_prompt_mode(_world=None):
        events.append("prompt_mode")
        return "install"

    monkeypatch.setattr(cli, "select_world", fake_select_world)
    monkeypatch.setattr(cli, "prompt_mode", fake_prompt_mode)
    monkeypatch.setattr(cli, "prompt_zip_name", lambda _world=None: None)
    monkeypatch.setattr(cli, "run", lambda *_args, **_kwargs: events.append("run"))
    monkeypatch.setattr(cli, "pause_before_exit", lambda: events.append("pause"))
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py"])

    cli.main()

    assert events[:2] == ["prompt_mode", "select_world"]


def test_main_interactive_install_selects_world_before_prompting_for_zip_name(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    selected_world = paths.worlds_dir / "ExampleWorld"
    selected_world.mkdir(parents=True)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    events = []

    def fake_prompt_mode(_world=None):
        events.append("prompt_mode")
        return "install"

    def fake_select_world(_worlds_dir):
        events.append("select_world")
        return selected_world

    def fake_prompt_zip_name(_world=None):
        events.append("prompt_zip_name")
        return None

    monkeypatch.setattr(cli, "prompt_mode", fake_prompt_mode)
    monkeypatch.setattr(cli, "select_world", fake_select_world)
    monkeypatch.setattr(cli, "prompt_zip_name", fake_prompt_zip_name)
    monkeypatch.setattr(cli, "run", lambda *_args, **_kwargs: events.append("run"))
    monkeypatch.setattr(cli, "pause_before_exit", lambda: events.append("pause"))
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py"])

    cli.main()

    assert events[:3] == ["prompt_mode", "select_world", "prompt_zip_name"]


def test_main_interactive_edit_selects_world_before_prompting_for_edit_options(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    selected_world = paths.worlds_dir / "ExampleWorld"
    selected_world.mkdir(parents=True)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    events = []

    def fake_prompt_mode(_world=None):
        events.append("prompt_mode")
        return "edit"

    def fake_select_world(_worlds_dir):
        events.append("select_world")
        return selected_world

    def fake_prompt_edit_world_flags(_world=None):
        events.append("prompt_edit_world_flags")
        return {"--beta"}

    monkeypatch.setattr(cli, "prompt_mode", fake_prompt_mode)
    monkeypatch.setattr(cli, "select_world", fake_select_world)
    monkeypatch.setattr(cli, "prompt_edit_world_flags", fake_prompt_edit_world_flags)
    monkeypatch.setattr(cli, "run", lambda *_args, **_kwargs: events.append("run"))
    monkeypatch.setattr(cli, "pause_before_exit", lambda: events.append("pause"))
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py"])

    cli.main()

    assert events[:3] == ["prompt_mode", "select_world", "prompt_edit_world_flags"]


def test_main_interactive_uninstall_selects_world_before_prompting_for_uninstall_mode(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    selected_world = paths.worlds_dir / "ExampleWorld"
    selected_world.mkdir(parents=True)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    events = []
    candidates = [{"flag": "--uninstall-pack=bp:bp-uuid:1.0.0", "label": "[BP] BP One (v1.0.0)", "details": "behavior_packs/BP One-BP"}]

    def fake_prompt_mode(_world=None):
        events.append("prompt_mode")
        return "uninstall"

    def fake_select_world(_worlds_dir):
        events.append("select_world")
        return selected_world

    def fake_prompt_uninstall_mode(_world=None):
        events.append("prompt_uninstall_mode")
        return "remove"

    monkeypatch.setattr(cli, "prompt_mode", fake_prompt_mode)
    monkeypatch.setattr(cli, "select_world", fake_select_world)
    monkeypatch.setattr(cli, "prompt_uninstall_mode", fake_prompt_uninstall_mode)
    monkeypatch.setattr(cli, "collect_uninstall_candidates", lambda _world_dir, _paths: candidates)
    monkeypatch.setattr(cli, "prompt_uninstall_flags", lambda _candidates, _world=None: {"--uninstall-pack=bp:bp-uuid:1.0.0"})
    monkeypatch.setattr(cli, "run", lambda *_args, **_kwargs: events.append("run"))
    monkeypatch.setattr(cli, "pause_before_exit", lambda: events.append("pause"))
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py"])

    cli.main()

    assert events[:3] == ["prompt_mode", "select_world", "prompt_uninstall_mode"]


def test_main_interactive_mode_shows_missing_world_error_and_pauses(tmp_path, monkeypatch, capsys):
    paths = build_paths(tmp_path)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr(cli, "prompt_mode", lambda _world=None: "--doctor")
    pause_calls = []

    monkeypatch.setattr(cli, "pause_before_exit", lambda: pause_calls.append("pause"))
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py"])

    cli.main()

    output = capsys.readouterr().out
    assert "No worlds found in" in output
    assert "run/worlds" in output
    assert pause_calls == ["pause"]


def test_main_uses_interactive_rebuild_mode(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    selected_world = paths.worlds_dir / "ExampleWorld"
    selected_world.mkdir(parents=True)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr(cli, "select_world", lambda _worlds_dir: selected_world)
    monkeypatch.setattr(cli, "prompt_mode", lambda _world=None: "--rebuild")

    calls = []

    def fake_run(flags, world_dir, _paths, _state, duplicate_mode="replace"):
        calls.append((flags, world_dir, duplicate_mode))

    monkeypatch.setattr(cli, "run", fake_run)
    monkeypatch.setattr(cli, "pause_before_exit", lambda: calls.append(("pause", None)))
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py"])

    cli.main()

    assert calls[0][0] == {"--rebuild"}
    assert calls[0][1] == selected_world
    assert calls[1] == ("pause", None)


def test_main_uses_interactive_edit_menu_and_applies_multiple_world_edits(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr(cli, "prompt_mode", lambda _world=None: "edit")
    monkeypatch.setattr(cli, "prompt_edit_world_flags", lambda _world=None: {"--beta", "--gamemode"})
    monkeypatch.setattr(cli, "prompt_gamemode", lambda _world=None: "creative")
    monkeypatch.setattr(cli, "select_world", lambda _worlds_dir: paths.worlds_dir / "ExampleWorld")

    calls = []

    def fake_run(flags, world_dir, _paths, _state, duplicate_mode="replace"):
        calls.append((flags, world_dir, duplicate_mode))

    monkeypatch.setattr(cli, "run", fake_run)
    monkeypatch.setattr(cli, "pause_before_exit", lambda: calls.append(("pause", None)))
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py"])

    cli.main()

    assert calls[0][0] == {"--beta", "--gamemode=creative"}
    assert calls[0][2] == "replace"
    assert calls[1] == ("pause", None)


def test_main_uses_interactive_uninstall_menu_and_applies_selection(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    selected_world = paths.worlds_dir / "ExampleWorld"
    selected_world.mkdir(parents=True)
    candidates = [{"flag": "--uninstall-pack=bp:bp-uuid:1.0.0", "label": "[BP] BP One (v1.0.0)", "details": "behavior_packs/BP One-BP"}]
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr(cli, "prompt_mode", lambda _world=None: "uninstall")
    monkeypatch.setattr(cli, "prompt_uninstall_mode", lambda _world=None: "remove")
    monkeypatch.setattr(cli, "select_world", lambda _worlds_dir: selected_world)
    monkeypatch.setattr(cli, "collect_uninstall_candidates", lambda _world_dir, _paths: candidates)
    monkeypatch.setattr(cli, "prompt_uninstall_flags", lambda _candidates, _world=None: {"--uninstall-pack=bp:bp-uuid:1.0.0"})

    calls = []

    def fake_run(flags, world_dir, _paths, _state, duplicate_mode="replace"):
        calls.append((flags, world_dir, duplicate_mode))

    monkeypatch.setattr(cli, "run", fake_run)
    monkeypatch.setattr(cli, "pause_before_exit", lambda: calls.append(("pause", None)))
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py"])

    cli.main()

    assert calls[0][0] == {"--uninstall", "--uninstall-pack=bp:bp-uuid:1.0.0"}
    assert calls[0][1] == selected_world
    assert calls[1] == ("pause", None)


def test_main_uses_interactive_uninstall_json_only_mode(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    selected_world = paths.worlds_dir / "ExampleWorld"
    selected_world.mkdir(parents=True)
    candidates = [{"flag": "--uninstall-pack=bp:bp-uuid:1.0.0", "label": "[BP] BP One (v1.0.0)", "details": "behavior_packs/BP One-BP"}]
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr(cli, "prompt_mode", lambda _world=None: "uninstall")
    monkeypatch.setattr(cli, "prompt_uninstall_mode", lambda _world=None: "keep-files")
    monkeypatch.setattr(cli, "select_world", lambda _worlds_dir: selected_world)
    monkeypatch.setattr(cli, "collect_uninstall_candidates", lambda _world_dir, _paths: candidates)
    monkeypatch.setattr(cli, "prompt_uninstall_flags", lambda _candidates, _world=None: {"--uninstall-pack=bp:bp-uuid:1.0.0"})

    calls = []

    def fake_run(flags, world_dir, _paths, _state, duplicate_mode="replace"):
        calls.append((flags, world_dir, duplicate_mode))

    monkeypatch.setattr(cli, "run", fake_run)
    monkeypatch.setattr(cli, "pause_before_exit", lambda: calls.append(("pause", None)))
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py"])

    cli.main()

    assert calls[0][0] == {"--uninstall", "--uninstall-keep-files", "--uninstall-pack=bp:bp-uuid:1.0.0"}
    assert calls[0][1] == selected_world
    assert calls[1] == ("pause", None)


def test_main_rejects_empty_uninstall_selection(tmp_path, monkeypatch, capsys):
    paths = build_paths(tmp_path)
    selected_world = paths.worlds_dir / "ExampleWorld"
    selected_world.mkdir(parents=True)
    candidates = [{"flag": "--uninstall-pack=bp:bp-uuid:1.0.0", "label": "[BP] BP One (v1.0.0)", "details": "behavior_packs/BP One-BP"}]
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr(cli, "prompt_mode", lambda _world=None: "uninstall")
    monkeypatch.setattr(cli, "prompt_uninstall_mode", lambda _world=None: "remove")
    monkeypatch.setattr(cli, "select_world", lambda _worlds_dir: selected_world)
    monkeypatch.setattr(cli, "collect_uninstall_candidates", lambda _world_dir, _paths: candidates)
    monkeypatch.setattr(cli, "prompt_uninstall_flags", lambda _candidates, _world=None: set())
    monkeypatch.setattr(
        cli,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("run should not execute")),
    )
    pause_calls = []
    monkeypatch.setattr(cli, "pause_before_exit", lambda: pause_calls.append("pause"))
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py"])

    cli.main()

    assert "Select at least one pack to uninstall." in capsys.readouterr().out
    assert pause_calls == ["pause"]


def test_main_reports_when_world_has_no_packs_to_uninstall(tmp_path, monkeypatch, capsys):
    paths = build_paths(tmp_path)
    selected_world = paths.worlds_dir / "ExampleWorld"
    selected_world.mkdir(parents=True)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)
    monkeypatch.setattr(cli, "select_world", lambda _worlds_dir: selected_world)
    monkeypatch.setattr(cli, "collect_uninstall_candidates", lambda _world_dir, _paths: [])
    monkeypatch.setattr(
        cli,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("run should not execute")),
    )
    pause_calls = []
    monkeypatch.setattr(cli, "pause_before_exit", lambda: pause_calls.append("pause"))
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py", "--uninstall"])

    cli.main()

    assert "No behavior or resource packs are registered in this world." in capsys.readouterr().out
    assert pause_calls == ["pause"]


def test_main_skips_uninstall_picker_when_queue_folder_has_entries(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    selected_world = paths.worlds_dir / "ExampleWorld"
    selected_world.mkdir(parents=True)
    paths.uninstall_dir.mkdir(parents=True)
    (paths.uninstall_dir / "Queued Pack").mkdir()
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)
    monkeypatch.setattr(cli, "select_world", lambda _worlds_dir: selected_world)
    monkeypatch.setattr(
        cli,
        "prompt_uninstall_flags",
        lambda _candidates: (_ for _ in ()).throw(AssertionError("prompt should not execute when uninstall queue is populated")),
    )
    calls = []

    def fake_run(flags, world_dir, _paths, _state, duplicate_mode="replace"):
        calls.append((flags, world_dir, duplicate_mode))

    monkeypatch.setattr(cli, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py", "--uninstall", "--uninstall-keep-files"])

    cli.main()

    assert calls == [({"--uninstall", "--uninstall-keep-files"}, selected_world, "replace")]


def test_main_rejects_empty_interactive_edit_selection(tmp_path, monkeypatch, capsys):
    paths = build_paths(tmp_path)
    selected_world = paths.worlds_dir / "ExampleWorld"
    selected_world.mkdir(parents=True)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr(cli, "prompt_mode", lambda _world=None: "edit")
    monkeypatch.setattr(cli, "prompt_edit_world_flags", lambda _world=None: set())
    monkeypatch.setattr(cli, "select_world", lambda _worlds_dir: selected_world)
    monkeypatch.setattr(
        cli,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("run should not execute")),
    )
    pause_calls = []
    monkeypatch.setattr(cli, "pause_before_exit", lambda: pause_calls.append("pause"))
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py"])

    cli.main()

    assert "Select at least one world edit option." in capsys.readouterr().out
    assert pause_calls == ["pause"]


def test_main_cancels_cleanly_from_interactive_menu(tmp_path, monkeypatch, capsys):
    paths = build_paths(tmp_path)
    selected_world = paths.worlds_dir / "ExampleWorld"
    selected_world.mkdir(parents=True)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr(cli, "prompt_mode", lambda _world=None: (_ for _ in ()).throw(cli.MenuExit()))
    monkeypatch.setattr(
        cli,
        "select_world",
        lambda _worlds_dir: selected_world,
    )
    monkeypatch.setattr(
        cli,
        "run",
        lambda *_args: (_ for _ in ()).throw(AssertionError("run should not execute")),
    )
    pause_calls = []
    monkeypatch.setattr(cli, "pause_before_exit", lambda: pause_calls.append("pause"))
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_manager.py"])

    cli.main()

    assert "Cancelled." in capsys.readouterr().out
    assert pause_calls == ["pause"]
