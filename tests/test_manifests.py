import json

from bedrock_pack_installer.manifests import (
    classify_pack,
    get_pack_dependencies,
    get_pack_info,
    read_manifest,
    strip_mc_formatting,
)


def test_strip_mc_formatting_removes_section_codes():
    assert strip_mc_formatting("§aCool §bPack") == "Cool Pack"


def test_classify_pack_returns_bp_for_data_module():
    manifest = {"modules": [{"type": "data"}]}

    assert classify_pack(manifest) == "bp"


def test_classify_pack_returns_rp_for_resources_module():
    manifest = {"modules": [{"type": "resources"}]}

    assert classify_pack(manifest) == "rp"


def test_classify_pack_returns_none_for_unknown_modules():
    manifest = {"modules": [{"type": "foo"}]}

    assert classify_pack(manifest) is None


def test_get_pack_info_returns_uuid_version_and_clean_name():
    manifest = {
        "header": {
            "uuid": "abc",
            "version": [1, 2, 3],
            "name": "§aFancy Pack",
        }
    }

    assert get_pack_info(manifest) == ("abc", [1, 2, 3], "Fancy Pack")


def test_get_pack_dependencies_filters_out_module_dependencies():
    manifest = {
        "dependencies": [
            {"uuid": "dep-1", "version": [1, 0, 0]},
            {"module_name": "@minecraft/server", "version": "1.0.0"},
            {"uuid": "dep-2", "module_name": "@minecraft/server-ui", "version": "1.0.0"},
        ]
    }

    assert get_pack_dependencies(manifest) == [{"uuid": "dep-1", "version": [1, 0, 0]}]


def test_read_manifest_reads_valid_json(tmp_path):
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps({"header": {"uuid": "abc"}}), encoding="utf-8")

    assert read_manifest(manifest_path) == {"header": {"uuid": "abc"}}


def test_read_manifest_returns_none_for_invalid_json(tmp_path):
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text("{not-json", encoding="utf-8")

    assert read_manifest(manifest_path) is None
