import argparse
import sys
from pathlib import Path

from .commands import run
from .console import AppState, C, TerminalListMenu, app_header, app_header_lines, dim_text, prompt_text, title_text
from .logger import capture_run_logs, log_only
from .paths import build_paths
from .terminal import enable_virtual_terminal, read_keypress
from .worlds import find_world_by_name, resolve_world_path, select_world

MODE_OPTIONS = [
    ("install", "Install Packs"),
    ("--doctor", "Audit World And Installed Packs"),
]
INSTALL_OPTIONS = [
    ("--rebuild", "Rebuild World Pack JSONs"),
    ("--beta", "Enable Beta APIs"),
    ("--zip", "Zip Pack Folders"),
]

class MenuExit(Exception):
    pass


def configure_output() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    enable_virtual_terminal()


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
    parser.add_argument(
        "--doctor",
        action="store_true",
        help="Audit the selected world and installed packs without changing any files.",
    )
    parser.add_argument(
        "--duplicate-mode",
        choices=["skip", "replace", "keep-both"],
        default="replace",
        help="How install mode handles incoming packs whose UUID already exists on disk.",
    )
    parser.add_argument(
        "--world-name",
        help="Select a world folder by name from run/worlds.",
    )
    parser.add_argument(
        "--world-path",
        help="Select a world by path. Relative paths are resolved from run/worlds.",
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
            (args.doctor, "--doctor"),
        ]
        if enabled
    }


def _format_arg_list(argv: list[str]) -> str:
    return " ".join(argv) if argv else "(none)"


def _arg_source(argv: list[str], flag: str) -> str:
    return "arg" if flag in argv else "default"


def log_launch_context(argv: list[str], args: argparse.Namespace) -> None:
    log_only("\nLaunch Context\n")
    log_only(f"  Launch args: {_format_arg_list(argv)}\n")
    log_only(f"  rebuild: {args.rebuild} ({_arg_source(argv, '--rebuild')})\n")
    log_only(f"  beta: {args.beta} ({_arg_source(argv, '--beta')})\n")
    log_only(f"  zip: {args.zip} ({_arg_source(argv, '--zip')})\n")
    log_only(f"  doctor: {args.doctor} ({_arg_source(argv, '--doctor')})\n")
    duplicate_mode_source = "arg" if "--duplicate-mode" in argv else "default"
    log_only(f"  duplicate_mode: {args.duplicate_mode} ({duplicate_mode_source})\n")
    world_name_source = "arg" if "--world-name" in argv else "default"
    world_path_source = "arg" if "--world-path" in argv else "default"
    log_only(f"  world_name: {args.world_name or '(none)'} ({world_name_source})\n")
    log_only(f"  world_path: {args.world_path or '(none)'} ({world_path_source})\n")


def log_run_settings(flags: set[str], selection_source: str) -> None:
    log_only("\nRun Settings\n")
    log_only(f"  Selection source: {selection_source}\n")
    log_only(f"  Effective flags: {', '.join(sorted(flags)) if flags else '(install only)'}\n")


def resolve_world(args: argparse.Namespace, paths) -> tuple[Path | None, str]:
    if args.world_name and args.world_path:
        raise ValueError("Use either --world-name or --world-path, not both")

    if args.world_name:
        world_dir = find_world_by_name(paths.worlds_dir, args.world_name)
        if world_dir is None:
            raise ValueError(f"World '{args.world_name}' was not found in {paths.worlds_dir}")
        return world_dir, "--world-name"

    if args.world_path:
        return resolve_world_path(paths.worlds_dir, args.world_path), "--world-path"

    return select_world(paths.worlds_dir), "prompt"


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


def _mode_menu_lines(cursor: int) -> list[str]:
    lines = [
        f"  {dim_text('Choose what to do')}",
        "",
    ]
    for index, (_flag, label) in enumerate(MODE_OPTIONS):
        pointer = f"{C.CYAN}▸{C.RESET}" if index == cursor else " "
        label_text = f"{C.BOLD}{label}{C.RESET}" if index == cursor else label
        lines.append(f"  {pointer} {label_text}")
    return lines


def _install_menu_lines(selected: set[str], cursor: int) -> list[str]:
    selection_label = "Install Packs" if not selected else f"Install Packs ({len(selected)} extra option(s))"

    lines = [
        "",
        f"  {title_text(selection_label)}",
        f"  {dim_text('Select any extra steps before continuing')}",
        "",
    ]
    for index, (flag, label) in enumerate(INSTALL_OPTIONS):
        is_selected = flag in selected
        mark = f"{C.GREEN}◉{C.RESET}" if is_selected else f"{C.DIM}◌{C.RESET}"
        pointer = f"{C.CYAN}▸{C.RESET}" if index == cursor else " "
        label_text = f"{C.BOLD}{label}{C.RESET}" if index == cursor else label
        lines.append(f"  {pointer} {mark} {label_text}")
    return lines


def prompt_mode() -> str:
    cursor = 0
    menu = TerminalListMenu(
        [
            *app_header_lines(),
            "",
            f"  {title_text('Mode')}",
            f"  {dim_text('↑/↓ move  Enter select  Q quit')}",
        ],
        lambda: _mode_menu_lines(cursor),
    )
    menu.render_initial()

    while True:
        key = read_keypress()
        if key in {"\r", "\n"}:
            return MODE_OPTIONS[cursor][0]
        if key in {"q", "Q", "\x03"}:
            raise MenuExit()
        if key == "\x1b[A":
            cursor = _move_cursor(cursor, len(MODE_OPTIONS), "up")
            menu.redraw()
            continue
        if key == "\x1b[B":
            cursor = _move_cursor(cursor, len(MODE_OPTIONS), "down")
            menu.redraw()
            continue


def prompt_install_flags() -> set[str]:
    selected: set[str] = set()
    cursor = 0
    menu = TerminalListMenu(
        [
            *app_header_lines(),
            "",
            f"  {title_text('Install Options')}",
            f"  {dim_text('↑/↓ move  Space toggle  Enter continue  Q quit')}",
        ],
        lambda: _install_menu_lines(selected, cursor),
    )
    menu.render_initial()

    while True:
        key = read_keypress()
        if key in {"\r", "\n"}:
            return selected
        if key in {"q", "Q", "\x03"}:
            raise MenuExit()
        if key == " ":
            selected = _toggle_flag(selected, INSTALL_OPTIONS[cursor][0])
            menu.redraw()
            continue
        if key == "\x1b[A":
            cursor = _move_cursor(cursor, len(INSTALL_OPTIONS), "up")
            menu.redraw()
            continue
        if key == "\x1b[B":
            cursor = _move_cursor(cursor, len(INSTALL_OPTIONS), "down")
            menu.redraw()
            continue


def pause_before_exit() -> None:
    if not is_interactive_terminal():
        return
    input(f"\n{prompt_text('Press Enter to exit...')}")


def main() -> None:
    configure_output()

    argv = sys.argv[1:]
    args = parse_args(argv)
    flags = flags_from_args(args)
    paths = build_paths(get_base_dir())
    state = AppState()

    try:
        with capture_run_logs(paths.logs_dir):
            log_launch_context(argv, args)
            if not flags and is_interactive_terminal():
                mode = prompt_mode()
                flags = {"--doctor"} if mode == "--doctor" else prompt_install_flags()
                log_run_settings(flags, "interactive prompt")
            else:
                app_header()
                log_run_settings(flags, "cli args/defaults")

            needs_world = not flags or flags != {"--zip"}
            world_dir = None
            if needs_world:
                world_dir, world_selection_source = resolve_world(args, paths)
                log_only(f"  World source: {world_selection_source}\n")
                log_only(f"  World: {world_dir}\n")
            run(flags, world_dir, paths, state, duplicate_mode=args.duplicate_mode)
    except ValueError as exc:
        print(f"\n{C.RED}{exc}{C.RESET}")
        return
    except (KeyboardInterrupt, MenuExit):
        print(f"\n{C.YELLOW}Cancelled.{C.RESET}")
        return

    pause_before_exit()
