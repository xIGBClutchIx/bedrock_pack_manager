import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


class C:
    RED = "\033[91m"
    YELLOW = "\033[93m"
    GREEN = "\033[92m"
    CYAN = "\033[96m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RESET = "\033[0m"


@dataclass
class AppState:
    warnings: list[str] = field(default_factory=list)
    installed_packs: list[dict] = field(default_factory=list)


class TerminalListMenu:
    def __init__(
        self,
        static_lines: list[str],
        dynamic_lines: Callable[[], list[str]],
        *,
        clear_screen: bool = True,
    ) -> None:
        self.static_lines = static_lines
        self.dynamic_lines = dynamic_lines
        self.clear_screen = clear_screen
        self._rendered_dynamic_lines = 0

    def render_initial(self) -> None:
        if self.clear_screen:
            sys.stdout.write("\033[2J\033[H")
        for line in self.static_lines:
            sys.stdout.write(f"{line}\n")
        self._render_dynamic_lines()

    def redraw(self) -> None:
        if self._rendered_dynamic_lines:
            sys.stdout.write(f"\033[{self._rendered_dynamic_lines}F")
        self._render_dynamic_lines()

    def _render_dynamic_lines(self) -> None:
        lines = self.dynamic_lines()
        for line in lines:
            sys.stdout.write(f"\r\033[2K{line}\n")
        sys.stdout.flush()
        self._rendered_dynamic_lines = len(lines)


def warn(state: AppState, msg: str) -> None:
    state.warnings.append(msg)
    print(f"  {C.YELLOW}[WARNING]{C.RESET} {msg}")


def error(msg: str) -> None:
    print(f"  {C.RED}[ERROR]{C.RESET} {msg}")


def ok(msg: str) -> None:
    print(f"  {C.GREEN}[OK]{C.RESET} {msg}")


def info(msg: str) -> None:
    print(f"  {C.CYAN}[INFO]{C.RESET} {msg}")


def section(title: str) -> None:
    print(f"\n{C.BOLD}{title}{C.RESET}")


def app_header_lines() -> list[str]:
    return [
        "",
        f"{C.CYAN}{C.BOLD}Bedrock Pack Installer{C.RESET}",
        f"  {C.DIM}Minecraft world pack setup, repair, zip, and beta tools{C.RESET}",
    ]


def app_header() -> None:
    for line in app_header_lines():
        print(line)


def subsection(title: str) -> None:
    print(f"\n  {C.BOLD}{title}{C.RESET}")


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(Path.cwd()))
    except ValueError:
        return str(path)


def print_warnings(warnings: list[str]) -> None:
    if not warnings:
        return

    print(f"\n  {C.YELLOW}{C.BOLD}Warnings ({len(warnings)}){C.RESET}")
    for index, warning_msg in enumerate(warnings, 1):
        print(f"  {C.YELLOW}{index}.{C.RESET} {warning_msg}")
