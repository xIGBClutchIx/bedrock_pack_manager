"""Terminal presentation helpers and run-state tracking."""

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


class C:
    RED = "\033[91m"
    YELLOW = "\033[93m"
    GREEN = "\033[92m"
    CYAN = "\033[96m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RESET = "\033[0m"


def title_text(text: str) -> str:
    return f"{C.CYAN}{C.BOLD}{text}{C.RESET}"


def dim_text(text: str) -> str:
    return f"{C.DIM}{text}{C.RESET}"


def prompt_text(text: str) -> str:
    return f"  {dim_text(text)}"


@dataclass
class ActionRecord:
    """Structured record of a notable action taken during a run."""

    kind: str
    message: str
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class AppState:
    """Mutable run state shared across commands for warnings and action summaries."""

    warnings: list[str] = field(default_factory=list)
    installed_packs: list[dict] = field(default_factory=list)
    actions: list[ActionRecord] = field(default_factory=list)

    def record(self, kind: str, message: str, **details: Any) -> ActionRecord:
        action = ActionRecord(kind=kind, message=message, details=details)
        self.actions.append(action)
        return action


class TerminalListMenu:
    """Small redraw-based menu renderer used by interactive CLI prompts."""

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
        # Rewind over the previously rendered dynamic block and paint the next frame in place.
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
    state.record("warning", msg)
    print(f"  {C.YELLOW}[WARNING]{C.RESET} {msg}")


def error(msg: str, state: AppState | None = None, **details: Any) -> None:
    if state is not None:
        state.record(str(details.pop("action", "error")), msg, **details)
    print(f"  {C.RED}[ERROR]{C.RESET} {msg}")


def ok(msg: str, state: AppState | None = None, **details: Any) -> None:
    if state is not None:
        state.record(str(details.pop("action", "ok")), msg, **details)
    print(f"  {C.GREEN}[OK]{C.RESET} {msg}")


def info(msg: str, state: AppState | None = None, **details: Any) -> None:
    if state is not None:
        state.record(str(details.pop("action", "info")), msg, **details)
    print(f"  {C.CYAN}[INFO]{C.RESET} {msg}")


def section(title: str, state: AppState | None = None, **details: Any) -> None:
    if state is not None:
        state.record(str(details.pop("action", "section")), title, **details)
    print(f"\n  {title_text(title)}")


def app_header_lines() -> list[str]:
    return [
        "",
        title_text("Bedrock Pack Manager"),
        f"  {dim_text('Minecraft world pack setup, uninstall, repair, zip, and level.dat edit tools')}",
    ]


def app_header() -> None:
    for line in app_header_lines():
        print(line)


def subsection(title: str, state: AppState | None = None, **details: Any) -> None:
    if state is not None:
        state.record(str(details.pop("action", "subsection")), title, **details)
    print(f"\n  {title_text(title)}")


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
