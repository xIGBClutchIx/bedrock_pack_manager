"""CLI argument parsing, interactive menus, and startup orchestration."""

import argparse
import sys
from pathlib import Path

from .commands import collect_uninstall_candidates, has_uninstall_queue_entries, run
from .console import AppState, C, TerminalListMenu, app_header, app_header_lines, dim_text, prompt_text, title_text
from .logger import capture_run_logs, log_only
from .nbt import GAMEMODE_VALUES
from .paths import build_paths, ensure_runtime_dirs
from .terminal import enable_virtual_terminal, read_keypress
from .worlds import find_world_by_name, resolve_world_path, select_world

MODE_OPTIONS = [
    ("install", "Install Packs"),
    ("edit", "Edit World"),
    ("uninstall", "Uninstall Packs"),
    ("--doctor", "Audit World"),
    ("--rebuild", "Rebuild World"),
]
EDIT_WORLD_OPTIONS = [
    ("--beta", "Enable Beta APIs"),
    ("--gamemode", "Set Gamemode"),
]
GAMEMODE_OPTIONS = [
    ("survival", "Survival"),
    ("creative", "Creative"),
    ("adventure", "Adventure"),
]
UNINSTALL_MODE_OPTIONS = [
    ("remove", "Remove From World And Delete Unused Files"),
    ("keep-files", "Remove From World JSON Only"),
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
        prog="bedrock_pack_manager.py",
        description=(
            "Install Minecraft Bedrock packs from run/install/, rebuild world pack JSONs, "
            "zip runtime data, uninstall world packs, and edit a selected world's level.dat."
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
        "--zip-name",
        help="Custom zip filename to use with --zip. If provided without --zip, zip mode is implied.",
    )
    parser.add_argument(
        "--beta",
        action="store_true",
        help="Enable Beta APIs in the selected world's level.dat.",
    )
    parser.add_argument(
        "--gamemode",
        choices=sorted(GAMEMODE_VALUES),
        help="Set the selected world's default gamemode in level.dat.",
    )
    parser.add_argument(
        "--doctor",
        action="store_true",
        help="Audit the selected world and installed packs without changing any files.",
    )
    parser.add_argument(
        "--uninstall",
        action="store_true",
        help="Select behavior/resource packs to uninstall from the chosen world.",
    )
    parser.add_argument(
        "--uninstall-keep-files",
        action="store_true",
        help="Remove packs from world JSON only and keep installed pack folders on disk.",
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
            (args.zip or bool(args.zip_name), "--zip"),
            (args.beta, "--beta"),
            (args.doctor, "--doctor"),
            (args.uninstall, "--uninstall"),
            (args.uninstall_keep_files, "--uninstall-keep-files"),
            (bool(args.zip_name), f"--zip-name={args.zip_name}"),
            (bool(args.gamemode), f"--gamemode={args.gamemode}"),
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
    gamemode_source = "arg" if "--gamemode" in argv else "default"
    log_only(f"  gamemode: {args.gamemode or '(none)'} ({gamemode_source})\n")
    log_only(f"  zip: {args.zip} ({_arg_source(argv, '--zip')})\n")
    zip_name_source = "arg" if "--zip-name" in argv else "default"
    log_only(f"  zip_name: {args.zip_name or '(none)'} ({zip_name_source})\n")
    log_only(f"  doctor: {args.doctor} ({_arg_source(argv, '--doctor')})\n")
    log_only(f"  uninstall: {args.uninstall} ({_arg_source(argv, '--uninstall')})\n")
    log_only(f"  uninstall_keep_files: {args.uninstall_keep_files} ({_arg_source(argv, '--uninstall-keep-files')})\n")
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
    """Resolve world selection from explicit args first, then fall back to prompting."""

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


def _edit_world_menu_lines(selected: set[str], cursor: int) -> list[str]:
    selection_label = "World Edits" if not selected else f"World Edits ({len(selected)} change(s))"

    lines = [
        "",
        f"  {title_text(selection_label)}",
        f"  {dim_text('Select one or more world edits, then press Enter to apply them')}",
        "",
    ]
    for index, (flag, label) in enumerate(EDIT_WORLD_OPTIONS):
        is_selected = flag in selected
        mark = f"{C.GREEN}◉{C.RESET}" if is_selected else f"{C.DIM}◌{C.RESET}"
        pointer = f"{C.CYAN}▸{C.RESET}" if index == cursor else " "
        label_text = f"{C.BOLD}{label}{C.RESET}" if index == cursor else label
        lines.append(f"  {pointer} {mark} {label_text}")
    return lines


def _uninstall_menu_lines(candidates: list[dict], selected: set[str], cursor: int) -> list[str]:
    selection_label = "Registered Packs" if not selected else f"Registered Packs ({len(selected)} selected)"

    lines = [
        "",
        f"  {title_text(selection_label)}",
        f"  {dim_text('Select one or more packs to remove from this world')}",
        "",
    ]
    for index, candidate in enumerate(candidates):
        flag = candidate["flag"]
        is_selected = flag in selected
        mark = f"{C.GREEN}◉{C.RESET}" if is_selected else f"{C.DIM}◌{C.RESET}"
        pointer = f"{C.CYAN}▸{C.RESET}" if index == cursor else " "
        label_text = f"{C.BOLD}{candidate['label']}{C.RESET}" if index == cursor else candidate["label"]
        lines.append(f"  {pointer} {mark} {label_text}")
        lines.append(f"    {dim_text(candidate['details'])}")
    return lines


def _uninstall_mode_menu_lines(cursor: int) -> list[str]:
    return _single_select_menu_lines(
        UNINSTALL_MODE_OPTIONS,
        cursor,
        "Uninstall Mode",
        "Choose whether uninstall should also delete pack folders when possible",
    )


def _single_select_menu_lines(options: list[tuple[str, str]], cursor: int, title: str, subtitle: str) -> list[str]:
    lines = [
        "",
        f"  {title_text(title)}",
        f"  {dim_text(subtitle)}",
        "",
    ]
    for index, (_value, label) in enumerate(options):
        pointer = f"{C.CYAN}▸{C.RESET}" if index == cursor else " "
        label_text = f"{C.BOLD}{label}{C.RESET}" if index == cursor else label
        lines.append(f"  {pointer} {label_text}")
    return lines


def _selected_world_lines(selected_world: Path | None, *, leading_blank: bool = True) -> list[str]:
    if selected_world is None:
        return []

    worlds_dir = selected_world.parent
    world_count = 0
    if worlds_dir.exists():
        world_count = sum(1 for directory in worlds_dir.iterdir() if directory.is_dir() and not directory.name.startswith("."))

    lines = [f"  {title_text('Worlds')}"]
    if leading_blank:
        lines.insert(0, "")
    if world_count == 1:
        lines.append(f"  {dim_text('Only one world available')}")
    lines.append(f"  Selected: {C.CYAN}{selected_world.name}{C.RESET}")
    return lines


def prompt_mode(selected_world: Path | None = None) -> str:
    cursor = 0
    static_lines = [
        *app_header_lines(),
        "",
        f"  {title_text('Mode')}",
        f"  {dim_text('↑/↓ move  Enter select  Q quit')}",
    ]
    if selected_world is not None:
        static_lines.extend(
            [
                f"  {dim_text(f'World: {selected_world.name}')}",
                "",
            ]
        )
    menu = TerminalListMenu(
        static_lines,
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


def prompt_edit_world_flags(selected_world: Path | None = None) -> set[str]:
    selected: set[str] = set()
    cursor = 0
    static_lines = [
        *app_header_lines(),
        "",
        f"  {title_text('Edit World')}",
        f"  {dim_text('↑/↓ move  Space toggle  Enter continue  Q quit')}",
    ]
    static_lines.extend(_selected_world_lines(selected_world))
    menu = TerminalListMenu(
        static_lines,
        lambda: _edit_world_menu_lines(selected, cursor),
    )
    menu.render_initial()

    while True:
        key = read_keypress()
        if key in {"\r", "\n"}:
            return selected
        if key in {"q", "Q", "\x03"}:
            raise MenuExit()
        if key == " ":
            selected = _toggle_flag(selected, EDIT_WORLD_OPTIONS[cursor][0])
            menu.redraw()
            continue
        if key == "\x1b[A":
            cursor = _move_cursor(cursor, len(EDIT_WORLD_OPTIONS), "up")
            menu.redraw()
            continue
        if key == "\x1b[B":
            cursor = _move_cursor(cursor, len(EDIT_WORLD_OPTIONS), "down")
            menu.redraw()
            continue


def prompt_gamemode(selected_world: Path | None = None) -> str:
    cursor = 0
    static_lines = [
        *app_header_lines(),
        "",
        f"  {title_text('Set Gamemode')}",
        f"  {dim_text('↑/↓ move  Enter select  Q quit')}",
    ]
    static_lines.extend(_selected_world_lines(selected_world))
    menu = TerminalListMenu(
        static_lines,
        lambda: _single_select_menu_lines(GAMEMODE_OPTIONS, cursor, "Gamemode", "Choose the world's default gamemode"),
    )
    menu.render_initial()

    while True:
        key = read_keypress()
        if key in {"\r", "\n"}:
            return GAMEMODE_OPTIONS[cursor][0]
        if key in {"q", "Q", "\x03"}:
            raise MenuExit()
        if key == "\x1b[A":
            cursor = _move_cursor(cursor, len(GAMEMODE_OPTIONS), "up")
            menu.redraw()
            continue
        if key == "\x1b[B":
            cursor = _move_cursor(cursor, len(GAMEMODE_OPTIONS), "down")
            menu.redraw()
            continue


def prompt_uninstall_mode(selected_world: Path | None = None) -> str:
    cursor = 0
    static_lines = [
        *app_header_lines(),
        "",
        f"  {title_text('Uninstall Mode')}",
        f"  {dim_text('↑/↓ move  Enter select  Q quit')}",
    ]
    static_lines.extend(_selected_world_lines(selected_world))
    menu = TerminalListMenu(
        static_lines,
        lambda: _uninstall_mode_menu_lines(cursor),
    )
    menu.render_initial()

    while True:
        key = read_keypress()
        if key in {"\r", "\n"}:
            return UNINSTALL_MODE_OPTIONS[cursor][0]
        if key in {"q", "Q", "\x03"}:
            raise MenuExit()
        if key == "\x1b[A":
            cursor = _move_cursor(cursor, len(UNINSTALL_MODE_OPTIONS), "up")
            menu.redraw()
            continue
        if key == "\x1b[B":
            cursor = _move_cursor(cursor, len(UNINSTALL_MODE_OPTIONS), "down")
            menu.redraw()
            continue


def _prompt_uninstall_flags_interactive(candidates: list[dict], selected_world: Path | None = None) -> set[str]:
    selected: set[str] = set()
    cursor = 0
    static_lines = [
        *app_header_lines(),
        "",
        f"  {title_text('Uninstall Packs')}",
        f"  {dim_text('↑/↓ move  Space toggle  Enter continue  Q quit')}",
    ]
    static_lines.extend(_selected_world_lines(selected_world))
    menu = TerminalListMenu(
        static_lines,
        lambda: _uninstall_menu_lines(candidates, selected, cursor),
    )
    menu.render_initial()

    while True:
        key = read_keypress()
        if key in {"\r", "\n"}:
            return selected
        if key in {"q", "Q", "\x03"}:
            raise MenuExit()
        if key == " ":
            selected = _toggle_flag(selected, candidates[cursor]["flag"])
            menu.redraw()
            continue
        if key == "\x1b[A":
            cursor = _move_cursor(cursor, len(candidates), "up")
            menu.redraw()
            continue
        if key == "\x1b[B":
            cursor = _move_cursor(cursor, len(candidates), "down")
            menu.redraw()
            continue


def _prompt_uninstall_flags_with_prompt(candidates: list[dict], selected_world: Path | None = None) -> set[str]:
    print(f"\n  {title_text('Uninstall Packs')}\n")
    for line in _selected_world_lines(selected_world):
        print(line)
    for index, candidate in enumerate(candidates, 1):
        print(f"    {C.BOLD}{index}.{C.RESET} {candidate['label']}")
        print(f"       {candidate['details']}")

    print()
    while True:
        raw_choice = input(f"  Select pack numbers to uninstall (comma-separated 1-{len(candidates)}): ").strip()
        if not raw_choice:
            return set()

        try:
            indexes = {int(part.strip()) - 1 for part in raw_choice.split(",")}
        except ValueError:
            print(f"  {C.RED}Enter comma-separated numbers{C.RESET}")
            continue

        if not indexes or any(index < 0 or index >= len(candidates) for index in indexes):
            print(f"  {C.RED}Invalid choice{C.RESET}")
            continue

        return {candidates[index]["flag"] for index in sorted(indexes)}


def prompt_uninstall_flags(candidates: list[dict], selected_world: Path | None = None) -> set[str]:
    if is_interactive_terminal():
        return _prompt_uninstall_flags_interactive(candidates, selected_world)
    return _prompt_uninstall_flags_with_prompt(candidates, selected_world)


def _prompt_text_input_interactive(prompt: str) -> str:
    sys.stdout.write(f"\n{prompt}")
    sys.stdout.flush()
    chars: list[str] = []

    while True:
        key = read_keypress()
        if key in {"\r", "\n"}:
            sys.stdout.write("\n")
            sys.stdout.flush()
            return "".join(chars)
        if key == "\x03":
            sys.stdout.write("\n")
            sys.stdout.flush()
            raise MenuExit()
        if key in {"\x08", "\x7f"}:
            if chars:
                chars.pop()
                sys.stdout.write("\b \b")
                sys.stdout.flush()
            continue
        if len(key) == 1 and key.isprintable():
            chars.append(key)
            sys.stdout.write(key)
            sys.stdout.flush()


def prompt_zip_name(selected_world: Path | None = None) -> str | None:
    if is_interactive_terminal():
        zip_name = _prompt_text_input_interactive(prompt_text("Zip output name (blank to skip): ")).strip()
    else:
        try:
            zip_name = input(f"\n{prompt_text('Zip output name (blank to skip): ')}").strip()
        except KeyboardInterrupt as exc:
            raise MenuExit() from exc
    return zip_name or None


def pause_before_exit() -> None:
    if not is_interactive_terminal():
        return
    try:
        input(prompt_text("Press Enter to exit..."))
    except KeyboardInterrupt:
        return


def main() -> None:
    configure_output()

    argv = sys.argv[1:]
    args = parse_args(argv)
    flags = flags_from_args(args)
    paths = build_paths(get_base_dir())
    # Bootstrap the runtime layout before logging or world selection touches the filesystem.
    ensure_runtime_dirs(paths)
    state = AppState()

    try:
        with capture_run_logs(paths.logs_dir):
            log_launch_context(argv, args)
            interactive_launch = not flags and is_interactive_terminal()
            world_dir = None
            world_selection_source = ""

            if interactive_launch:
                # Interactive startup shows the mode menu first, then resolves the world for that mode.
                mode = prompt_mode()
                world_dir, world_selection_source = resolve_world(args, paths)
                log_only(f"  World source: {world_selection_source}\n")
                log_only(f"  World: {world_dir}\n")
                if mode == "--doctor":
                    flags = {"--doctor"}
                elif mode == "--rebuild":
                    flags = {"--rebuild"}
                elif mode == "uninstall":
                    flags = {"--uninstall"}
                    if prompt_uninstall_mode(world_dir) == "keep-files":
                        flags.add("--uninstall-keep-files")
                elif mode == "edit":
                    flags = prompt_edit_world_flags(world_dir)
                    if not flags:
                        raise ValueError("Select at least one world edit option.")
                    if "--gamemode" in flags:
                        flags.remove("--gamemode")
                        flags.add(f"--gamemode={prompt_gamemode(world_dir)}")
                else:
                    zip_name = prompt_zip_name(world_dir)
                    flags = {"--zip", f"--zip-name={zip_name}"} if zip_name else set()
                log_run_settings(flags, "interactive prompt")
            else:
                app_header()
                log_run_settings(flags, "cli args/defaults")

            needs_world = not flags or flags != {"--zip"}
            if needs_world and world_dir is None:
                world_dir, world_selection_source = resolve_world(args, paths)
                log_only(f"  World source: {world_selection_source}\n")
                log_only(f"  World: {world_dir}\n")
                if "--uninstall" in flags and not any(flag.startswith("--uninstall-pack=") for flag in flags) and not has_uninstall_queue_entries(paths):
                    uninstall_candidates = collect_uninstall_candidates(world_dir, paths)
                    if not uninstall_candidates:
                        raise ValueError("No behavior or resource packs are registered in this world.")
                    flags = set(flags)
                    selected_uninstall_flags = prompt_uninstall_flags(uninstall_candidates, world_dir)
                    if not selected_uninstall_flags:
                        raise ValueError("Select at least one pack to uninstall.")
                    flags.update(selected_uninstall_flags)
            elif world_dir is not None and "--uninstall" in flags and not any(flag.startswith("--uninstall-pack=") for flag in flags) and not has_uninstall_queue_entries(paths):
                uninstall_candidates = collect_uninstall_candidates(world_dir, paths)
                if not uninstall_candidates:
                    raise ValueError("No behavior or resource packs are registered in this world.")
                flags = set(flags)
                selected_uninstall_flags = prompt_uninstall_flags(uninstall_candidates, world_dir)
                if not selected_uninstall_flags:
                    raise ValueError("Select at least one pack to uninstall.")
                flags.update(selected_uninstall_flags)
            run(flags, world_dir, paths, state, duplicate_mode=args.duplicate_mode)
    except ValueError as exc:
        print(f"\n{C.RED}{exc}{C.RESET}")
        pause_before_exit()
        return
    except (KeyboardInterrupt, MenuExit):
        print()
        print(f"{C.YELLOW}Cancelled.{C.RESET}")
        pause_before_exit()
        return

    pause_before_exit()
