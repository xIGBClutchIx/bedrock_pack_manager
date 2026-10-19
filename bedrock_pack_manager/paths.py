"""Project path helpers for the runtime `run/` layout."""

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ProjectPaths:
    """Resolved local filesystem locations used by the app at runtime."""

    base_dir: Path
    run_dir: Path
    logs_dir: Path
    install_dir: Path
    uninstall_dir: Path
    behavior_packs_dir: Path
    resource_packs_dir: Path
    worlds_dir: Path
    installed_dir: Path
    uninstalled_dir: Path
    staging_dir: Path
    backups_dir: Path
    known_hosts_file: Path
    profiles_file: Path


def build_paths(base_dir: Path) -> ProjectPaths:
    run_dir = base_dir / "run"
    return ProjectPaths(
        base_dir=base_dir,
        run_dir=run_dir,
        logs_dir=run_dir / "logs",
        install_dir=run_dir / "install",
        uninstall_dir=run_dir / "uninstall",
        behavior_packs_dir=run_dir / "behavior_packs",
        resource_packs_dir=run_dir / "resource_packs",
        worlds_dir=run_dir / "worlds",
        installed_dir=run_dir / "installed",
        uninstalled_dir=run_dir / "uninstalled",
        staging_dir=run_dir / "staging",
        backups_dir=run_dir / "backups",
        known_hosts_file=run_dir / "known_hosts",
        profiles_file=run_dir / "profiles.json",
    )


def ensure_runtime_dirs(paths: ProjectPaths) -> None:
    """Create the full runtime tree up front so every command can assume it exists."""

    for directory in [
        paths.run_dir,
        paths.logs_dir,
        paths.install_dir,
        paths.uninstall_dir,
        paths.behavior_packs_dir,
        paths.resource_packs_dir,
        paths.worlds_dir,
        paths.installed_dir,
        paths.uninstalled_dir,
        paths.staging_dir,
        paths.backups_dir,
    ]:
        directory.mkdir(parents=True, exist_ok=True)
