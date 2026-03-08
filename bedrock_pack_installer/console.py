from dataclasses import dataclass, field


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


def subsection(title: str) -> None:
    print(f"\n  {C.BOLD}{title}{C.RESET}")


def print_warnings(warnings: list[str]) -> None:
    if not warnings:
        return

    print(f"\n  {C.YELLOW}{C.BOLD}Warnings ({len(warnings)}){C.RESET}")
    for index, warning_msg in enumerate(warnings, 1):
        print(f"  {C.YELLOW}{index}.{C.RESET} {warning_msg}")
