import json
import zipfile

from tests.conftest import FIXTURES


def test_pack_mcpack_fixture_contains_expected_files_and_manifest():
    archive_path = FIXTURES / "installed" / "pack.mcpack"

    assert archive_path.exists()

    with zipfile.ZipFile(archive_path) as zf:
        names = set(zf.namelist())
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))

    assert names == {
        "manifest.json",
        "pack.txt",
        "textures/ui/.keep",
    }
    assert manifest["header"]["name"] == "Pack"
    assert manifest["header"]["version"] == [1, 0, 0]
    assert manifest["modules"][0]["type"] == "resources"


def test_addon_mcaddon_fixture_contains_expected_files_and_manifests():
    archive_path = FIXTURES / "installed" / "addon.mcaddon"

    assert archive_path.exists()

    with zipfile.ZipFile(archive_path) as zf:
        names = set(zf.namelist())
        bp_manifest = json.loads(zf.read("bp/manifest.json").decode("utf-8"))
        rp_manifest = json.loads(zf.read("rp/manifest.json").decode("utf-8"))

    assert names == {
        "bp/functions/.keep",
        "bp/manifest.json",
        "bp/notes.txt",
        "rp/manifest.json",
        "rp/notes.txt",
        "rp/textures/items/.keep",
    }
    assert bp_manifest["header"]["name"] == "Addon BP"
    assert bp_manifest["header"]["version"] == [1, 0, 0]
    assert bp_manifest["modules"][0]["type"] == "data"
    assert rp_manifest["header"]["name"] == "Addon RP"
    assert rp_manifest["header"]["version"] == [1, 0, 0]
    assert rp_manifest["modules"][0]["type"] == "resources"


def test_world_fixture_json_matches_expected_pack_ids():
    bp_json = FIXTURES / "worlds" / "World" / "world_behavior_packs.json"
    rp_json = FIXTURES / "worlds" / "World" / "world_resource_packs.json"

    assert bp_json.exists()
    assert rp_json.exists()

    bp_data = json.loads(bp_json.read_text(encoding="utf-8"))
    rp_data = json.loads(rp_json.read_text(encoding="utf-8"))

    assert bp_data == [
        {"pack_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "version": [1, 0, 0]}
    ]
    assert rp_data == [
        {"pack_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "version": [1, 0, 0]},
        {"pack_id": "cccccccc-cccc-cccc-cccc-cccccccccccc", "version": [1, 0, 0]},
    ]
