"""Helpers for reading and editing Bedrock `level.dat` values through any storage."""

import io
import struct
from dataclasses import dataclass

from .storage import Storage

GAMEMODE_VALUES = {
    "survival": 0,
    "creative": 1,
    "adventure": 2,
}
GAMEMODE_NAMES = {value: name for name, value in GAMEMODE_VALUES.items()}
BETA_EXPERIMENT_KEYS = ("data_driven_items", "gametest", "experiments_ever_used", "saved_with_toggled_experiments")


@dataclass
class LevelDat:
    version: int
    nbt: object

    @property
    def beta_enabled(self) -> bool:
        import nbtlib

        experiments = self.nbt.get("experiments", nbtlib.Compound())
        return int(experiments.get("gametest", nbtlib.Byte(0))) == 1

    @property
    def gamemode(self) -> str | None:
        if "GameType" not in self.nbt:
            return None
        return GAMEMODE_NAMES.get(int(self.nbt["GameType"]))

    @property
    def level_name(self) -> str | None:
        value = self.nbt.get("LevelName")
        return str(value) if value is not None else None


def parse_level_dat(data: bytes) -> LevelDat:
    """Parse the 8-byte Bedrock header, then the little-endian NBT body."""

    import nbtlib

    if len(data) < 8:
        raise ValueError("level.dat is too short to be valid")
    version, _length = struct.unpack("<II", data[:8])
    nbt_file = nbtlib.File.parse(io.BytesIO(data[8:]), byteorder="little")
    return LevelDat(version=version, nbt=nbt_file)


def serialize_level_dat(level: LevelDat) -> bytes:
    buf = io.BytesIO()
    level.nbt.write(buf, byteorder="little")
    nbt_bytes = buf.getvalue()
    return struct.pack("<II", level.version, len(nbt_bytes)) + nbt_bytes


def read_level_dat(storage: Storage, dat_path: str) -> LevelDat:
    return parse_level_dat(storage.read_bytes(dat_path))


def backup_path(dat_path: str) -> str:
    return f"{dat_path}.backup" if not dat_path.endswith(".dat") else f"{dat_path[:-4]}.dat.backup"


def _write_with_backup(storage: Storage, dat_path: str, original: bytes, level: LevelDat) -> None:
    """Keep a sibling backup of the untouched bytes before replacing the world file."""

    storage.write_bytes(backup_path(dat_path), original)
    storage.write_bytes(dat_path, serialize_level_dat(level))


def enable_beta_apis(storage: Storage, dat_path: str) -> bool:
    import nbtlib

    original = storage.read_bytes(dat_path)
    level = parse_level_dat(original)
    if level.beta_enabled:
        return False

    if "experiments" not in level.nbt:
        level.nbt["experiments"] = nbtlib.Compound()
    experiments = level.nbt["experiments"]
    for key in BETA_EXPERIMENT_KEYS:
        experiments[key] = nbtlib.Byte(1)

    _write_with_backup(storage, dat_path, original, level)
    return True


def beta_apis_enabled(storage: Storage, dat_path: str) -> bool:
    return read_level_dat(storage, dat_path).beta_enabled


def set_world_gamemode(storage: Storage, dat_path: str, gamemode: str) -> bool:
    import nbtlib

    target_value = GAMEMODE_VALUES[gamemode.lower()]
    original = storage.read_bytes(dat_path)
    level = parse_level_dat(original)
    if "GameType" in level.nbt and int(level.nbt["GameType"]) == target_value:
        return False

    level.nbt["GameType"] = nbtlib.Int(target_value)
    _write_with_backup(storage, dat_path, original, level)
    return True
