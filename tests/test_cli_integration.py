import sys

from bedrock_pack_installer import cli
from bedrock_pack_installer.paths import build_paths


def test_main_writes_log_file_for_cli_run(tmp_path, monkeypatch):
    paths = build_paths(tmp_path)
    monkeypatch.setattr(cli, "build_paths", lambda _base_dir: paths)

    def fail_select_world(_worlds_dir):
        raise AssertionError("select_world should not be called for --zip")

    monkeypatch.setattr(cli, "select_world", fail_select_world)

    def fake_run(_flags, _world_dir, _paths, _state):
        print("CLI run output")

    monkeypatch.setattr(cli, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["bedrock_pack_installer.py", "--zip"])

    cli.main()

    assert (paths.logs_dir / "latest.txt").exists()
    log_text = (paths.logs_dir / "latest.txt").read_text(encoding="utf-8")
    assert "Minecraft Bedrock Pack Installer" in log_text
    assert "CLI run output" in log_text
