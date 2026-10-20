import json
import shutil
import zipfile

from bedrock_pack_manager.paths import build_paths
from bedrock_pack_manager.web import list_worlds, normalize_upload, run_action, uninstall_candidates
from scripts.build_site import PACKAGE_ZIP_NAME, build_site
from tests.conftest import FIXTURES
from tests.helpers import PACK_VERSION, write_manifest, write_world_json


def _copy_fixture_world(tmp_path):
    paths = build_paths(tmp_path)
    shutil.copytree(FIXTURES / "worlds" / "World", paths.worlds_dir / "World")
    return paths


def test_list_worlds_returns_world_folder_names(tmp_path):
    paths = _copy_fixture_world(tmp_path)
    (paths.worlds_dir / "Another").mkdir()
    (paths.worlds_dir / "notes.txt").write_text("not a world", encoding="utf-8")

    assert json.loads(list_worlds(str(tmp_path))) == ["Another", "World"]


def test_uninstall_candidates_returns_serializable_entries(tmp_path):
    paths = build_paths(tmp_path)
    world_dir = paths.worlds_dir / "World"
    write_manifest(paths.behavior_packs_dir / "Behavior Pack-BP", uuid="bp-uuid", version=PACK_VERSION, name="Behavior Pack")
    write_world_json(world_dir / "world_behavior_packs.json", [{"pack_id": "bp-uuid", "version": PACK_VERSION}])
    write_world_json(world_dir / "world_resource_packs.json", [])

    candidates = json.loads(uninstall_candidates(str(tmp_path), "World"))

    assert candidates == [{"flag": "--uninstall-pack=bp:bp-uuid:1.0.0", "label": "[BP] Behavior Pack (v1.0.0)", "details": candidates[0]["details"]}]


def test_run_action_installs_uploaded_pack_and_writes_log(tmp_path):
    paths = _copy_fixture_world(tmp_path)
    paths.install_dir.mkdir(parents=True)
    shutil.copy(FIXTURES / "installed" / "addon.mcaddon", paths.install_dir / "addon.mcaddon")

    result = json.loads(run_action(str(tmp_path), "World", "[]", "replace"))

    assert result["ok"] is True
    assert result["zip_path"] is None
    assert any(paths.behavior_packs_dir.iterdir())
    assert any(paths.resource_packs_dir.iterdir())
    assert (paths.installed_dir / "addon.mcaddon").exists()
    assert (paths.logs_dir / "latest.txt").exists()


def test_run_action_reports_created_zip_without_world(tmp_path):
    _copy_fixture_world(tmp_path)

    result = json.loads(run_action(str(tmp_path), "", json.dumps(["--zip", "--zip-name=out.zip"])))

    assert result["ok"] is True
    assert result["zip_path"] == str(tmp_path / "out.zip")


def test_run_action_reports_failure_for_unknown_world(tmp_path, capsys):
    _copy_fixture_world(tmp_path)

    result = json.loads(run_action(str(tmp_path), "Missing", json.dumps(["--doctor"])))

    assert result["ok"] is False
    assert "Missing" in capsys.readouterr().out


def test_normalize_upload_accepts_run_layout(tmp_path):
    (tmp_path / "worlds").mkdir()

    assert json.loads(normalize_upload(str(tmp_path))) == {"ok": True}


def test_normalize_upload_flattens_single_wrapper_folder(tmp_path):
    (tmp_path / "server" / "worlds" / "World").mkdir(parents=True)
    (tmp_path / "server" / "behavior_packs").mkdir()
    (tmp_path / "__MACOSX").mkdir()

    assert json.loads(normalize_upload(str(tmp_path))) == {"ok": True}
    assert (tmp_path / "worlds" / "World").is_dir()
    assert (tmp_path / "behavior_packs").is_dir()
    assert not (tmp_path / "server").exists()


def test_normalize_upload_rejects_zip_without_worlds(tmp_path):
    (tmp_path / "random").mkdir()

    result = json.loads(normalize_upload(str(tmp_path)))

    assert result["ok"] is False
    assert "worlds/" in result["error"]


def test_build_site_copies_web_files_and_packages_python(tmp_path):
    out_dir = build_site(tmp_path / "site")

    assert (out_dir / "index.html").exists()
    assert (out_dir / "app.js").exists()
    assert (out_dir / ".nojekyll").exists()
    with zipfile.ZipFile(out_dir / PACKAGE_ZIP_NAME) as zf:
        names = set(zf.namelist())
    assert "bedrock_pack_manager/web.py" in names
    assert "bedrock_pack_manager/commands.py" in names
