import sys

import bedrock_pack_installer.cli as cli
from bedrock_pack_installer.cli import parse_args


def test_parse_args_defaults_to_no_flags():
    args = parse_args([])

    assert args.rebuild is False
    assert args.zip is False
    assert args.beta is False


def test_parse_args_accepts_combined_flags():
    args = parse_args(["--rebuild", "--beta", "--zip"])

    assert args.rebuild is True
    assert args.beta is True
    assert args.zip is True


def test_configure_output_uses_reconfigure_when_available(monkeypatch):
    calls = []

    class FakeStream:
        def reconfigure(self, **kwargs):
            calls.append(kwargs)

    monkeypatch.setattr(sys, "stdout", FakeStream())
    monkeypatch.setattr(sys, "stderr", FakeStream())

    cli.configure_output()

    assert calls == [
        {"encoding": "utf-8", "errors": "replace"},
        {"encoding": "utf-8", "errors": "replace"},
    ]


def test_flags_from_args_converts_namespace_to_flag_set():
    args = parse_args(["--rebuild", "--zip"])

    assert cli.flags_from_args(args) == {"--rebuild", "--zip"}


def test_move_cursor_wraps_up_and_down():
    assert cli._move_cursor(0, 3, "up") == 2
    assert cli._move_cursor(2, 3, "down") == 0
    assert cli._move_cursor(1, 3, "noop") == 1


def test_toggle_flag_adds_and_removes_selection():
    assert cli._toggle_flag(set(), "--beta") == {"--beta"}
    assert cli._toggle_flag({"--beta"}, "--beta") == set()


def test_prompt_flags_returns_empty_set_when_enter_is_pressed(monkeypatch):
    monkeypatch.setattr(cli, "_read_key", lambda: "\n")

    assert cli.prompt_flags() == set()


def test_prompt_flags_uses_arrows_and_space_to_select(monkeypatch):
    keys = iter(["\x1b[B", " ", "\x1b[B", " ", "\n"])
    monkeypatch.setattr(cli, "_read_key", lambda: next(keys))

    assert cli.prompt_flags() == {"--beta", "--zip"}


def test_prompt_flags_quits_on_q(monkeypatch):
    monkeypatch.setattr(cli, "_read_key", lambda: "q")

    try:
        cli.prompt_flags()
        assert False, "expected MenuExit"
    except cli.MenuExit:
        pass


def test_prompt_flags_quits_on_ctrl_c(monkeypatch):
    monkeypatch.setattr(cli, "_read_key", lambda: "\x03")

    try:
        cli.prompt_flags()
        assert False, "expected MenuExit"
    except cli.MenuExit:
        pass


def test_pause_before_exit_waits_in_interactive_terminal(monkeypatch):
    calls = []
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr("builtins.input", lambda prompt: calls.append(prompt) or "")

    cli.pause_before_exit()

    assert calls == ["\nPress Enter to exit..."]


def test_pause_before_exit_is_noop_when_not_interactive(monkeypatch):
    monkeypatch.setattr(cli, "is_interactive_terminal", lambda: False)
    monkeypatch.setattr(
        "builtins.input",
        lambda _prompt: (_ for _ in ()).throw(AssertionError("input should not be called")),
    )

    cli.pause_before_exit()
