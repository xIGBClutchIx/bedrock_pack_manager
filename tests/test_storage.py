import json
import sys
from pathlib import Path

import pytest
from bedrock_pack_manager.storage import ConnectionSettings, LocalStorage, StorageError, join, open_storage, parent, parse_remote_url, redact_url
from bedrock_pack_manager.storage.base import basename
from bedrock_pack_manager.storage.ftp import FTPStorage, parse_list_line
from bedrock_pack_manager.storage.sftp import UnknownHostKeyError, fingerprint_of
from tests.fake_sftp import host_key, make_sftp_storage

# ---- path helpers ------------------------------------------------------------------------------


def test_join_normalizes_and_handles_absolute_parts():
    assert join("worlds", "World") == "worlds/World"
    assert join("", "worlds") == "worlds"
    assert join() == ""
    assert join("a", "/abs/b") == "/abs/b"
    assert join("a/./b/../c") == "a/c"
    assert join("root", "C:\\Users\\me") == "C:/Users/me"
    assert join("C:") == "C:/"
    assert parent("worlds/World") == "worlds"
    assert parent("worlds") == ""
    assert parent("C:/x") == "C:/"
    assert basename("worlds/World/") == "World"


# ---- the storage contract, run against local, FTP and SFTP ----------------------------------------------


def test_write_and_read_round_trip(any_storage):
    storage, root = any_storage

    storage.write_text("deep/nested/file.json", '{"a": 1}')

    assert storage.read_text("deep/nested/file.json") == '{"a": 1}'
    assert (root / "deep" / "nested" / "file.json").read_text() == '{"a": 1}'
    assert not any(path.name.endswith(".bpm-tmp") for path in root.rglob("*"))


def test_atomic_write_replaces_existing_file(any_storage):
    storage, root = any_storage
    storage.write_text("file.txt", "old")

    storage.write_text("file.txt", "new")

    assert (root / "file.txt").read_text() == "new"
    assert sorted(path.name for path in root.iterdir()) == ["file.txt"]


def test_read_missing_file_raises_file_not_found(any_storage):
    storage, _root = any_storage

    with pytest.raises(FileNotFoundError):
        storage.read_bytes("nope.txt")


def test_list_dir_stat_and_queries(any_storage):
    storage, root = any_storage
    (root / "Worlds" / "A").mkdir(parents=True)
    (root / "file.txt").write_text("x")

    names = [(entry.name, entry.is_dir) for entry in storage.list_dir("")]

    assert ("Worlds", True) in names and ("file.txt", False) in names
    assert storage.is_dir("Worlds") and not storage.is_dir("file.txt")
    assert storage.is_file("file.txt") and not storage.exists("missing")
    assert storage.stat("missing/deeper") is None
    assert storage.find_child("", "worlds", want_dir=True) == "Worlds"
    assert storage.find_child("", "worlds", want_dir=False) is None
    assert storage.find_child("missing", "x") is None
    with pytest.raises(FileNotFoundError):
        storage.list_dir("missing")


def test_mkdirs_is_idempotent(any_storage):
    storage, root = any_storage

    storage.mkdirs("a/b/c")
    storage.mkdirs("a/b/c")

    assert (root / "a" / "b" / "c").is_dir()


def test_remove_tree_and_refuses_root(any_storage):
    storage, root = any_storage
    (root / "pack" / "sub").mkdir(parents=True)
    (root / "pack" / "sub" / "f.txt").write_text("x")
    (root / "pack" / "manifest.json").write_text("{}")

    storage.remove_tree("pack")
    storage.remove_tree("pack")

    assert not (root / "pack").exists()
    with pytest.raises(StorageError):
        storage.remove_tree("")


def test_rename_and_copy_file(any_storage):
    storage, root = any_storage
    storage.write_text("a/one.txt", "1")

    storage.rename("a", "b")
    storage.copy_file("b/one.txt", "c/two.txt")

    assert (root / "b" / "one.txt").read_text() == "1"
    assert (root / "c" / "two.txt").read_text() == "1"
    assert not (root / "a").exists()


def test_upload_tree_skips_junk_and_excluded_and_writes_manifest_last(any_storage, tmp_path):
    storage, root = any_storage
    source = tmp_path / "source_pack"
    (source / "textures").mkdir(parents=True)
    (source / "textures" / "a.png").write_bytes(b"png")
    (source / "manifest.json").write_text("{}")
    (source / "__MACOSX").mkdir()
    (source / "__MACOSX" / "junk").write_text("x")
    (source / ".DS_Store").write_text("x")
    (source / "inner_pack").mkdir()
    (source / "inner_pack" / "manifest.json").write_text("{}")

    order = []
    count = storage.upload_tree(source, "packs/Uploaded", exclude={source / "inner_pack"}, progress=order.append)

    assert count == 2
    assert order[-1].endswith("manifest.json")
    uploaded = sorted(path.relative_to(root / "packs" / "Uploaded").as_posix() for path in (root / "packs" / "Uploaded").rglob("*"))
    assert uploaded == ["manifest.json", "textures", "textures/a.png"]


def test_download_files_yields_relative_paths(any_storage):
    storage, root = any_storage
    (root / "w" / "db").mkdir(parents=True)
    (root / "w" / "level.dat").write_bytes(b"L")
    (root / "w" / "db" / "CURRENT").write_bytes(b"C")

    files = dict(storage.download_files("w"))

    assert files == {"level.dat": b"L", "db/CURRENT": b"C"}


def test_listing_cache_is_invalidated_by_writes(any_storage):
    storage, _root = any_storage
    storage.mkdirs("dir")
    assert storage.list_dir("dir") == []

    storage.write_text("dir/new.txt", "x")

    assert [entry.name for entry in storage.list_dir("dir")] == ["new.txt"]


def test_parallel_keeps_order_and_returns_errors(any_storage):
    storage, root = any_storage
    for index in range(12):
        (root / f"f{index}.txt").write_text(str(index))

    results = storage.read_many([f"f{index}.txt" for index in range(12)] + ["missing.txt"])

    assert [results[f"f{index}.txt"] for index in range(12)] == [str(index).encode() for index in range(12)]
    assert isinstance(results["missing.txt"], FileNotFoundError)
    storage.close_workers()


def test_scan_tree_lists_everything(any_storage):
    storage, root = any_storage
    (root / "a" / "b" / "c").mkdir(parents=True)
    (root / "a" / "x.txt").write_text("x")
    (root / "a" / "b" / "c" / "y.txt").write_text("y")

    dirs, files = storage.scan_tree("a")

    assert dirs == ["a", "a/b", "a/b/c"]
    assert sorted(files) == ["a/b/c/y.txt", "a/x.txt"]


def test_workers_never_see_stale_listings(sftp_storage, tmp_path):
    (tmp_path / "sftp" / "d").mkdir()
    for _ in range(2):
        sftp_storage.parallel(lambda storage, _item: storage.list_dir("d"), range(6))

    sftp_storage.write_text("d/new.txt", "x")
    listings = sftp_storage.parallel(lambda storage, _item: [entry.name for entry in storage.list_dir("d")], range(6))

    assert all(listing == ["new.txt"] for listing in listings)


def test_remote_storages_open_extra_workers(ftp_storage, sftp_storage):
    for storage in (ftp_storage, sftp_storage):
        storage.read_many(["a", "b", "c", "d"])
        assert len(storage._workers) == 3
        storage.close()
        assert storage._workers == []


def test_parallel_falls_back_when_server_refuses_more_connections(sftp_storage, monkeypatch, tmp_path):
    (tmp_path / "sftp" / "a.txt").write_text("a")
    monkeypatch.setattr(sftp_storage, "_spawn", lambda: (_ for _ in ()).throw(StorageError("too many connections")))

    assert sftp_storage.read_many(["a.txt", "a.txt"])["a.txt"] == b"a"
    assert sftp_storage._workers == []


def test_upload_tree_reports_failed_files(sftp_storage, tmp_path, monkeypatch):
    source = tmp_path / "pack"
    source.mkdir()
    (source / "a.txt").write_text("a")
    (source / "manifest.json").write_text("{}")

    def broken_write(path, data):
        raise StorageError(f"disk full writing {path}")

    monkeypatch.setattr(sftp_storage, "_write_bytes", broken_write)

    with pytest.raises(StorageError, match="disk full"):
        sftp_storage.upload_tree(source, "packs/P")
    assert not (tmp_path / "sftp" / "packs" / "P" / "manifest.json").exists()


# ---- local specifics ------------------------------------------------------------------------------


def test_local_storage_resolves_absolute_paths_and_describes(tmp_path, monkeypatch):
    storage = LocalStorage(tmp_path / "root")
    other = tmp_path / "other"
    other.mkdir()

    assert storage.resolve(str(other)) == other
    monkeypatch.chdir(tmp_path)
    assert storage.describe("worlds") == str(Path("root") / "worlds")


# ---- FTP specifics --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "line, expected",
    [
        ("drwxr-xr-x    2 mc  mc   4096 Jan 01 12:00 behavior_packs", ("behavior_packs", True)),
        ("-rw-r--r--    1 mc  mc    123 Jan 01  2024 server.properties", ("server.properties", False)),
        ("-rw-r--r--    1 mc  mc    123 Jan 01  2024 name with spaces.mcpack", ("name with spaces.mcpack", False)),
        ("lrwxrwxrwx    1 mc  mc      9 Jan 01 12:00 worlds -> /data/worlds", ("worlds", True)),
        ("01-02-24  10:15AM       <DIR>          worlds", ("worlds", True)),
        ("01-02-24  10:15AM                  512 level.dat", ("level.dat", False)),
    ],
)
def test_parse_list_line_handles_unix_and_dos(line, expected):
    entry = parse_list_line(line)

    assert (entry.name, entry.is_dir) == expected


def test_parse_list_line_ignores_garbage():
    assert parse_list_line("total 12") is None


def test_ftp_list_fallback_when_mlsd_unsupported(ftp_storage, ftp_server):
    (ftp_server["root"] / "worlds").mkdir()
    (ftp_server["root"] / "a file.txt").write_text("x")
    ftp_storage._mlsd_supported = False

    names = {(entry.name, entry.is_dir) for entry in ftp_storage.list_dir("")}

    assert names == {("worlds", True), ("a file.txt", False)}


def test_ftp_relative_root_is_joined_to_login_folder(ftp_server):
    (ftp_server["root"] / "bedrock").mkdir()
    storage = FTPStorage(ftp_server["host"], port=ftp_server["port"], username="mc", password="pw", root="bedrock")
    try:
        storage.write_text("hello.txt", "hi")
        assert storage.root == "/bedrock"
        assert storage.describe("x") == "/bedrock/x"
    finally:
        storage.close()
    assert (ftp_server["root"] / "bedrock" / "hello.txt").read_text() == "hi"


def test_ftp_bad_login_raises_storage_error(ftp_server):
    with pytest.raises(StorageError, match="login failed"):
        FTPStorage(ftp_server["host"], port=ftp_server["port"], username="mc", password="wrong")


def test_ftp_unreachable_host_raises_storage_error():
    with pytest.raises(StorageError, match="Could not connect"):
        FTPStorage("127.0.0.1", port=1, username="mc", password="pw", timeout=2)


def test_ftp_reconnects_after_dropped_connection(ftp_storage, ftp_server):
    (ftp_server["root"] / "f.txt").write_text("ok")
    ftp_storage._ftp.sock.close()

    assert ftp_storage.read_text("f.txt") == "ok"


# ---- SFTP specifics -------------------------------------------------------------------------------


def test_sftp_unknown_host_key_raises_with_fingerprint(tmp_path):
    with pytest.raises(UnknownHostKeyError) as info:
        make_sftp_storage(tmp_path, trusted=False)

    assert info.value.fingerprint == fingerprint_of(host_key())
    assert info.value.fingerprint.startswith("SHA256:")


def test_sftp_trusted_fingerprint_is_remembered(tmp_path):
    known_hosts = tmp_path / "known_hosts"

    make_sftp_storage(tmp_path, known_hosts_file=known_hosts).close()
    storage = make_sftp_storage(tmp_path, trusted=False, known_hosts_file=known_hosts)
    storage.close()

    assert host_key().get_base64() in known_hosts.read_text()


def test_sftp_without_paramiko_explains_how_to_fix(tmp_path, monkeypatch):
    from bedrock_pack_manager.storage.sftp import SFTPStorage

    monkeypatch.setitem(sys.modules, "paramiko", None)

    with pytest.raises(StorageError, match="pip install -r requirements.txt"):
        SFTPStorage("sftp.test", username="mc", password="pw")


def test_sftp_bad_password_raises_storage_error(tmp_path):
    with pytest.raises(StorageError, match="login failed"):
        make_sftp_storage(tmp_path, password="wrong")


# ---- connection settings --------------------------------------------------------------------------


def test_parse_remote_url_variants():
    sftp = parse_remote_url("sftp://mc@host.example:2022/srv/bedrock")
    assert (sftp.protocol, sftp.host, sftp.port, sftp.username, sftp.root) == ("sftp", "host.example", 2022, "mc", "/srv/bedrock")

    ftp = parse_remote_url("ftp://user%40mail:p%40ss@host/~/bedrock")
    assert (ftp.username, ftp.password, ftp.root, ftp.effective_port()) == ("user@mail", "p@ss", "bedrock", 21)

    assert parse_remote_url("ftps://h").root == ""
    assert parse_remote_url("C:/servers/bedrock").protocol == "local"
    with pytest.raises(ValueError):
        parse_remote_url("http://host/")
    with pytest.raises(ValueError):
        parse_remote_url("sftp:///path")


def test_connection_settings_never_expose_secrets():
    settings = ConnectionSettings(protocol="sftp", host="h", username="u", password="secret", key_passphrase="pp", trusted_fingerprint="fp")

    public = settings.public_dict()

    assert "secret" not in json.dumps(public) and "pp" not in json.dumps(public)
    assert "secret" not in repr(settings)
    assert settings.display() == "sftp://u@h:22/"


def test_redact_url_hides_password():
    assert redact_url("ftp://mc:hunter2@host/x") == "ftp://mc:***@host/x"
    assert redact_url("ftp://mc@host/x") == "ftp://mc@host/x"
    assert redact_url("run") == "run"


def test_open_storage_local_and_errors(tmp_path):
    (tmp_path / "srv").mkdir()
    storage = open_storage(ConnectionSettings(protocol="local", root="srv"), base_dir=tmp_path)
    assert isinstance(storage, LocalStorage)
    assert storage.root == (tmp_path / "srv").resolve()

    with pytest.raises(StorageError, match="does not exist"):
        open_storage(ConnectionSettings(protocol="local", root=str(tmp_path / "missing")))
    with pytest.raises(StorageError, match="host is required"):
        open_storage(ConnectionSettings(protocol="ftp"))
    with pytest.raises(StorageError, match="Unsupported"):
        open_storage(ConnectionSettings(protocol="gopher", host="h"))


def test_open_storage_ftp(ftp_server):
    storage = open_storage(ConnectionSettings(protocol="ftp", host=ftp_server["host"], port=ftp_server["port"], username="mc", password="pw"))
    try:
        assert isinstance(storage, FTPStorage)
        assert storage.label.startswith("ftp://mc@127.0.0.1")
    finally:
        storage.close()
