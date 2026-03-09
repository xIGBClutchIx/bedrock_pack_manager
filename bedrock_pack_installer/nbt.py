import io
import shutil
import struct
from pathlib import Path

GAMEMODE_VALUES = {
    "survival": 0,
    "creative": 1,
    "adventure": 2,
}


def _read_level_dat(dat_path: Path):
    import nbtlib

    with open(dat_path, "rb") as f:
        header = f.read(8)
        version, _ = struct.unpack("<II", header)
        nbt_data = f.read()

    nbt_file = nbtlib.File.parse(io.BytesIO(nbt_data), byteorder="little")
    return nbtlib, version, nbt_file


def _write_level_dat(dat_path: Path, version: int, nbt_file) -> None:
    buf = io.BytesIO()
    nbt_file.write(buf, byteorder="little")
    nbt_bytes = buf.getvalue()

    with open(dat_path, "wb") as f:
        f.write(struct.pack("<II", version, len(nbt_bytes)))
        f.write(nbt_bytes)


def _backup_level_dat(dat_path: Path) -> None:
    shutil.copy2(dat_path, dat_path.with_suffix(".dat.backup"))


def enable_beta_apis(dat_path: Path) -> bool:
    nbtlib, version, nbt_file = _read_level_dat(dat_path)

    if "experiments" not in nbt_file:
        nbt_file["experiments"] = nbtlib.Compound()

    experiments = nbt_file["experiments"]
    current_beta = experiments.get("gametest", nbtlib.Byte(0))
    if int(current_beta) == 1:
        return False

    _backup_level_dat(dat_path)

    experiments["data_driven_items"] = nbtlib.Byte(1)
    experiments["gametest"] = nbtlib.Byte(1)
    experiments["experiments_ever_used"] = nbtlib.Byte(1)
    experiments["saved_with_toggled_experiments"] = nbtlib.Byte(1)

    _write_level_dat(dat_path, version, nbt_file)
    return True


def set_world_gamemode(dat_path: Path, gamemode: str) -> bool:
    import nbtlib

    normalized_gamemode = gamemode.lower()
    target_value = GAMEMODE_VALUES[normalized_gamemode]

    _, version, nbt_file = _read_level_dat(dat_path)
    current_gametype = nbt_file.get("GameType", nbtlib.Int(0))
    if int(current_gametype) == target_value:
        return False

    _backup_level_dat(dat_path)
    nbt_file["GameType"] = nbtlib.Int(target_value)
    _write_level_dat(dat_path, version, nbt_file)
    return True
