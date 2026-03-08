from pathlib import Path

from bedrock_pack_installer.paths import build_paths


def test_build_paths_uses_run_directory():
    base_dir = Path("/tmp/bedrock_pack_installer")

    paths = build_paths(base_dir)

    assert paths.run_dir == base_dir / "run"
    assert paths.logs_dir == base_dir / "run" / "logs"
    assert paths.install_dir == base_dir / "run" / "install"
    assert paths.installed_dir == base_dir / "run" / "installed"
    assert paths.behavior_packs_dir == base_dir / "run" / "behavior_packs"
    assert paths.resource_packs_dir == base_dir / "run" / "resource_packs"
    assert paths.worlds_dir == base_dir / "run" / "worlds"
