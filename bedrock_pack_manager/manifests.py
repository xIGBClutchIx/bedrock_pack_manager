"""Manifest parsing and pack classification helpers."""

import json
import re
from pathlib import Path

from .console import error
from .constants import BP_TYPES, RP_TYPES


def strip_mc_formatting(text: str) -> str:
    """Remove Minecraft formatting codes so names are usable in logs and paths."""

    return re.sub(r"§.", "", text)


def strip_json_comments(text: str) -> str:
    """Remove ``//`` and ``/* ... */`` comments outside JSON strings."""

    result: list[str] = []
    i = 0
    in_string = False
    escaped = False
    length = len(text)

    while i < length:
        char = text[i]

        if in_string:
            result.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            i += 1
            continue

        if char == '"':
            in_string = True
            result.append(char)
            i += 1
            continue

        if char == "/" and i + 1 < length:
            next_char = text[i + 1]

            if next_char == "/":
                i += 2
                while i < length and text[i] not in "\r\n":
                    i += 1
                continue

            if next_char == "*":
                i += 2
                while i + 1 < length and text[i : i + 2] != "*/":
                    i += 1
                i = i + 2 if i + 1 < length else length
                continue

        result.append(char)
        i += 1

    return "".join(result)


def read_manifest(manifest_path: Path) -> dict | None:
    try:
        with open(manifest_path, "r", encoding="utf-8-sig") as f:
            return json.loads(strip_json_comments(f.read()))
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
