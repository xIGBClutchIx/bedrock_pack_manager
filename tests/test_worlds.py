import pytest

from bedrock_pack_installer.worlds import (
    is_already_registered,
    load_world_json,
    register_pack,
    save_world_json,
    select_world,
)


def test_save_and_load_world_json_round_trip(tmp_path):
    world_json = tmp_path / "world_behavior_packs.json"
    data = [{"pack_id": "abc", "version": [1, 0, 0]}]

    save_world_json(world_json, data)

    assert load_world_json(world_json) == data


def test_register_pack_adds_entry_once(tmp_path):
    world_json = tmp_path / "world_behavior_packs.json"

    assert register_pack(world_json, "abc", [1, 0, 0]) is True
    assert register_pack(world_json, "abc", [1, 0, 0]) is False
    assert load_world_json(world_json) == [{"pack_id": "abc", "version": [1, 0, 0]}]


def test_is_already_registered_matches_pack_id():
    packs = [{"pack_id": "abc", "version": [1, 0, 0]}]

    assert is_already_registered(packs, "abc") is True
    assert is_already_registered(packs, "xyz") is False


def test_select_world_returns_only_world(tmp_path):
    only_world = tmp_path / "OnlyWorld"
    only_world.mkdir()

    assert select_world(tmp_path) == only_world


def test_select_world_uses_prompt_when_multiple_worlds(tmp_path, monkeypatch):
    world_a = tmp_path / "WorldA"
    world_b = tmp_path / "WorldB"
    world_a.mkdir()
    world_b.mkdir()

    monkeypatch.setattr("builtins.input", lambda _prompt: "2")

    assert select_world(tmp_path) == world_b


def test_select_world_shows_level_dat_and_pack_counts(tmp_path, monkeypatch, capsys):
    world_a = tmp_path / "WorldA"
    world_b = tmp_path / "WorldB"
    world_a.mkdir()
    world_b.mkdir()
    (world_a / "level.dat").write_bytes(b"x")
    save_world_json(world_a / "world_behavior_packs.json", [{"pack_id": "bp", "version": [1, 0, 0]}])
    save_world_json(world_a / "world_resource_packs.json", [{"pack_id": "rp", "version": [1, 0, 0]}])
    monkeypatch.setattr("builtins.input", lambda _prompt: "1")

    select_world(tmp_path)

    output = capsys.readouterr().out
    assert "level.dat" in output
    assert "1 BP" in output
    assert "1 RP" in output


def test_select_world_retries_until_valid_choice(tmp_path, monkeypatch):
    world_a = tmp_path / "WorldA"
    world_b = tmp_path / "WorldB"
    world_a.mkdir()
    world_b.mkdir()

    responses = iter(["x", "3", "1"])
    monkeypatch.setattr("builtins.input", lambda _prompt: next(responses))

    assert select_world(tmp_path) == world_a


def test_select_world_exits_when_no_worlds_exist(tmp_path):
    with pytest.raises(SystemExit):
        select_world(tmp_path)
