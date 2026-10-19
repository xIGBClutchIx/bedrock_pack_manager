import bedrock_pack_manager.worlds as worlds
import pytest
from bedrock_pack_manager.storage import LocalStorage
from bedrock_pack_manager.worlds import (
    load_world_json,
    registered_keys,
    remove_entry,
    resolve_world_path,
    save_world_json,
    select_world,
    upsert_entry,
    world_details,
)
from tests.helpers import run_setup, write_world_json


def test_save_and_load_round_trip(tmp_path):
    storage = LocalStorage(tmp_path)
    data = [{"pack_id": "abc", "version": [1, 0, 0]}]

    save_world_json(storage, "w/world_behavior_packs.json", data)

    assert load_world_json(storage, "w/world_behavior_packs.json") == data
    assert (tmp_path / "w" / "world_behavior_packs.json").read_text().endswith("\n")


def test_load_tolerates_missing_empty_bom_and_comments(tmp_path):
    storage = LocalStorage(tmp_path)
    (tmp_path / "empty.json").write_text("  ")
    (tmp_path / "bom.json").write_bytes('﻿// note\n[{"pack_id": "a", "version": [1,0,0]}, "junk"]'.encode("utf-8"))

    assert load_world_json(storage, "missing.json") == []
    assert load_world_json(storage, "empty.json") == []
    assert load_world_json(storage, "bom.json") == [{"pack_id": "a", "version": [1, 0, 0]}]


def test_load_raises_clear_errors(tmp_path):
    storage = LocalStorage(tmp_path)
    (tmp_path / "bad.json").write_text("[{")
    (tmp_path / "obj.json").write_text("{}")

    with pytest.raises(ValueError, match="Corrupt world pack JSON"):
        load_world_json(storage, "bad.json")
    with pytest.raises(ValueError, match="not a list"):
        load_world_json(storage, "obj.json")


def test_entry_helpers_match_uuid_case_insensitively():
    packs = [{"pack_id": "ABC", "version": [1, 0, 0]}]

    assert upsert_entry(packs, "abc", [1, 0, 0]) == "unchanged"
    assert upsert_entry(packs, "abc", [2, 0, 0]) == "updated"
    assert upsert_entry(packs, "def", [1, 0, 0]) == "added"
    assert registered_keys(packs) == {("abc", (2, 0, 0)), ("def", (1, 0, 0))}
    assert remove_entry(packs, "Abc") is True
    assert remove_entry(packs, "zzz") is False
    assert packs == [{"pack_id": "def", "version": [1, 0, 0]}]


def test_resolve_world_path_relative_and_errors(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    (paths.worlds_dir / "file.txt").write_text("x")

    assert resolve_world_path(target, "ExampleWorld") == world
    assert resolve_world_path(target, "worlds/ExampleWorld") == world
    with pytest.raises(ValueError, match="does not exist"):
        resolve_world_path(target, "Nope")
    with pytest.raises(ValueError, match="not a directory"):
        resolve_world_path(target, "file.txt")


def test_world_details_counts_packs(tmp_path):
    _paths, target, world, world_dir = run_setup(tmp_path)
    (world_dir / "level.dat").write_bytes(b"x")
    write_world_json(world_dir / "world_behavior_packs.json", [{"pack_id": "a", "version": [1, 0, 0]}])
    (world_dir / "world_resource_packs.json").write_text("[{")

    details = world_details(target, world)

    assert "level.dat" in details and "1 BP" in details and "bad RP json" in details
    assert world_details(target, "worlds/missing") == ""


def test_select_world_single_and_none(tmp_path, capsys):
    paths, target, world, _ = run_setup(tmp_path)

    assert select_world(target) == world
    assert "Only one world available" in capsys.readouterr().out

    (paths.worlds_dir / "ExampleWorld").rmdir()
    with pytest.raises(ValueError, match="No worlds found"):
        select_world(target)


def test_select_world_prompt_retries(tmp_path, monkeypatch, capsys):
    paths, target, _world, _ = run_setup(tmp_path, "A")
    (paths.worlds_dir / "B").mkdir()
    answers = iter(["x", "9", "2"])
    monkeypatch.setattr(worlds, "is_interactive_terminal", lambda: False)
    monkeypatch.setattr("builtins.input", lambda _prompt: next(answers))

    assert select_world(target) == "worlds/B"
    output = capsys.readouterr().out
    assert "Enter a number" in output and "Invalid choice" in output


def test_select_world_prompt_eof(tmp_path, monkeypatch):
    paths, target, _world, _ = run_setup(tmp_path, "A")
    (paths.worlds_dir / "B").mkdir()
    monkeypatch.setattr(worlds, "is_interactive_terminal", lambda: False)
    monkeypatch.setattr("builtins.input", lambda _prompt: (_ for _ in ()).throw(EOFError()))

    with pytest.raises(ValueError, match="No world selected"):
        select_world(target)


def test_select_world_interactive_starts_on_server_level_name(tmp_path, monkeypatch, capsys):
    paths, target, _world, _ = run_setup(tmp_path, "A")
    (paths.worlds_dir / "B").mkdir()
    (paths.worlds_dir / "C").mkdir()
    target.layout.level_name = "B"
    keys = iter(["\x1b[B", "\x1b[A", "\x1b[A", "\n"])
    monkeypatch.setattr(worlds, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr(worlds, "read_keypress", lambda: next(keys))

    assert select_world(target) == "worlds/A"
    assert "3 world(s) available" in capsys.readouterr().out


def test_select_world_interactive_quits(tmp_path, monkeypatch):
    paths, target, _world, _ = run_setup(tmp_path, "A")
    (paths.worlds_dir / "B").mkdir()
    monkeypatch.setattr(worlds, "is_interactive_terminal", lambda: True)
    monkeypatch.setattr(worlds, "read_keypress", lambda: "q")

    with pytest.raises(KeyboardInterrupt):
        select_world(target)
