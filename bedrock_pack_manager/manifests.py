"""Manifest parsing and pack classification helpers."""

import json
import re
from pathlib import Path

from .console import error
from .constants import BP_TYPES, RP_TYPES


def strip_mc_formatting(text: str) -> str:
    """Remove Minecraft formatting codes so names are usable in logs and paths."""

    return re.sub(r"§.", "", text)


def read_manifest(manifest_path: Path) -> dict | None:
    try:
        with open(manifest_path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except json.JSONDecodeError as exc:
        error(f"Corrupt manifest.json in {manifest_path.parent.name}: {exc}")
        return None
    except OSError as exc:
        error(f"Can't read {manifest_path}: {exc}")
        return None


def classify_pack(manifest: dict) -> str | None:
    """Map manifest module types to the app's behavior/resource pack labels."""

    modules = manifest.get("modules", [])
    types = {module.get("type", "").lower() for module in modules}

    if types & BP_TYPES:
        return "bp"
    if types & RP_TYPES:
        return "rp"
    return None


def get_pack_info(manifest: dict) -> tuple[str, list, str]:
    header = manifest.get("header", {})
    uuid = header.get("uuid", "")
    version = header.get("version", [0, 0, 0])
    name = strip_mc_formatting(header.get("name", "unknown"))
    return uuid, version, name


def get_pack_dependencies(manifest: dict) -> list[dict]:
    deps = manifest.get("dependencies", [])
    return [dep for dep in deps if "uuid" in dep and "module_name" not in dep]
