from bedrock_pack_manager.pack_index import PackIndex
from tests.helpers import PACK_UUID, run_setup, write_manifest


def test_index_reads_shared_and_world_packs(tmp_path):
    paths, target, world, world_dir = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "Shared-BP", name="Shared")
    write_manifest(world_dir / "resource_packs" / "Local-RP", uuid="33333333-3333-3333-3333-333333333333", module_type="resources", name="Local")

    index = PackIndex.build(target, world)

    assert {(pack.name, pack.scope, pack.dir_kind) for pack in index.packs} == {("Shared", "shared", "bp"), ("Local", "world", "rp")}
    assert index.find(PACK_UUID.upper())[0].folder == "Shared-BP"
    assert index.find_version(PACK_UUID, [1, 0, 0], "bp")
    assert not index.find_version(PACK_UUID, [9, 9, 9])
    assert index.problems == []


def test_index_reports_broken_and_odd_folders(tmp_path):
    paths, target, world, _ = run_setup(tmp_path)
    bp = paths.behavior_packs_dir
    (bp / "empty-leftover").mkdir()
    (bp / "broken").mkdir()
    (bp / "broken" / "manifest.json").write_text("{ not json")
    (bp / "no-uuid").mkdir()
    (bp / "no-uuid" / "manifest.json").write_text('{"header": {"name": "x"}}')
    write_manifest(bp / "Wrapper" / "Real Pack", uuid="44444444-4444-4444-4444-444444444444", name="Nested")
    write_manifest(bp / "Is A Texture Pack", uuid="55555555-5555-5555-5555-555555555555", module_type="resources", name="Misplaced")
    write_manifest(bp / "Cased", uuid="66666666-6666-6666-6666-666666666666", name="Cased", filename="Manifest.json")
    (bp / "loose-file.txt").write_text("x")

    index = PackIndex.build(target, world)
    problems = "\n".join(index.problems)

    assert "empty-leftover has no manifest.json" in problems
    assert "broken" in problems and "not valid JSON" in problems
    assert "no-uuid has no UUID" in problems
    assert "nested one folder too deep" in problems
    assert "Misplaced" not in problems and "is a resource pack but sits in" in problems
    nested = index.find("44444444-4444-4444-4444-444444444444")[0]
    assert nested.nested is True
    assert index.find("66666666-6666-6666-6666-666666666666")[0].name == "Cased"


def test_index_marks_builtin_server_packs(tmp_path):
    paths, target, world, _ = run_setup(tmp_path)
    bp = paths.behavior_packs_dir
    vanilla_uuid = "fe9f8597-5454-481a-8730-8d070a8e2e58"
    for folder in ("vanilla", "vanilla_1.14", "vanilla_1.15"):
        write_manifest(bp / folder, uuid=vanilla_uuid, name="resourcePack.vanilla_server.name")
    for folder in ("chemistry", "chemistry_1.21.30", "editor", "experimental_creator_cameras", "server_library", "server_ui_library"):
        write_manifest(bp / folder, uuid=f"{abs(hash(folder)) % 10**8:08d}-0000-0000-0000-000000000000", name="pack.name", module_type="resources")
    write_manifest(bp / "My Addon", name="pack.name")

    index = PackIndex.build(target, world)

    builtin = {pack.folder for pack in index.packs if pack.builtin}
    assert builtin == {"vanilla", "vanilla_1.14", "vanilla_1.15", "chemistry", "chemistry_1.21.30", "editor", "experimental_creator_cameras", "server_library", "server_ui_library"}
    assert index.problems == []  # no duplicate or misplaced warnings for game packs
    addon = index.find(PACK_UUID)[0]
    assert addon.builtin is False
    assert addon.name == "My Addon"  # "pack.name" is a translation key, so the folder name is shown


def test_index_treats_multi_pack_subfolders_as_storage(tmp_path):
    paths, target, world, _ = run_setup(tmp_path)
    rp = paths.resource_packs_dir
    for index_number in range(3):
        write_manifest(rp / "old" / f"Origin{index_number}", uuid=f"9999999{index_number}-0000-0000-0000-000000000000", module_type="resources")
    (rp / "old" / "broken").mkdir()
    (rp / "old" / "broken" / "manifest.json").write_text("{")
    (rp / "half-upload" / "textures").mkdir(parents=True)
    (rp / "misc" / "docs").mkdir(parents=True)

    index = PackIndex.build(target, world)

    assert index.packs == []
    assert any("old holds 3 packs" in note for note in index.notes)
    assert any("misc is not a pack" in note for note in index.notes)
    assert len(index.problems) == 1 and "half-upload has no manifest.json" in index.problems[0]


def test_index_flags_duplicate_copies(tmp_path):
    paths, target, world, _ = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "Copy One", name="Dup")
    write_manifest(paths.behavior_packs_dir / "Copy Two", name="Dup")

    index = PackIndex.build(target, world)

    assert any("installed 2 times" in problem for problem in index.problems)


def test_index_handles_string_versions_and_updates(tmp_path):
    paths, target, world, _ = run_setup(tmp_path)
    write_manifest(paths.behavior_packs_dir / "Str", version="2.1.0")

    index = PackIndex.build(target, world)
    pack = index.packs[0]

    assert pack.version == [2, 1, 0]
    assert pack.as_dict()["version_label"] == "2.1.0"
    index.remove(pack.path)
    assert index.packs == []
    index.add(pack)
    assert index.uuids() == {PACK_UUID}
    assert index.of_kind("bp") == [pack]
    assert index.folder_names("behavior_packs") == {"str"}


def test_index_skips_missing_pack_dirs(tmp_path):
    paths, target, world, _ = run_setup(tmp_path)
    paths.resource_packs_dir.rmdir()

    index = PackIndex.build(target, world)

    assert [d.path for d in index.scanned_dirs] == ["behavior_packs"]
