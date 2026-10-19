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


class ManifestError(ValueError):
    pass


def parse_manifest(data: bytes | str) -> dict:
    """Parse manifest bytes, tolerating BOMs, comments, and trailing commas."""

    text = data.decode("utf-8-sig", errors="replace") if isinstance(data, bytes) else data.lstrip("﻿")
    cleaned = strip_json_comments(text)
    try:
        manifest = json.loads(cleaned)
    except json.JSONDecodeError:
        try:
            manifest = json.loads(re.sub(r",(\s*[}\]])", r"\1", cleaned))
        except json.JSONDecodeError as exc:
            raise ManifestError(str(exc)) from exc
    if not isinstance(manifest, dict):
        raise ManifestError("manifest.json is not a JSON object")
    return manifest


def read_manifest(manifest_path: Path) -> dict | None:
    try:
        return parse_manifest(Path(manifest_path).read_bytes())
    except ManifestError as exc:
        error(f"Corrupt manifest.json in {manifest_path.parent.name}: {exc}")
        return None
    except OSError as exc:
        error(f"Can't read {manifest_path}: {exc}")
        return None


def classify_pack(manifest: dict) -> str | None:
    """Map manifest module types to the app's behavior/resource pack labels."""

    modules = manifest.get("modules", [])
    if not isinstance(modules, list):
        return None
    types = {str(module.get("type", "")).lower() for module in modules if isinstance(module, dict)}

    if types & BP_TYPES:
        return "bp"
    if types & RP_TYPES:
        return "rp"
    return None


def normalize_version(version) -> list:
    """Manifests use ``[1, 0, 0]``; some newer ones use ``"1.0.0"``. World JSONs want the list."""

    if isinstance(version, list):
        return version
    if isinstance(version, str):
        parts = re.split(r"[.\-+]", version)
        numbers = []
        for part in parts[:3]:
            numbers.append(int(part) if part.isdigit() else part)
        while len(numbers) < 3:
            numbers.append(0)
        return numbers
    if isinstance(version, int):
        return [version, 0, 0]
    return [0, 0, 0]


def format_version(version) -> str:
    if isinstance(version, list):
        return ".".join(str(value) for value in version)
    return str(version)


def get_pack_info(manifest: dict) -> tuple[str, list, str]:
    header = manifest.get("header", {}) if isinstance(manifest.get("header"), dict) else {}
    uuid = str(header.get("uuid", "") or "").strip()
    version = normalize_version(header.get("version", [0, 0, 0]))
    name = strip_mc_formatting(str(header.get("name", "unknown")))
    return uuid, version, name


def get_pack_dependencies(manifest: dict) -> list[dict]:
    deps = manifest.get("dependencies", [])
    return [dep for dep in deps if "uuid" in dep and "module_name" not in dep]
