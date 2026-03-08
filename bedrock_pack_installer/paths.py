from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ProjectPaths:
    base_dir: Path
    run_dir: Path
    logs_dir: Path
    install_dir: Path
    behavior_packs_dir: Path
    resource_packs_dir: Path
    worlds_dir: Path
    installed_dir: Path


def build_paths(base_dir: Path) -> ProjectPaths:
    run_dir = base_dir / "run"
    return ProjectPaths(
        base_dir=base_dir,
        run_dir=run_dir,
        logs_dir=run_dir / "logs",
        install_dir=run_dir / "install",
        behavior_packs_dir=run_dir / "behavior_packs",
        resource_packs_dir=run_dir / "resource_packs",
        worlds_dir=run_dir / "worlds",
        installed_dir=run_dir / "installed",
    )
