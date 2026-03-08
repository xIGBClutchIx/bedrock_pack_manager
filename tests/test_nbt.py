import io
import struct
import sys
import types

from bedrock_pack_installer.nbt import enable_beta_apis


class FakeByte(int):
    pass


class FakeCompound(dict):
    pass


class FakeNBTFile(dict):
    def write(self, buf, byteorder="little"):
        assert byteorder == "little"
        buf.write(b"fake-nbt")


def make_fake_nbtlib(parsed_file):
    class FakeFile:
        @staticmethod
        def parse(stream, byteorder="little"):
            assert isinstance(stream, io.BytesIO)
            assert byteorder == "little"
            return parsed_file

    return types.SimpleNamespace(
        File=FakeFile,
        Compound=FakeCompound,
        Byte=FakeByte,
    )


def make_level_dat(path, payload=b"seed"):
    path.write_bytes(struct.pack("<II", 10, len(payload)) + payload)


def test_enable_beta_apis_updates_file_and_creates_backup(tmp_path, monkeypatch):
    dat_path = tmp_path / "level.dat"
    make_level_dat(dat_path)
    parsed = FakeNBTFile()
    monkeypatch.setitem(sys.modules, "nbtlib", make_fake_nbtlib(parsed))

    result = enable_beta_apis(dat_path)

    assert result is True
    assert (tmp_path / "level.dat.backup").exists()
    assert int(parsed["experiments"]["gametest"]) == 1
    assert dat_path.read_bytes().endswith(b"fake-nbt")


def test_enable_beta_apis_returns_false_when_already_enabled(tmp_path, monkeypatch):
    dat_path = tmp_path / "level.dat"
    make_level_dat(dat_path)
    parsed = FakeNBTFile({"experiments": {"gametest": FakeByte(1)}})
    monkeypatch.setitem(sys.modules, "nbtlib", make_fake_nbtlib(parsed))

    result = enable_beta_apis(dat_path)

    assert result is False
    assert not (tmp_path / "level.dat.backup").exists()
