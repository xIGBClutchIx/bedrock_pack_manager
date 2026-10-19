"""CLI argument parsing, interactive menus, and startup orchestration."""

import argparse
import getpass
import os
import sys
from pathlib import Path

from .commands import collect_uninstall_candidates, has_uninstall_queue_entries, run
from .console import AppState, C, TerminalListMenu, app_header, app_header_lines, dim_text, prompt_text, title_text
from .layout import LayoutOverrides, Target, connect_target
from .logger import capture_run_logs, log_only
from .nbt import GAMEMODE_VALUES
from .paths import ProjectPaths, build_paths, ensure_runtime_dirs
from .storage import ConnectionSettings, LocalStorage, StorageError, basename, open_storage, parse_remote_url, redact_url
from .terminal import enable_virtual_terminal, read_keypress
from .worlds import resolve_world_path, select_world

MODE_OPTIONS = [
    ("install", "Install Packs"),
    ("edit", "Edit World"),
    ("uninstall", "Uninstall Packs"),
    ("--doctor", "Audit World"),
    ("--rebuild", "Rebuild JSONs (overwrites world pack JSONs)"),
    ("--cleanup-pack-folders", "Cleanup Pack Folders (deletes unregistered pack folders)"),
    ("remote", "Connect To Remote Server (FTP/FTPS/SFTP)"),
    ("serve", "Open Web UI"),
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
            "Install Minecraft Bedrock packs into a world on this computer or on a server over FTP, FTPS, or SFTP. "
            "Also rebuilds world pack JSONs, cleans up unregistered pack folders, backs up to a zip, uninstalls "
            "world packs, edits level.dat, and serves a local web UI."
        ),
    )
    actions = parser.add_argument_group("actions")
    actions.add_argument("--rebuild", action="store_true", help="Rebuild world_behavior_packs.json and world_resource_packs.json from installed pack folders.")
    actions.add_argument(
        "--cleanup-pack-folders",
        action="store_true",
        help="Delete installed pack folders whose manifest UUID/version is not registered in the selected world's JSON files.",
    )
    actions.add_argument("--zip", action="store_true", help="Create a local zip of the worlds and pack folders (a backup when using --remote).")
    actions.add_argument("--zip-name", help="Custom zip filename to use with --zip. If provided without --zip, zip mode is implied.")
    actions.add_argument("--beta", action="store_true", help="Enable Beta APIs in the selected world's level.dat.")
    actions.add_argument("--gamemode", choices=sorted(GAMEMODE_VALUES), help="Set the selected world's default gamemode in level.dat.")
    actions.add_argument("--doctor", action="store_true", help="Audit the selected world and installed packs without changing any files.")
    actions.add_argument("--uninstall", action="store_true", help="Select behavior/resource packs to uninstall from the chosen world.")
    actions.add_argument("--uninstall-keep-files", action="store_true", help="Remove packs from world JSON only and keep installed pack folders.")
    actions.add_argument("--serve", action="store_true", help="Start the local web UI and open it in a browser.")

    install = parser.add_argument_group("install options")
    install.add_argument(
        "--duplicate-mode",
        choices=["skip", "replace", "keep-both"],
        default="replace",
        help="How install mode handles incoming packs whose UUID already exists on the server.",
    )
    install.add_argument("--reupload", action="store_true", help="Upload packs again even when the same version is already on the server.")
    install.add_argument("--dry-run", action="store_true", help="Show what install or cleanup would change without changing anything.")

    selection = parser.add_argument_group("world selection")
    selection.add_argument("--world-name", help="Select a world folder by name.")
    selection.add_argument("--world-path", help="Select a world by path. Relative paths are resolved from the worlds folder, then the server root.")

    remote = parser.add_argument_group("server connection")
    remote.add_argument(
        "--remote",
        metavar="URL",
        help="Server to work on, e.g. sftp://user@host:22/srv/bedrock, ftp://user@host/, ftps://user@host:21/minecraft, or a local folder path. Defaults to run/.",
    )
    remote.add_argument("--password-env", metavar="VAR", help="Read the FTP/SFTP password from this environment variable instead of prompting.")
    remote.add_argument("--key-file", metavar="PATH", help="SSH private key for SFTP.")
    remote.add_argument("--trust-host-key", metavar="FINGERPRINT", help="Trust this SFTP host key fingerprint (SHA256:...) on first connect.")
    remote.add_argument("--allow-self-signed", action="store_true", help="FTPS: accept certificates that cannot be verified.")
    remote.add_argument("--active-mode", action="store_true", help="FTP: use active mode instead of passive mode.")

    layout = parser.add_argument_group("server layout overrides (auto-detected by default)")
    layout.add_argument("--server-root", help="Folder of the Bedrock server, relative to the connection root.")
    layout.add_argument("--worlds-dir", help="Worlds folder, relative to the connection root.")
    layout.add_argument("--bp-dir", help="Shared behavior_packs folder, relative to the connection root.")
    layout.add_argument("--rp-dir", help="Shared resource_packs folder, relative to the connection root.")
    layout.add_argument(
        "--pack-scope",
        choices=["shared", "world"],
        default="shared",
        help="Install packs into the server's shared pack folders (default) or into the world's own behavior_packs/resource_packs.",
    )

    web = parser.add_argument_group("web UI")
    web.add_argument("--port", type=int, default=0, help="Port for --serve (default: a free port).")
    web.add_argument("--no-browser", action="store_true", help="With --serve, do not open a browser automatically.")
    return parser.parse_args(argv)


def get_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def is_interactive_terminal() -> bool:
    return bool(getattr(sys.stdin, "isatty", lambda: False)()) and bool(getattr(sys.stdout, "isatty", lambda: False)())


def flags_from_args(args: argparse.Namespace) -> set[str]:
    return {
        flag
        for enabled, flag in [
            (args.rebuild, "--rebuild"),
            (args.cleanup_pack_folders, "--cleanup-pack-folders"),
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
    redacted = [redact_url(arg) for arg in argv]
    return " ".join(redacted) if redacted else "(none)"


def _arg_source(argv: list[str], flag: str) -> str:
    return "arg" if any(arg == flag or arg.startswith(f"{flag}=") for arg in argv) else "default"


def log_launch_context(argv: list[str], args: argparse.Namespace) -> None:
    log_only("\nLaunch Context\n")
    log_only(f"  Launch args: {_format_arg_list(argv)}\n")
    log_only(f"  rebuild: {args.rebuild} ({_arg_source(argv, '--rebuild')})\n")
    log_only(f"  cleanup_pack_folders: {args.cleanup_pack_folders} ({_arg_source(argv, '--cleanup-pack-folders')})\n")
    log_only(f"  beta: {args.beta} ({_arg_source(argv, '--beta')})\n")
    log_only(f"  gamemode: {args.gamemode or '(none)'} ({_arg_source(argv, '--gamemode')})\n")
    log_only(f"  zip: {args.zip} ({_arg_source(argv, '--zip')})\n")
    log_only(f"  zip_name: {args.zip_name or '(none)'} ({_arg_source(argv, '--zip-name')})\n")
    log_only(f"  doctor: {args.doctor} ({_arg_source(argv, '--doctor')})\n")
    log_only(f"  uninstall: {args.uninstall} ({_arg_source(argv, '--uninstall')})\n")
    log_only(f"  uninstall_keep_files: {args.uninstall_keep_files} ({_arg_source(argv, '--uninstall-keep-files')})\n")
    log_only(f"  duplicate_mode: {args.duplicate_mode} ({_arg_source(argv, '--duplicate-mode')})\n")
    log_only(f"  dry_run: {args.dry_run} ({_arg_source(argv, '--dry-run')})\n")
    log_only(f"  reupload: {args.reupload} ({_arg_source(argv, '--reupload')})\n")
    log_only(f"  remote: {redact_url(args.remote) if args.remote else '(local run/)'} ({_arg_source(argv, '--remote')})\n")
    log_only(f"  pack_scope: {args.pack_scope} ({_arg_source(argv, '--pack-scope')})\n")
    log_only(f"  world_name: {args.world_name or '(none)'} ({_arg_source(argv, '--world-name')})\n")
    log_only(f"  world_path: {args.world_path or '(none)'} ({_arg_source(argv, '--world-path')})\n")


def log_run_settings(flags: set[str], selection_source: str) -> None:
    log_only("\nRun Settings\n")
    log_only(f"  Selection source: {selection_source}\n")
    log_only(f"  Effective flags: {', '.join(sorted(flags)) if flags else '(install only)'}\n")


# ---- connecting -------------------------------------------------------------------------------------


def layout_overrides(args: argparse.Namespace) -> LayoutOverrides:
    return LayoutOverrides(
        server_root=args.server_root,
        worlds_dir=args.worlds_dir,
        bp_dir=args.bp_dir,
        rp_dir=args.rp_dir,
        pack_scope=args.pack_scope,
    )


def settings_from_args(args: argparse.Namespace, url: str | None = None) -> ConnectionSettings:
    url = url if url is not None else args.remote
    settings = parse_remote_url(url) if url else ConnectionSettings(protocol="local")
    if args.password_env:
        settings.password = os.environ.get(args.password_env, "")
        if not settings.password:
            raise ValueError(f"Environment variable {args.password_env} is empty or not set")
    if args.key_file:
        settings.key_file = str(Path(args.key_file).expanduser())
    if args.trust_host_key:
        settings.trusted_fingerprint = args.trust_host_key
    settings.tls_verify = not args.allow_self_signed
    settings.passive = not args.active_mode
    return settings


def _prompt_yes_no(question: str) -> bool:
    try:
        answer = input(prompt_text(f"{question} [y/N]: ")).strip().lower()
    except EOFError:
        return False
    return answer in {"y", "yes"}


def open_cli_target(settings: ConnectionSettings, paths: ProjectPaths, overrides: LayoutOverrides) -> Target:
    """Open the storage for the CLI, prompting for passwords and host-key trust when interactive."""

    from .storage.sftp import UnknownHostKeyError

    if settings.protocol == "local" and not settings.root:
        return connect_target(LocalStorage(paths.run_dir), overrides)

    interactive = is_interactive_terminal()
    needs_password = settings.protocol in ("ftp", "ftps") and not settings.password and settings.username not in ("", "anonymous")
    if needs_password and interactive:
        settings.password = getpass.getpass(prompt_text(f"Password for {settings.display()}: "))

    print(f"  Connecting to {C.CYAN}{settings.display()}{C.RESET} ...")
    for _attempt in range(3):
        try:
            storage = open_storage(settings, base_dir=paths.base_dir, known_hosts_file=paths.known_hosts_file)
            break
        except UnknownHostKeyError as exc:
            if not interactive:
                raise ValueError(f"{exc}\nRe-run with --trust-host-key {exc.fingerprint} if this is your server.") from exc
            print(f"\n  {C.YELLOW}First connection to {exc.host}:{exc.port}.{C.RESET}")
            print(f"  Host key: {exc.key_type} {C.BOLD}{exc.fingerprint}{C.RESET}")
            if not _prompt_yes_no("Trust this server and remember it?"):
                raise ValueError("Host key not trusted - connection cancelled.") from exc
            settings.trusted_fingerprint = exc.fingerprint
        except StorageError as exc:
            if settings.protocol == "sftp" and "login failed" in str(exc) and not settings.password and interactive:
                settings.password = getpass.getpass(prompt_text(f"Password for {settings.display()}: "))
                continue
            raise ValueError(str(exc)) from exc
    else:
        raise ValueError(f"Could not connect to {settings.display()}")

    target = connect_target(storage, overrides)
    print(f"  Connected. Server folder: {C.CYAN}{target.describe(target.layout.server_root)}{C.RESET}")
    for note in target.layout.notes:
        print(f"  {dim_text(note)}")
    return target


def resolve_world(args: argparse.Namespace, target: Target) -> tuple[str, str]:
    """Resolve world selection from explicit args first, then fall back to prompting."""

    if args.world_name and args.world_path:
        raise ValueError("Use either --world-name or --world-path, not both")

    if args.world_name:
        world = target.find_world(args.world_name)
        if world is None:
            where = target.describe(target.layout.worlds_dir) if target.layout.worlds_dir is not None else target.label
            raise ValueError(f"World '{args.world_name}' was not found in {where}")
        return world, "--world-name"

    if args.world_path:
        return resolve_world_path(target, args.world_path), "--world-path"

    return select_world(target), "prompt"


# ---- interactive menus ----------------------------------------------------------------------------


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
        f"  {dim_text('Select one or more world edits, then press Enter to write them to level.dat')}",
        "",
    ]
    for index, (flag, label) in enumerate(EDIT_WORLD_OPTIONS):
        mark = f"{C.GREEN}◉{C.RESET}" if flag in selected else f"{C.DIM}◌{C.RESET}"
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
        mark = f"{C.GREEN}◉{C.RESET}" if candidate["flag"] in selected else f"{C.DIM}◌{C.RESET}"
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
        "Delete mode removes now-unused pack folders; JSON-only keeps files",
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


def _selected_world_lines(selected_world: str | None, world_count: int = 0, *, leading_blank: bool = True) -> list[str]:
    if selected_world is None:
        return []
    lines = [f"  {title_text('Worlds')}"]
    if leading_blank:
        lines.insert(0, "")
    if world_count == 1:
        lines.append(f"  {dim_text('Only one world available')}")
    lines.append(f"  Selected: {C.CYAN}{basename(selected_world)}{C.RESET}")
    return lines


def _run_single_select(static_lines: list[str], options: list[tuple[str, str]], lines_for_cursor) -> str:
    cursor = 0
    menu = TerminalListMenu(static_lines, lambda: lines_for_cursor(cursor))
    menu.render_initial()
    while True:
        key = read_keypress()
        if key in {"\r", "\n"}:
            return options[cursor][0]
        if key in {"q", "Q", "\x03"}:
            raise MenuExit()
        if key == "\x1b[A":
            cursor = _move_cursor(cursor, len(options), "up")
            menu.redraw()
        elif key == "\x1b[B":
            cursor = _move_cursor(cursor, len(options), "down")
            menu.redraw()


def _run_multi_select(static_lines: list[str], values: list[str], lines_for_state) -> set[str]:
    selected: set[str] = set()
    cursor = 0
    menu = TerminalListMenu(static_lines, lambda: lines_for_state(selected, cursor))
    menu.render_initial()
    while True:
        key = read_keypress()
        if key in {"\r", "\n"}:
            return selected
        if key in {"q", "Q", "\x03"}:
            raise MenuExit()
        if key == " ":
            selected = _toggle_flag(selected, values[cursor])
            menu.redraw()
        elif key == "\x1b[A":
            cursor = _move_cursor(cursor, len(values), "up")
            menu.redraw()
        elif key == "\x1b[B":
            cursor = _move_cursor(cursor, len(values), "down")
            menu.redraw()


def prompt_mode(target_label: str | None = None) -> str:
    static_lines = [
        *app_header_lines(),
        "",
        f"  {title_text('Mode')}",
        f"  {dim_text('↑/↓ move  Enter select  Q quit')}",
    ]
    if target_label:
        static_lines.extend([f"  {dim_text(f'Server: {target_label}')}", ""])
    return _run_single_select(static_lines, MODE_OPTIONS, _mode_menu_lines)


def _menu_header(title: str, hint: str, selected_world: str | None, world_count: int) -> list[str]:
    return [*app_header_lines(), "", f"  {title_text(title)}", f"  {dim_text(hint)}", *_selected_world_lines(selected_world, world_count)]


def prompt_edit_world_flags(selected_world: str | None = None, world_count: int = 0) -> set[str]:
    return _run_multi_select(
        _menu_header("Edit World", "↑/↓ move  Space toggle  Enter continue  Q quit", selected_world, world_count),
        [flag for flag, _label in EDIT_WORLD_OPTIONS],
        _edit_world_menu_lines,
    )


def prompt_gamemode(selected_world: str | None = None, world_count: int = 0) -> str:
    return _run_single_select(
        _menu_header("Set Gamemode", "↑/↓ move  Enter select  Q quit", selected_world, world_count),
        GAMEMODE_OPTIONS,
        lambda cursor: _single_select_menu_lines(GAMEMODE_OPTIONS, cursor, "Gamemode", "Choose the world's default gamemode to write to level.dat"),
    )


def prompt_uninstall_mode(selected_world: str | None = None, world_count: int = 0) -> str:
    return _run_single_select(
        _menu_header("Uninstall Mode", "↑/↓ move  Enter select  Q quit", selected_world, world_count),
        UNINSTALL_MODE_OPTIONS,
        _uninstall_mode_menu_lines,
    )


def _prompt_uninstall_flags_with_prompt(candidates: list[dict], selected_world: str | None = None, world_count: int = 0) -> set[str]:
    print(f"\n  {title_text('Uninstall Packs')}\n")
    for line in _selected_world_lines(selected_world, world_count):
        print(line)
    for index, candidate in enumerate(candidates, 1):
        print(f"    {C.BOLD}{index}.{C.RESET} {candidate['label']}")
        print(f"       {candidate['details']}")

    print()
    while True:
        try:
            raw_choice = input(f"  Select pack numbers to uninstall (comma-separated 1-{len(candidates)}): ").strip()
        except EOFError:
            return set()
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


def prompt_uninstall_flags(candidates: list[dict], selected_world: str | None = None, world_count: int = 0) -> set[str]:
    if is_interactive_terminal():
        return _run_multi_select(
            _menu_header("Uninstall Packs", "↑/↓ move  Space toggle  Enter continue  Q quit", selected_world, world_count),
            [candidate["flag"] for candidate in candidates],
            lambda selected, cursor: _uninstall_menu_lines(candidates, selected, cursor),
        )
    return _prompt_uninstall_flags_with_prompt(candidates, selected_world, world_count)


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


def prompt_text_value(label: str) -> str:
    if is_interactive_terminal():
        return _prompt_text_input_interactive(prompt_text(label)).strip()
    try:
        return input(f"\n{prompt_text(label)}").strip()
    except (KeyboardInterrupt, EOFError) as exc:
        raise MenuExit() from exc


def prompt_zip_name(selected_world: str | None = None) -> str | None:
    return prompt_text_value("Zip output name (blank to skip): ") or None


def pause_before_exit() -> None:
    if not is_interactive_terminal():
        return
    try:
        input(prompt_text("Press Enter to exit..."))
    except (KeyboardInterrupt, EOFError):
        return


def serve(args: argparse.Namespace, paths: ProjectPaths, settings: ConnectionSettings | None = None) -> None:
    from .web.server import run_server

    run_server(paths, port=args.port, open_browser=not args.no_browser, initial_settings=settings, overrides=layout_overrides(args))


def _choose_uninstall_flags(flags: set[str], target: Target, world: str, paths: ProjectPaths, world_count: int) -> set[str]:
    if "--uninstall" not in flags or any(flag.startswith("--uninstall-pack=") for flag in flags) or has_uninstall_queue_entries(paths):
        return flags
    candidates = collect_uninstall_candidates(target, world)
    if not candidates:
        raise ValueError("No behavior or resource packs are registered in this world.")
    selected = prompt_uninstall_flags(candidates, world, world_count)
    if not selected:
        raise ValueError("Select at least one pack to uninstall.")
    return set(flags) | selected


def main() -> None:
    configure_output()

    argv = sys.argv[1:]
    args = parse_args(argv)
    flags = flags_from_args(args)
    paths = build_paths(get_base_dir())
    # Bootstrap the runtime layout before logging or world selection touches the filesystem.
    ensure_runtime_dirs(paths)
    state = AppState()
    target: Target | None = None

    try:
        with capture_run_logs(paths.logs_dir):
            log_launch_context(argv, args)

            if args.serve:
                app_header()
                serve(args, paths, settings_from_args(args) if args.remote else None)
                return

            interactive_launch = not flags and is_interactive_terminal()
            world = None
            world_count = 0
            settings = settings_from_args(args)

            if interactive_launch:
                target_label = settings.display() if args.remote else None
                mode = prompt_mode(target_label)
                while mode == "remote":
                    url = prompt_text_value("Server URL (e.g. sftp://user@host:22/path or ftp://user@host): ")
                    if not url:
                        raise ValueError("No server URL entered.")
                    settings = settings_from_args(args, url)
                    target_label = settings.display()
                    mode = prompt_mode(target_label)
                if mode == "serve":
                    serve(args, paths, settings if settings.protocol != "local" else None)
                    return

                target = open_cli_target(settings, paths, layout_overrides(args))
                world, source = resolve_world(args, target)
                world_count = len(target.list_worlds())
                log_only(f"  World source: {source}\n")
                log_only(f"  World: {world}\n")
                if mode in {"--doctor", "--rebuild", "--cleanup-pack-folders"}:
                    flags = {mode}
                elif mode == "uninstall":
                    flags = {"--uninstall"}
                    if prompt_uninstall_mode(world, world_count) == "keep-files":
                        flags.add("--uninstall-keep-files")
                elif mode == "edit":
                    flags = prompt_edit_world_flags(world, world_count)
                    if not flags:
                        raise ValueError("Select at least one world edit option.")
                    if "--gamemode" in flags:
                        flags.remove("--gamemode")
                        flags.add(f"--gamemode={prompt_gamemode(world, world_count)}")
                else:
                    zip_name = prompt_zip_name(world)
                    flags = {"--zip", f"--zip-name={zip_name}"} if zip_name else set()
                log_run_settings(flags, "interactive prompt")
            else:
                app_header()
                log_run_settings(flags, "cli args/defaults")
                target = open_cli_target(settings, paths, layout_overrides(args))

            needs_world = not flags or not flags <= {"--zip"} | {flag for flag in flags if flag.startswith("--zip-name=")}
            if needs_world and world is None:
                world, source = resolve_world(args, target)
                world_count = len(target.list_worlds())
                log_only(f"  World source: {source}\n")
                log_only(f"  World: {world}\n")
            if world is not None:
                flags = _choose_uninstall_flags(flags, target, world, paths, world_count)
            run(flags, target, world, paths, state, duplicate_mode=args.duplicate_mode, reupload=args.reupload, dry_run=args.dry_run)
    except ValueError as exc:
        print(f"\n{C.RED}{exc}{C.RESET}")
        pause_before_exit()
        return
    except StorageError as exc:
        print(f"\n{C.RED}Server error: {exc}{C.RESET}")
        pause_before_exit()
        return
    except (KeyboardInterrupt, MenuExit):
        print()
        print(f"{C.YELLOW}Cancelled.{C.RESET}")
        pause_before_exit()
        return
    finally:
        if target is not None:
            target.storage.close()

    pause_before_exit()
