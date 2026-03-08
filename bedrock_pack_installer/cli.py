import argparse
import sys
from pathlib import Path

from .commands import run
from .console import AppState, C, section
from .logger import capture_run_logs
from .paths import build_paths
from .worlds import select_world


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


def main() -> None:
    configure_output()

    args = parse_args(sys.argv[1:])
    flags = {
        flag
        for enabled, flag in [
            (args.rebuild, "--rebuild"),
            (args.zip, "--zip"),
            (args.beta, "--beta"),
        ]
        if enabled
    }
    paths = build_paths(Path(__file__).resolve().parent.parent)
    state = AppState()

    with capture_run_logs(paths.logs_dir):
        section("Minecraft Bedrock Pack Installer")

        needs_world = not flags or flags != {"--zip"}
        world_dir = select_world(paths.worlds_dir) if needs_world else None
        run(flags, world_dir, paths, state)
