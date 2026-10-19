import json
import zipfile

from bedrock_pack_manager.layout import LayoutOverrides, connect_target
from bedrock_pack_manager.paths import build_paths, ensure_runtime_dirs
from bedrock_pack_manager.storage import LocalStorage

PACK_UUID = "11111111-1111-1111-1111-111111111111"
PACK_VERSION = [1, 0, 0]


def write_manifest(pack_dir, uuid=PACK_UUID, version=PACK_VERSION, name="Test Pack", module_type="data", dependencies=None, filename="manifest.json"):
    pack_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "format_version": 2,
        "header": {
            "name": name,
            "uuid": uuid,
            "version": version,
        },
        "modules": [
            {
                "type": module_type,
                "uuid": "22222222-2222-2222-2222-222222222222",
                "version": version,
            }
        ],
    }
    if dependencies is not None:
        manifest["dependencies"] = dependencies
    (pack_dir / filename).write_text(json.dumps(manifest), encoding="utf-8")


def write_world_json(path, entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def make_zip_from_dir(source_dir, zip_path):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in source_dir.rglob("*"):
            if path.is_file():
                zf.write(path, path.relative_to(source_dir))


def run_setup(tmp_path, world_name="ExampleWorld", **overrides):
    """The classic local layout: ``run/worlds``, ``run/behavior_packs``, ``run/resource_packs``."""

    paths = build_paths(tmp_path)
    ensure_runtime_dirs(paths)
    world_dir = paths.worlds_dir / world_name
    world_dir.mkdir(parents=True, exist_ok=True)
    target = connect_target(LocalStorage(paths.run_dir), LayoutOverrides(**overrides))
    return paths, target, f"worlds/{world_name}", world_dir
