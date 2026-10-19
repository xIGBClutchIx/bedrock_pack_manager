import http.client
import json
import shutil
import sys
import threading
import time
import zipfile

import pytest
from bedrock_pack_manager.paths import build_paths, ensure_runtime_dirs
from bedrock_pack_manager.storage import ConnectionSettings
from bedrock_pack_manager.web import server as web
from bedrock_pack_manager.web.jobs import Job, JobRunner, ThreadRouter
from tests.conftest import FIXTURES
from tests.helpers import PACK_UUID, PACK_VERSION, read_json, write_manifest, write_world_json


class Client:
    def __init__(self, app, port):
        self.app = app
        self.port = port
        self.host = f"127.0.0.1:{port}"

    def request(self, method, path, body=None, *, token=True, host=None, headers=None, raw=False):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        all_headers = {"Host": host or self.host}
        if token:
            all_headers["X-BPM-Token"] = self.app.token
        payload = None
        if isinstance(body, (bytes, bytearray)):
            payload = bytes(body)
        elif body is not None:
            payload = json.dumps(body).encode()
            all_headers["Content-Type"] = "application/json"
        all_headers.update(headers or {})
        conn.request(method, path, body=payload, headers=all_headers)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        if raw:
            return response, data
        return response.status, (json.loads(data) if data and response.getheader("Content-Type", "").startswith("application/json") else data)

    def job(self, path, body):
        status, data = self.request("POST", path, body)
        assert status == 202, data
        deadline = time.time() + 30
        while time.time() < deadline:
            _status, job = self.request("GET", f"/api/jobs/{data['job']}")
            if job["status"] != "running":
                return job
            time.sleep(0.05)
        raise AssertionError("job did not finish")


@pytest.fixture
def client(tmp_path):
    paths = build_paths(tmp_path / "app")
    ensure_runtime_dirs(paths)
    app = web.WebApp(paths)
    server = web.create_server(app, 0)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    try:
        yield Client(app, server.server_address[1])
    finally:
        server.shutdown()
        server.server_close()
        app.disconnect()


def local_server(tmp_path):
    root = tmp_path / "server"
    world = root / "worlds" / "W"
    world.mkdir(parents=True)
    (root / "server.properties").write_text("level-name=W\n")
    return root, world


# ---- security ------------------------------------------------------------------------------------


def test_requests_need_token_and_loopback_host(client):
    assert client.request("GET", "/api/state", token=False)[0] == 403
    assert client.request("GET", "/api/state", host="evil.example:80")[0] == 403
    assert client.request("GET", "/", token=False)[0] == 403
    status, body = client.request("GET", f"/?t={client.app.token}", token=False)
    assert status == 200 and b"Bedrock Pack Manager" in body
    assert client.request("GET", "/static/app.js", token=False)[0] == 200
    assert client.request("GET", "/static/../server.py", token=False)[0] == 404
    assert client.request("GET", "/favicon.ico", token=False)[0] == 204
    assert client.request("GET", "/nope")[0] == 404


def test_static_files_send_security_headers(client):
    response, _data = client.request("GET", "/static/app.css", token=False, raw=True)

    assert "default-src 'self'" in response.getheader("Content-Security-Policy")
    assert response.getheader("X-Content-Type-Options") == "nosniff"


def test_state_before_connecting(client):
    status, state = client.request("GET", "/api/state")

    assert status == 200
    assert state["connected"] is False
    assert state["protocols"] == ["local", "ftp", "ftps", "sftp"]


# ---- connect / status / install -------------------------------------------------------------------


def test_full_local_flow(client, tmp_path):
    root, world_dir = local_server(tmp_path)

    job = client.job("/api/connect", {"settings": {"protocol": "local", "root": str(root)}})
    assert job["status"] == "done", job
    assert job["result"]["default_world"] == "worlds/W"
    assert any("Connected" in line for line in job["lines"]) or job["lines"] == []

    status, state = client.request("GET", "/api/state")
    assert state["connected"] and state["worlds"][0]["name"] == "W"

    addon = (FIXTURES / "installed" / "addon.mcaddon").read_bytes()
    assert client.request("PUT", "/api/uploads?path=addon.mcaddon", addon)[0] == 200
    assert client.request("PUT", "/api/uploads?path=Folder%20Pack/sub/manifest.json", b"{}")[0] == 200
    assert client.request("PUT", "/api/uploads?path=../escape.txt", b"x")[0] == 400
    uploads = client.request("GET", "/api/uploads")[1]["uploads"]
    assert [(u["name"], u["is_dir"]) for u in uploads] == [("addon.mcaddon", False), ("Folder Pack", True)]
    client.request("DELETE", "/api/uploads?name=Folder%20Pack")

    preview = client.job("/api/install", {"world": "worlds/W", "dry_run": True})
    assert [item["action"] for item in preview["result"]["plan"]] == ["upload", "upload"]
    assert not (root / "behavior_packs").exists()

    applied = client.job("/api/install", {"world": "worlds/W", "duplicate_mode": "replace"})
    assert applied["result"]["stats"]["installed"] == 2
    assert (root / "behavior_packs" / "Addon BP-BP" / "manifest.json").exists()
    assert client.request("GET", "/api/uploads")[1]["uploads"] == []

    status_job = client.job("/api/status", {"world": "worlds/W", "refresh_worlds": True})
    rows = status_job["result"]["packs"]
    assert {row["status"] for row in rows} == {"ok"}

    flag = next(row["flag"] for row in rows if row["kind"] == "bp")
    uninstall = client.job("/api/uninstall", {"world": "worlds/W", "flags": [flag]})
    assert uninstall["status"] == "done"
    assert read_json(world_dir / "world_behavior_packs.json") == []

    backup = client.job("/api/backup", {"world": "worlds/W"})
    response, data = client.request("GET", backup["result"]["download"], raw=True)
    assert response.status == 200 and response.getheader("Content-Type") == "application/zip"
    assert zipfile.ZipFile(__import__("io").BytesIO(data)).namelist()
    assert client.request("GET", "/api/download/missing.zip")[0] == 404

    assert client.request("POST", "/api/disconnect", {})[1]["connected"] is False


def test_install_needs_uploads_and_world(client, tmp_path):
    root, _world = local_server(tmp_path)
    client.job("/api/connect", {"settings": {"protocol": "local", "root": str(root)}})

    assert client.job("/api/install", {"world": "worlds/W"})["error_code"] == "no_uploads"
    assert client.job("/api/install", {"world": "worlds/Nope"})["error_code"] == "world_missing"
    client.request("PUT", "/api/uploads?path=x.mcpack", b"x")
    assert "Unknown duplicate mode" in client.job("/api/install", {"world": "worlds/W", "duplicate_mode": "weird"})["error"]


def test_jobs_need_connection(client):
    job = client.job("/api/status", {"world": "worlds/W"})

    assert job["status"] == "error" and job["error_code"] == "not_connected"


def test_connect_failures_are_reported(client, tmp_path):
    missing = client.job("/api/connect", {"settings": {"protocol": "local", "root": str(tmp_path / "nope")}})
    bogus = client.job("/api/connect", {"settings": {"protocol": "gopher"}})

    assert missing["error_code"] == "connect_failed"
    assert "Unknown protocol" in bogus["error"]


def test_connect_over_ftp_and_rebuild_cleanup_doctor(client, ftp_server):
    server = ftp_server["root"]
    world = server / "worlds" / "W"
    world.mkdir(parents=True)
    write_manifest(server / "behavior_packs" / "Keep")
    write_manifest(server / "behavior_packs" / "Stray", uuid="99999999-9999-9999-9999-999999999999")
    write_world_json(world / "world_behavior_packs.json", [{"pack_id": PACK_UUID, "version": PACK_VERSION}])
    settings = {"protocol": "ftp", "host": "127.0.0.1", "port": ftp_server["port"], "username": "mc", "password": "pw"}

    assert client.job("/api/connect", {"settings": settings})["status"] == "done"

    doctor = client.job("/api/doctor", {"world": "worlds/W"})
    assert any("not registered" in warning for warning in doctor["warnings"])

    preview = client.job("/api/cleanup", {"world": "worlds/W", "dry_run": True})
    assert len(preview["result"]["deleted"]) == 1 and (server / "behavior_packs" / "Stray").exists()
    client.job("/api/cleanup", {"world": "worlds/W"})
    assert not (server / "behavior_packs" / "Stray").exists()

    write_manifest(server / "behavior_packs" / "Again", uuid="99999999-9999-9999-9999-999999999999")
    rebuild = client.job("/api/rebuild", {"world": "worlds/W"})
    assert rebuild["result"] == {"behavior_packs": 2, "resource_packs": 0}

    layout = client.job("/api/layout", {"layout": {"worlds_dir": "worlds", "pack_scope": "world"}})
    assert layout["result"]["layout"]["pack_scope"] == "world"


def test_unknown_host_key_is_returned_to_the_ui(client, monkeypatch):
    from bedrock_pack_manager.storage.sftp import UnknownHostKeyError

    def fake_open_storage(settings, **_kwargs):
        raise UnknownHostKeyError(settings.host, 22, "ssh-rsa", "SHA256:xyz")

    monkeypatch.setattr(web, "open_storage", fake_open_storage)

    job = client.job("/api/connect", {"settings": {"protocol": "sftp", "host": "h", "username": "u"}})

    assert job["error_code"] == "unknown_host_key"
    assert job["error_data"]["fingerprint"] == "SHA256:xyz"


def test_connect_can_reuse_command_line_settings(client, tmp_path, monkeypatch):
    root, _world = local_server(tmp_path)
    client.app.initial_settings = ConnectionSettings(protocol="local", root=str(root), password="from-cli")
    seen = []
    real_open = web.open_storage
    monkeypatch.setattr(web, "open_storage", lambda settings, **kwargs: seen.append(settings.password) or real_open(settings, **kwargs))

    job = client.job("/api/connect", {"settings": {"use_initial": True}})

    assert job["status"] == "done"
    assert seen == ["from-cli"]
    state = client.request("GET", "/api/state")[1]
    assert state["has_password"] is True
    assert "from-cli" not in json.dumps(state)


def test_world_edits(client, tmp_path):
    import io
    import struct

    import nbtlib

    root, world = local_server(tmp_path)
    buf = io.BytesIO()
    nbtlib.File(nbtlib.Compound({"GameType": nbtlib.Int(0)})).write(buf, byteorder="little")
    (world / "level.dat").write_bytes(struct.pack("<II", 10, len(buf.getvalue())) + buf.getvalue())
    client.job("/api/connect", {"settings": {"protocol": "local", "root": str(root)}})

    assert client.job("/api/edit", {"world": "worlds/W"})["error_code"] == "nothing_selected"
    assert "Unknown gamemode" in client.job("/api/edit", {"world": "worlds/W", "gamemode": "spectator"})["error"]
    job = client.job("/api/edit", {"world": "worlds/W", "beta": True, "gamemode": "creative"})

    assert job["result"] == {"beta": {"changed": True}, "gamemode": {"changed": True}}
    status = client.job("/api/status", {"world": "worlds/W"})["result"]
    assert status["level"]["beta"] is True and status["level"]["gamemode"] == "creative"


def test_uninstall_requires_selection(client, tmp_path):
    root, _world = local_server(tmp_path)
    client.job("/api/connect", {"settings": {"protocol": "local", "root": str(root)}})

    assert client.job("/api/uninstall", {"world": "worlds/W", "flags": []})["error_code"] == "nothing_selected"
    assert "Unknown uninstall selection" in client.job("/api/uninstall", {"world": "worlds/W", "flags": ["--uninstall-pack=bp:x:1"]})["error"]


def test_profiles_never_store_passwords(client):
    status, data = client.request("POST", "/api/profiles", {"name": "Host", "settings": {"protocol": "sftp", "host": "h", "password": "secret"}, "layout": {"worlds_dir": "w"}})

    assert status == 200
    assert data["profiles"][0]["settings"]["host"] == "h"
    assert "secret" not in client.app.paths.profiles_file.read_text()
    assert client.request("POST", "/api/profiles", {"name": ""})[0] == 400
    assert client.request("DELETE", "/api/profiles?name=Host")[1]["profiles"] == []


def test_bad_requests(client):
    assert client.request("POST", "/api/connect", b"not json", headers={"Content-Type": "application/json"})[0] == 400
    assert client.request("POST", "/api/nope", {})[0] == 404
    assert client.request("PUT", "/api/nope", b"x")[0] == 404
    assert client.request("DELETE", "/api/nope")[0] == 404
    assert client.request("DELETE", "/api/uploads?name=a/b")[0] == 400
    assert client.request("GET", "/api/jobs/unknown")[0] == 404


def test_busy_runner_rejects_second_job(client):
    release = threading.Event()
    client.app.runner.start("slow", lambda _job: release.wait(5))
    try:
        status, data = client.request("POST", "/api/status", {"world": "x"})
        assert status == 409 and data["error_code"] == "busy"
        assert client.request("POST", "/api/disconnect", {})[0] == 409
    finally:
        release.set()


# ---- job runner ----------------------------------------------------------------------------------


def test_job_runner_captures_output_per_thread(monkeypatch):
    runner = JobRunner(keep=2)
    monkeypatch.setattr(sys, "stdout", sys.stdout)
    runner.install_router()
    assert isinstance(sys.stdout, ThreadRouter)

    job = runner.start("echo", lambda _job: print("\x1b[92mhello\x1b[0m\npartial", end="") or 42, background=False)

    assert job.status == "done" and job.result == 42
    assert job.as_dict()["lines"] == ["hello", "partial"]
    assert job.as_dict(since=1)["lines"] == ["partial"]

    failed = runner.start("boom", lambda _job: 1 / 0, background=False)
    assert failed.status == "error" and failed.error_code == "ZeroDivisionError"
    runner.start("third", lambda _job: None, background=False)
    assert runner.get(job.id) is None


def test_job_write_handles_partial_lines():
    job = Job(kind="x")
    job.write("a")
    job.write("b\nc")
    job.write("")

    assert job.lines == ["ab"]
    job.flush_partial()
    assert job.lines == ["ab", "c"]


def test_safe_relative():
    assert str(web._safe_relative("a/b.txt")).replace("\\", "/") == "a/b.txt"
    assert web._safe_relative("../x") is None
    assert web._safe_relative("C:/x") is None
    assert web._safe_relative("") is None


def test_run_server_prints_link_and_stops(tmp_path, monkeypatch, capsys):
    paths = build_paths(tmp_path)
    ensure_runtime_dirs(paths)
    opened = []
    monkeypatch.setattr(web.webbrowser, "open", opened.append)
    monkeypatch.setattr(sys, "stdout", sys.stdout)

    def fake_serve_forever(self, poll_interval=0.5):
        raise KeyboardInterrupt

    monkeypatch.setattr(web.ThreadingHTTPServer, "serve_forever", fake_serve_forever)

    web.run_server(paths, open_browser=False)

    output = capsys.readouterr().out
    assert "Web UI running at:" in output and "?t=" in output
    assert opened == []


def test_clear_uploads(client):
    client.request("PUT", "/api/uploads?path=a.zip", b"x")
    client.request("PUT", "/api/uploads?path=dir/b.zip", b"x")

    assert client.request("DELETE", "/api/uploads?name=a.zip")[1]["uploads"][0]["name"] == "dir"
    assert client.request("DELETE", "/api/uploads")[1]["uploads"] == []
    shutil.rmtree(client.app.uploads_dir)
    client.app.uploads_dir.mkdir()
