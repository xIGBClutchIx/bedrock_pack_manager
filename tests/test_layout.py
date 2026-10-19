from bedrock_pack_manager.layout import LayoutOverrides, connect_target, detect_layout, parse_server_properties
from bedrock_pack_manager.storage import LocalStorage
from tests.helpers import run_setup


def _storage(root):
    root.mkdir(parents=True, exist_ok=True)
    return LocalStorage(root)


def test_detects_bedrock_server_root(tmp_path):
    root = tmp_path / "srv"
    (root / "worlds" / "Bedrock level").mkdir(parents=True)
    (root / "behavior_packs").mkdir()
    (root / "development_resource_packs").mkdir()
    (root / "server.properties").write_text("# comment\nlevel-name=Bedrock level\nserver-port=19132\n")

    target = connect_target(_storage(root))

    layout = target.layout
    assert (layout.server_root, layout.worlds_dir, layout.bp_dir, layout.rp_dir) == ("", "worlds", "behavior_packs", "resource_packs")
    assert layout.dev_rp_dir == "development_resource_packs" and layout.dev_bp_dir is None
    assert layout.level_name == "Bedrock level"
    assert target.default_world() == "worlds/Bedrock level"


def test_finds_server_nested_two_levels_down(tmp_path):
    root = tmp_path / "ftp"
    (root / "home" / "container" / "worlds" / "W").mkdir(parents=True)
    (root / "home" / "container" / "server.properties").write_text("level-name=W\n")
    (root / "logs").mkdir()

    target = connect_target(_storage(root))

    assert target.layout.server_root == "home/container"
    assert target.layout.worlds_dir == "home/container/worlds"
    assert target.layout.bp_dir == "home/container/behavior_packs"
    assert target.list_worlds() == ["home/container/worlds/W"]
    assert any("home/container" in note for note in target.layout.notes)


def test_matches_folder_names_case_insensitively(tmp_path):
    root = tmp_path / "srv"
    (root / "Worlds" / "A").mkdir(parents=True)
    (root / "Behavior_Packs").mkdir()

    layout = detect_layout(_storage(root))

    assert layout.worlds_dir == "Worlds"
    assert layout.bp_dir == "Behavior_Packs"


def test_pointing_at_worlds_folder_uses_sibling_pack_folders(tmp_path):
    server = tmp_path / "srv"
    (server / "worlds" / "A").mkdir(parents=True)
    (server / "worlds" / "A" / "level.dat").write_bytes(b"x")
    (server / "behavior_packs").mkdir()

    target = connect_target(LocalStorage(server / "worlds"))

    assert target.layout.worlds_dir == ""
    assert target.layout.bp_dir == "../behavior_packs"
    assert target.layout.rp_dir is None
    assert target.list_worlds() == ["A"]
    assert target.install_dir("A", "rp") == "A/resource_packs"


def test_pointing_at_a_single_world_uses_world_pack_folders(tmp_path):
    world = tmp_path / "MyWorld"
    world.mkdir()
    (world / "level.dat").write_bytes(b"x")
    (world / "behavior_packs").mkdir()

    target = connect_target(LocalStorage(world))

    assert target.layout.single_world == ""
    assert target.layout.bp_dir is None and target.layout.rp_dir is None
    assert target.list_worlds() == [""]
    assert target.install_dir("", "bp") == "behavior_packs"
    assert [(d.path, d.scope) for d in target.pack_dirs("")] == [("behavior_packs", "world")]


def test_empty_folder_falls_back_to_default_names(tmp_path):
    target = connect_target(_storage(tmp_path / "empty"))

    assert target.layout.worlds_dir == "worlds"
    assert target.list_worlds() == []
    assert target.default_world() is None
    assert "No worlds folder found yet" in target.layout.notes


def test_overrides_win_over_detection(tmp_path):
    root = tmp_path / "srv"
    (root / "custom" / "maps" / "A").mkdir(parents=True)

    target = connect_target(_storage(root), LayoutOverrides(worlds_dir="custom/maps", bp_dir="custom/bp", rp_dir="custom/rp", pack_scope="world"))

    assert target.list_worlds() == ["custom/maps/A"]
    assert target.layout.bp_dir == "custom/bp"
    assert target.install_dir("custom/maps/A", "bp") == "custom/maps/A/behavior_packs"


def test_server_root_override(tmp_path):
    root = tmp_path / "srv"
    (root / "a" / "worlds" / "W").mkdir(parents=True)
    (root / "b" / "worlds" / "X").mkdir(parents=True)

    target = connect_target(_storage(root), LayoutOverrides(server_root="b"))

    assert target.list_worlds() == ["b/worlds/X"]


def test_pack_dirs_include_world_local_folders(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    (world_dir / "Resource_Packs").mkdir()

    dirs = [(d.path, d.kind, d.scope) for d in target.pack_dirs(world)]

    assert ("behavior_packs", "bp", "shared") in dirs
    assert ("resource_packs", "rp", "shared") in dirs
    assert (f"{world}/Resource_Packs", "rp", "world") in dirs


def test_find_world_ignores_hidden_and_matches_case(tmp_path):
    paths, target, world, _ = run_setup(tmp_path, "Alpha")
    (paths.worlds_dir / ".hidden").mkdir()
    (paths.worlds_dir / "__MACOSX").mkdir()

    assert target.list_worlds() == ["worlds/Alpha"]
    assert target.find_world("alpha") == "worlds/Alpha"
    assert target.find_world("missing") is None


def test_layout_overrides_from_dict_cleans_values():
    overrides = LayoutOverrides.from_dict({"server_root": "  ", "worlds_dir": " w ", "pack_scope": "bogus"})

    assert overrides.server_root is None
    assert overrides.worlds_dir == "w"
    assert overrides.pack_scope == "shared"


def test_layout_display_uses_full_paths(tmp_path):
    _paths, target, _world, _ = run_setup(tmp_path)

    display = target.layout_display()

    assert display["worlds_dir"].endswith("worlds")
    assert display["pack_scope"] == "shared"


def test_parse_server_properties():
    assert parse_server_properties("a=1\n# x=2\nbad line\nlevel-name = My World \n") == {"a": "1", "level-name": "My World"}
