import io
import struct

import nbtlib
import pytest
from bedrock_pack_manager.nbt import (
    beta_apis_enabled,
    enable_beta_apis,
    parse_level_dat,
    read_level_dat,
    serialize_level_dat,
    set_world_gamemode,
)
from bedrock_pack_manager.storage import LocalStorage


def level_bytes(**values):
    root = nbtlib.Compound(values)
    buf = io.BytesIO()
    nbtlib.File(root).write(buf, byteorder="little")
    body = buf.getvalue()
    return struct.pack("<II", 10, len(body)) + body


def test_parse_and_serialize_round_trip():
    data = level_bytes(GameType=nbtlib.Int(2), LevelName=nbtlib.String("Hi"))

    level = parse_level_dat(data)

    assert level.version == 10
    assert level.gamemode == "adventure"
    assert level.level_name == "Hi"
    assert level.beta_enabled is False
    assert parse_level_dat(serialize_level_dat(level)).gamemode == "adventure"


def test_parse_rejects_short_files():
    with pytest.raises(ValueError):
        parse_level_dat(b"1234")


def test_level_without_game_type_or_name():
    level = parse_level_dat(level_bytes(Other=nbtlib.Int(1)))

    assert level.gamemode is None
    assert level.level_name is None


def test_enable_beta_apis_writes_backup_of_original_bytes(tmp_path):
    original = level_bytes(GameType=nbtlib.Int(0))
    (tmp_path / "level.dat").write_bytes(original)
    storage = LocalStorage(tmp_path)

    assert enable_beta_apis(storage, "level.dat") is True
    assert enable_beta_apis(storage, "level.dat") is False

    assert (tmp_path / "level.dat.backup").read_bytes() == original
    assert beta_apis_enabled(storage, "level.dat") is True
    experiments = read_level_dat(storage, "level.dat").nbt["experiments"]
    assert all(int(experiments[key]) == 1 for key in ("data_driven_items", "gametest", "experiments_ever_used", "saved_with_toggled_experiments"))


def test_set_world_gamemode(tmp_path):
    (tmp_path / "level.dat").write_bytes(level_bytes(GameType=nbtlib.Int(0)))
    storage = LocalStorage(tmp_path)

    assert set_world_gamemode(storage, "level.dat", "Creative") is True
    assert set_world_gamemode(storage, "level.dat", "creative") is False
    assert read_level_dat(storage, "level.dat").gamemode == "creative"
