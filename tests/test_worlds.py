import pytest
from bedrock_pack_installer.worlds import (
    _move_cursor,
    find_world_by_name,
    is_already_registered,
    load_world_json,
    register_pack,
    remove_pack,
    resolve_world_path,
    save_world_json,
    select_world,
)


def test_save_and_load_world_json_round_trip(tmp_path):
    world_json = tmp_path / "world_behavior_packs.json"
    data = [{"pack_id": "abc", "version": [1, 0, 0]}]

    save_world_json(world_json, data)

    assert load_world_json(world_json) == data


def test_load_world_json_raises_clear_error_for_invalid_json(tmp_path):
    world_json = tmp_path / "world_behavior_packs.json"
    world_json.write_text('[{"pack_id":"abc","version":[1,0,0]},\n', encoding="utf-8")

    with pytest.raises(ValueError) as exc_info:
        load_world_json(world_json)

    assert "Corrupt world pack JSON" in str(exc_info.value)
    assert str(world_json) in str(exc_info.value)
    assert "line 2, column 1" in str(exc_info.value)


def test_register_pack_adds_entry_once(tmp_path):
    world_json = tmp_path / "world_behavior_packs.json"

    assert register_pack(world_json, "abc", [1, 0, 0]) is True
    assert register_pack(world_json, "abc", [1, 0, 0]) is False
    assert load_world_json(world_json) == [{"pack_id": "abc", "version": [1, 0, 0]}]


def test_remove_pack_removes_matching_entry(tmp_path):
    world_json = tmp_path / "world_behavior_packs.json"
    save_world_json(world_json, [{"pack_id": "abc", "version": [1, 0, 0]}, {"pack_id": "xyz", "version": [2, 0, 0]}])

    assert remove_pack(world_json, "abc") is True
    assert load_world_json(world_json) == [{"pack_id": "xyz", "version": [2, 0, 0]}]


def test_remove_pack_returns_false_when_uuid_missing(tmp_path):
    world_json = tmp_path / "world_behavior_packs.json"
    save_world_json(world_json, [{"pack_id": "xyz", "version": [2, 0, 0]}])

    assert remove_pack(world_json, "abc") is False


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

    monkeypatch.setattr("bedrock_pack_installer.worlds.is_interactive_terminal", lambda: False)
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
    monkeypatch.setattr("bedrock_pack_installer.worlds.is_interactive_terminal", lambda: False)
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
    monkeypatch.setattr("bedrock_pack_installer.worlds.is_interactive_terminal", lambda: False)
    monkeypatch.setattr("builtins.input", lambda _prompt: next(responses))

    assert select_world(tmp_path) == world_a


def test_select_world_interactive_uses_arrows_and_enter(tmp_path, monkeypatch, capsys):
    world_a = tmp_path / "WorldA"
    world_b = tmp_path / "WorldB"
    world_a.mkdir()
    world_b.mkdir()

    monkeypatch.setattr("bedrock_pack_installer.worlds.is_interactive_terminal", lambda: True)
    keys = iter(["\x1b[B", "\n"])
    monkeypatch.setattr("bedrock_pack_installer.worlds.read_keypress", lambda: next(keys))

    assert select_world(tmp_path) == world_b
    output = capsys.readouterr().out
    assert "Worlds" in output
    assert "↑/↓ move  Enter select  Q quit" in output


def test_select_world_interactive_quits_on_q(tmp_path, monkeypatch):
    world_a = tmp_path / "WorldA"
    world_b = tmp_path / "WorldB"
    world_a.mkdir()
    world_b.mkdir()

    monkeypatch.setattr("bedrock_pack_installer.worlds.is_interactive_terminal", lambda: True)
    monkeypatch.setattr("bedrock_pack_installer.worlds.read_keypress", lambda: "q")

    with pytest.raises(KeyboardInterrupt):
        select_world(tmp_path)


def test_move_cursor_wraps_for_world_menu():
    assert _move_cursor(0, 3, "up") == 2
    assert _move_cursor(2, 3, "down") == 0


def test_select_world_exits_when_no_worlds_exist(tmp_path):
    with pytest.raises(SystemExit):
        select_world(tmp_path)


def test_select_world_shows_relative_path_when_no_worlds_exist(tmp_path, monkeypatch, capsys):
    worlds_dir = tmp_path / "run" / "worlds"
    monkeypatch.chdir(tmp_path)

    with pytest.raises(SystemExit):
        select_world(worlds_dir)

    assert "run/worlds" in capsys.readouterr().out


def test_find_world_by_name_returns_matching_directory(tmp_path):
    world_dir = tmp_path / "WorldA"
    world_dir.mkdir()

    assert find_world_by_name(tmp_path, "WorldA") == world_dir


def test_find_world_by_name_returns_none_for_missing_world(tmp_path):
    assert find_world_by_name(tmp_path, "MissingWorld") is None


def test_resolve_world_path_accepts_relative_path(tmp_path):
    worlds_dir = tmp_path / "run" / "worlds"
    world_dir = worlds_dir / "WorldA"
    world_dir.mkdir(parents=True)

    assert resolve_world_path(worlds_dir, "WorldA") == world_dir.resolve()


def test_resolve_world_path_rejects_missing_directory(tmp_path):
    worlds_dir = tmp_path / "run" / "worlds"
    worlds_dir.mkdir(parents=True)

    with pytest.raises(ValueError):
        resolve_world_path(worlds_dir, "MissingWorld")
