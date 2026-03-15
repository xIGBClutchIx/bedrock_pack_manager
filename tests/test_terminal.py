import sys

from bedrock_pack_manager import terminal


def test_read_keypress_uses_windows_reader_when_running_on_windows(monkeypatch):
    monkeypatch.setattr(terminal, "_is_windows", lambda: True)
    monkeypatch.setattr(terminal, "_read_windows_keypress", lambda: "\x1b[B")
    monkeypatch.setattr(
        terminal,
        "_read_posix_keypress",
        lambda: (_ for _ in ()).throw(AssertionError("POSIX reader should not run on Windows")),
    )

    assert terminal.read_keypress() == "\x1b[B"


def test_read_keypress_uses_posix_reader_when_not_running_on_windows(monkeypatch):
    monkeypatch.setattr(terminal, "_is_windows", lambda: False)
    monkeypatch.setattr(terminal, "_read_posix_keypress", lambda: "q")
    monkeypatch.setattr(
        terminal,
        "_read_windows_keypress",
        lambda: (_ for _ in ()).throw(AssertionError("Windows reader should not run on POSIX")),
    )

    assert terminal.read_keypress() == "q"


def test_translate_windows_keypress_maps_arrow_sequences():
    assert terminal._translate_windows_keypress("\xe0", lambda: "H") == "\x1b[A"
    assert terminal._translate_windows_keypress("\x00", lambda: "P") == "\x1b[B"


def test_translate_windows_keypress_preserves_non_arrow_sequences():
    assert terminal._translate_windows_keypress("q", lambda: (_ for _ in ()).throw(AssertionError("unexpected read"))) == "q"
    assert terminal._translate_windows_keypress("\xe0", lambda: "S") == "\xe0S"


def test_enable_virtual_terminal_is_noop_outside_windows(monkeypatch):
    monkeypatch.setattr(terminal, "_is_windows", lambda: False)
    monkeypatch.setattr(
        terminal,
        "_enable_windows_virtual_terminal",
        lambda _stream: (_ for _ in ()).throw(AssertionError("Windows console helper should not run")),
    )

    terminal.enable_virtual_terminal()


def test_enable_virtual_terminal_updates_stdout_and_stderr_on_windows(monkeypatch):
    calls = []
    monkeypatch.setattr(terminal, "_is_windows", lambda: True)
    monkeypatch.setattr(terminal, "_enable_windows_virtual_terminal", lambda stream: calls.append(stream))

    terminal.enable_virtual_terminal()

    assert calls == [sys.stdout, sys.stderr]
