import os
import sys
from typing import Callable

_WINDOWS_ESCAPE_MAP = {
    "H": "\x1b[A",
    "P": "\x1b[B",
    "K": "\x1b[D",
    "M": "\x1b[C",
}

_ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004


def _is_windows() -> bool:
    return os.name == "nt"


def _translate_windows_keypress(first: str, read_char: Callable[[], str]) -> str:
    if first not in {"\x00", "\xe0"}:
        return first
    second = read_char()
    return _WINDOWS_ESCAPE_MAP.get(second, first + second)


def _read_windows_keypress() -> str:
    import msvcrt

    first = msvcrt.getwch()
    return _translate_windows_keypress(first, msvcrt.getwch)


def _read_posix_keypress() -> str:
    import termios
    import tty

    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        first = sys.stdin.read(1)
        if first == "\x1b":
            second = sys.stdin.read(1)
            third = sys.stdin.read(1)
            return first + second + third
        return first
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def _enable_windows_virtual_terminal(stream) -> None:
    fileno = getattr(stream, "fileno", None)
    if fileno is None:
        return

    try:
        handle_fd = fileno()
    except (OSError, ValueError):
        return

    try:
        import ctypes
        import msvcrt
    except ImportError:
        return

    handle = msvcrt.get_osfhandle(handle_fd)
    if handle == -1:
        return

    mode = ctypes.c_uint()
    if ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(mode)) == 0:
        return

    updated_mode = mode.value | _ENABLE_VIRTUAL_TERMINAL_PROCESSING
    ctypes.windll.kernel32.SetConsoleMode(handle, updated_mode)


def enable_virtual_terminal() -> None:
    if not _is_windows():
        return
    _enable_windows_virtual_terminal(sys.stdout)
    _enable_windows_virtual_terminal(sys.stderr)


def read_keypress() -> str:
    if _is_windows():
        return _read_windows_keypress()
    return _read_posix_keypress()
