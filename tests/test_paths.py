from pathlib import Path

from bedrock_pack_manager.paths import build_paths, ensure_runtime_dirs


def test_build_paths_uses_run_directory():
    base_dir = Path("/tmp/bedrock_pack_manager")

    paths = build_paths(base_dir)

    assert paths.run_dir == base_dir / "run"
    assert paths.logs_dir == base_dir / "run" / "logs"
    assert paths.install_dir == base_dir / "run" / "install"
    assert paths.uninstall_dir == base_dir / "run" / "uninstall"
    assert paths.installed_dir == base_dir / "run" / "installed"
    assert paths.uninstalled_dir == base_dir / "run" / "uninstalled"
    assert paths.behavior_packs_dir == base_dir / "run" / "behavior_packs"
    assert paths.resource_packs_dir == base_dir / "run" / "resource_packs"
    assert paths.worlds_dir == base_dir / "run" / "worlds"
    assert paths.staging_dir == base_dir / "run" / "staging"
    assert paths.backups_dir == base_dir / "run" / "backups"
    assert paths.known_hosts_file == base_dir / "run" / "known_hosts"
    assert paths.profiles_file == base_dir / "run" / "profiles.json"


def test_ensure_runtime_dirs_creates_full_run_tree(tmp_path):
    paths = build_paths(tmp_path)

    ensure_runtime_dirs(paths)

    assert paths.run_dir.is_dir()
    assert paths.logs_dir.is_dir()
    assert paths.install_dir.is_dir()
    assert paths.uninstall_dir.is_dir()
    assert paths.installed_dir.is_dir()
    assert paths.uninstalled_dir.is_dir()
    assert paths.behavior_packs_dir.is_dir()
    assert paths.resource_packs_dir.is_dir()
    assert paths.worlds_dir.is_dir()
