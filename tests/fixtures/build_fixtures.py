import json
import shutil
import zipfile
from pathlib import Path


FIXTURES_DIR = Path(__file__).resolve().parent
INSTALLED_DIR = FIXTURES_DIR / "installed"
WORLD_DIR = FIXTURES_DIR / "worlds" / "World"

PACK_VERSION = [1, 0, 0]
PACK_UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
ADDON_BP_UUID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
ADDON_RP_UUID = "cccccccc-cccc-cccc-cccc-cccccccccccc"


def reset_dirs() -> None:
    if FIXTURES_DIR.exists():
        for child in FIXTURES_DIR.iterdir():
            if child.name in {"README.md", "build_fixtures.py", "__pycache__"}:
                continue
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
    INSTALLED_DIR.mkdir(parents=True, exist_ok=True)
    WORLD_DIR.mkdir(parents=True, exist_ok=True)


def write_archive(path: Path, files: dict[str, str]) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for archive_name, content in files.items():
            zf.writestr(archive_name, content)


def build_pack_mcpack() -> None:
    manifest = {
        "format_version": 2,
        "header": {"name": "Pack", "uuid": PACK_UUID, "version": PACK_VERSION},
        "modules": [
            {
                "type": "resources",
                "uuid": "dddddddd-dddd-dddd-dddd-dddddddddddd",
                "version": PACK_VERSION,
            }
        ],
    }
    write_archive(
        INSTALLED_DIR / "pack.mcpack",
        {
            "manifest.json": json.dumps(manifest),
            "pack.txt": "fixture resource pack\n",
            "textures/ui/.keep": "",
        },
    )


def build_addon_mcaddon() -> None:
    bp_manifest = {
        "format_version": 2,
        "header": {"name": "Addon BP", "uuid": ADDON_BP_UUID, "version": PACK_VERSION},
        "modules": [
            {
                "type": "data",
                "uuid": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
                "version": PACK_VERSION,
            }
        ],
    }
    rp_manifest = {
        "format_version": 2,
        "header": {"name": "Addon RP", "uuid": ADDON_RP_UUID, "version": PACK_VERSION},
        "modules": [
            {
                "type": "resources",
                "uuid": "ffffffff-ffff-ffff-ffff-ffffffffffff",
                "version": PACK_VERSION,
            }
        ],
    }
    write_archive(
        INSTALLED_DIR / "addon.mcaddon",
        {
            "bp/manifest.json": json.dumps(bp_manifest),
            "bp/functions/.keep": "",
            "bp/notes.txt": "fixture behavior pack\n",
            "rp/manifest.json": json.dumps(rp_manifest),
            "rp/notes.txt": "fixture resource pack\n",
            "rp/textures/items/.keep": "",
        },
    )


def build_world_json() -> None:
    (WORLD_DIR / "world_behavior_packs.json").write_text(
        json.dumps([{"pack_id": ADDON_BP_UUID, "version": PACK_VERSION}], indent=2) + "\n",
        encoding="utf-8",
    )
    (WORLD_DIR / "world_resource_packs.json").write_text(
        json.dumps(
            [
                {"pack_id": PACK_UUID, "version": PACK_VERSION},
                {"pack_id": ADDON_RP_UUID, "version": PACK_VERSION},
            ],
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def main() -> None:
    reset_dirs()
    build_pack_mcpack()
    build_addon_mcaddon()
    build_world_json()


if __name__ == "__main__":
    main()
