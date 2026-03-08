import argparse
import sys
import termios
import tty
from pathlib import Path

from .commands import run
from .console import AppState, C, app_header
from .logger import capture_run_logs
from .paths import build_paths
from .worlds import select_world

MENU_OPTIONS = [
    ("--rebuild", "Rebuild World Pack JSONs"),
    ("--beta", "Enable Beta APIs"),
    ("--zip", "Zip Pack Folders"),
]

CLEAR_SCREEN = "\033[2J\033[H"


class MenuExit(Exception):
    pass


def configure_output() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="bedrock_pack_installer.py",
        description=(
            "Install Minecraft Bedrock packs from run/install/, rebuild world pack JSONs, "
            "zip runtime data, and enable Beta APIs in a selected world."
        ),
    )
    parser.add_argument(
        "--rebuild",
        action="store_true",
        help="Rebuild world_behavior_packs.json and world_resource_packs.json from installed pack folders.",
    )
    parser.add_argument(
        "--zip",
        action="store_true",
        help="Create a zip archive containing run/worlds, run/behavior_packs, and run/resource_packs.",
    )
    parser.add_argument(
        "--beta",
        action="store_true",
        help="Enable Beta APIs in the selected world's level.dat.",
    )
    return parser.parse_args(argv)


def get_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def is_interactive_terminal() -> bool:
    return bool(getattr(sys.stdin, "isatty", lambda: False)()) and bool(
        getattr(sys.stdout, "isatty", lambda: False)()
    )


def flags_from_args(args: argparse.Namespace) -> set[str]:
    return {
        flag
        for enabled, flag in [
            (args.rebuild, "--rebuild"),
            (args.zip, "--zip"),
            (args.beta, "--beta"),
        ]
        if enabled
    }


def _move_cursor(delta: int, size: int, direction: str) -> int:
    if direction == "up":
        return (delta - 1) % size
    if direction == "down":
        return (delta + 1) % size
    return delta


def _toggle_flag(selected: set[str], flag: str) -> set[str]:
    updated = set(selected)
    if flag in updated:
        updated.remove(flag)
    else:
        updated.add(flag)
    return updated


def _read_key() -> str:
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


def _render_menu(selected: set[str], cursor: int) -> None:
    selected_count = len(selected)
    selection_label = "Install Packs" if selected_count == 0 else f"{selected_count} option(s) selected"

    app_header()
    print(f"\n  {C.CYAN}{C.BOLD}Launch Options{C.RESET}")
    print(f"  {C.DIM}↑/↓ move  Space toggle  Enter continue  Q quit{C.RESET}")
    print(f"  {C.DIM}{selection_label}{C.RESET}\n")
    for index, (flag, label) in enumerate(MENU_OPTIONS):
        is_selected = flag in selected
        mark = f"{C.GREEN}◉{C.RESET}" if is_selected else f"{C.DIM}◌{C.RESET}"
        pointer = f"{C.CYAN}▸{C.RESET}" if index == cursor else " "
        label_text = f"{C.BOLD}{label}{C.RESET}" if index == cursor else label
        print(f"  {pointer} {mark} {label_text}")


def prompt_flags() -> set[str]:
    selected: set[str] = set()
    cursor = 0

    while True:
        print(CLEAR_SCREEN, end="")
        _render_menu(selected, cursor)

        key = _read_key()
        if key in {"\r", "\n"}:
            return selected
        if key in {"q", "Q", "\x03"}:
            raise MenuExit()
        if key == " ":
            selected = _toggle_flag(selected, MENU_OPTIONS[cursor][0])
            continue
        if key == "\x1b[A":
            cursor = _move_cursor(cursor, len(MENU_OPTIONS), "up")
            continue
        if key == "\x1b[B":
            cursor = _move_cursor(cursor, len(MENU_OPTIONS), "down")
            continue


def pause_before_exit() -> None:
    if not is_interactive_terminal():
        return
    input("\nPress Enter to exit...")


def main() -> None:
    configure_output()

    args = parse_args(sys.argv[1:])
    flags = flags_from_args(args)
    paths = build_paths(get_base_dir())
    state = AppState()

    try:
        with capture_run_logs(paths.logs_dir):
            if not flags and is_interactive_terminal():
                flags = prompt_flags()
            else:
                app_header()

            needs_world = not flags or flags != {"--zip"}
            world_dir = select_world(paths.worlds_dir) if needs_world else None
            run(flags, world_dir, paths, state)
    except (KeyboardInterrupt, MenuExit):
        print(f"\n{C.YELLOW}Cancelled.{C.RESET}")
        return

    pause_before_exit()
