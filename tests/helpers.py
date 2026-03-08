import json
import zipfile


PACK_UUID = "11111111-1111-1111-1111-111111111111"
PACK_VERSION = [1, 0, 0]


def write_manifest(pack_dir, uuid=PACK_UUID, version=PACK_VERSION, name="Test Pack", module_type="data"):
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
    (pack_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def write_world_json(path, entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")


def make_zip_from_dir(source_dir, zip_path):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in source_dir.rglob("*"):
            if path.is_file():
                zf.write(path, path.relative_to(source_dir))
