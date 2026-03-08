import sys
from pathlib import Path

import bedrock_pack_installer.cli as cli


def test_get_base_dir_uses_project_root_when_not_frozen(monkeypatch):
    monkeypatch.setattr(sys, "frozen", False, raising=False)

    assert cli.get_base_dir() == Path(cli.__file__).resolve().parent.parent


def test_get_base_dir_uses_executable_parent_when_frozen(monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", "/tmp/app/bedrock-pack-installer")

    assert cli.get_base_dir() == Path("/tmp/app")
