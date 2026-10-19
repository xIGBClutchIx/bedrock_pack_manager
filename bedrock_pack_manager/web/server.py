"""Local web UI: a small stdlib HTTP server bound to 127.0.0.1.

Every API call needs the per-launch token printed in the terminal, and the Host header must
be the loopback address, so other websites in the browser cannot drive the tool.
"""

import json
import mimetypes
import secrets
import shutil
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from ..commands import (
    do_beta,
    do_cleanup_pack_folders,
    do_doctor,
    do_rebuild,
    do_set_gamemode,
    do_uninstall,
    do_zip,
    world_status,
)
from ..console import C
from ..install import DUPLICATE_MODES, do_install
from ..layout import LayoutOverrides, Target, connect_target
from ..nbt import GAMEMODE_VALUES
from ..paths import ProjectPaths
from ..storage import ConnectionSettings, LocalStorage, StorageError, basename, open_storage
from ..storage.connect import PROTOCOLS
from ..storage.sftp import HostKeyMismatchError, UnknownHostKeyError
from ..worlds import all_world_details
from .jobs import Busy, Job, JobFailure, JobRunner

STATIC_DIR = Path(__file__).resolve().parent / "static"
MAX_JSON_BODY = 1024 * 1024
CHUNK = 1024 * 256


def _safe_relative(path: str) -> Path | None:
    """Turn a browser-supplied relative path into a safe relative Path, or None."""

    parts = [part for part in path.replace("\\", "/").split("/") if part not in ("", ".")]
    if not parts or any(part == ".." or ":" in part for part in parts):
        return None
    return Path(*parts)


class WebApp:
    def __init__(self, paths: ProjectPaths, *, initial_settings: ConnectionSettings | None = None, overrides: LayoutOverrides | None = None) -> None:
        self.paths = paths
        self.token = secrets.token_urlsafe(24)
        self.runner = JobRunner()
        self.target: Target | None = None
        self.settings: ConnectionSettings | None = None
        self.initial_settings = initial_settings
        self.overrides = overrides or LayoutOverrides()
        self.worlds: list[dict] = []
        self.default_world: str | None = None
        self.uploads_dir = paths.staging_dir / "uploads"
        self.uploads_dir.mkdir(parents=True, exist_ok=True)
        self.state_lock = threading.Lock()
        self.allowed_hosts: set[str] = set()

    # ---- profiles ------------------------------------------------------------------------------

    def load_profiles(self) -> list[dict]:
        try:
            data = json.loads(self.paths.profiles_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        return [profile for profile in data if isinstance(profile, dict) and profile.get("name")] if isinstance(data, list) else []

    def save_profile(self, name: str, settings: dict, layout: dict | None) -> list[dict]:
        public = ConnectionSettings(**_settings_kwargs(settings)).public_dict()
        profiles = [profile for profile in self.load_profiles() if profile["name"] != name]
        profiles.append({"name": name, "settings": public, "layout": LayoutOverrides.from_dict(layout).__dict__})
        profiles.sort(key=lambda profile: profile["name"].lower())
        self.paths.profiles_file.write_text(json.dumps(profiles, indent=2) + "\n", encoding="utf-8")
        return profiles

    def delete_profile(self, name: str) -> list[dict]:
        profiles = [profile for profile in self.load_profiles() if profile["name"] != name]
        self.paths.profiles_file.write_text(json.dumps(profiles, indent=2) + "\n", encoding="utf-8")
        return profiles

    # ---- uploads -----------------------------------------------------------------------------------

    def upload_entries(self) -> list[dict]:
        entries = []
        for child in sorted(self.uploads_dir.iterdir(), key=lambda item: item.name.lower()):
            if child.is_dir():
                files = [path for path in child.rglob("*") if path.is_file()]
                entries.append({"name": child.name, "is_dir": True, "files": len(files), "size": sum(path.stat().st_size for path in files)})
            else:
                entries.append({"name": child.name, "is_dir": False, "files": 1, "size": child.stat().st_size})
        return entries

    def clear_uploads(self, name: str | None = None) -> None:
        if name:
            relative = _safe_relative(name)
            if relative is None or len(relative.parts) != 1:
                raise ValueError("Bad upload name")
            target = self.uploads_dir / relative
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
            elif target.exists():
                target.unlink()
            return
        shutil.rmtree(self.uploads_dir, ignore_errors=True)
        self.uploads_dir.mkdir(parents=True, exist_ok=True)

    # ---- state -------------------------------------------------------------------------------------

    def snapshot(self) -> dict:
        active = self.runner.active
        return {
            "connected": self.target is not None,
            "label": self.target.label if self.target else None,
            "settings": self.settings.public_dict() if self.settings else (self.initial_settings.public_dict() if self.initial_settings else None),
            "has_password": bool(self.initial_settings and self.initial_settings.password),
            "layout": self.target.layout_display() if self.target else None,
            "overrides": self.overrides.__dict__,
            "worlds": self.worlds,
            "default_world": self.default_world,
            "active_job": active.as_dict(len(active.lines)) if active and active.status == "running" else None,
            "uploads": self.upload_entries(),
            "profiles": self.load_profiles(),
            "protocols": list(PROTOCOLS),
            "duplicate_modes": list(DUPLICATE_MODES),
            "gamemodes": list(GAMEMODE_VALUES),
        }

    def _require_target(self) -> Target:
        if self.target is None:
            raise JobFailure("Not connected to a server", code="not_connected")
        return self.target

    def _require_world(self, payload: dict) -> str:
        target = self._require_target()
        world = str(payload.get("world") or "")
        if world not in target.list_worlds() and not target.storage.is_dir(world):
            raise JobFailure(f"World '{world}' was not found", code="world_missing")
        return world

    def _refresh_worlds(self) -> None:
        target = self._require_target()
        worlds = target.list_worlds()
        details = all_world_details(target, worlds)
        self.worlds = [{"path": world, "name": basename(world), "details": _strip(details[world])} for world in worlds]
        self.default_world = target.default_world()

    # ---- job bodies ----------------------------------------------------------------------------

    def job_connect(self, job: Job, payload: dict) -> dict:
        raw = payload.get("settings") or {}
        if raw.get("use_initial") and self.initial_settings is not None:
            settings = self.initial_settings
            if raw.get("trusted_fingerprint"):
                settings.trusted_fingerprint = raw["trusted_fingerprint"]
        else:
            settings = ConnectionSettings(**_settings_kwargs(raw))
        if settings.protocol not in PROTOCOLS:
            raise JobFailure(f"Unknown protocol {settings.protocol}")
        self.overrides = LayoutOverrides.from_dict(payload.get("layout"))

        self.disconnect()
        print(f"Connecting to {settings.display()} ...")
        try:
            if settings.protocol == "local" and not settings.root:
                storage = LocalStorage(self.paths.run_dir)
            else:
                storage = open_storage(settings, base_dir=self.paths.base_dir, known_hosts_file=self.paths.known_hosts_file)
        except UnknownHostKeyError as exc:
            raise JobFailure(str(exc), code="unknown_host_key", data={"host": exc.host, "port": exc.port, "key_type": exc.key_type, "fingerprint": exc.fingerprint}) from exc
        except HostKeyMismatchError as exc:
            raise JobFailure(str(exc), code="host_key_mismatch") from exc
        except StorageError as exc:
            raise JobFailure(str(exc), code="connect_failed") from exc

        try:
            target = connect_target(storage, self.overrides)
        except Exception:
            storage.close()
            raise
        with self.state_lock:
            self.settings = settings
            self.target = target
        print(f"Connected: {target.label}")
        print(f"Server folder: {target.describe(target.layout.server_root)}")
        for note in target.layout.notes:
            print(f"  {note}")
        self._refresh_worlds()
        print(f"Found {len(self.worlds)} world(s)")
        return {"label": target.label, "layout": target.layout_display(), "worlds": self.worlds, "default_world": self.default_world}

    def job_layout(self, job: Job, payload: dict) -> dict:
        target = self._require_target()
        self.overrides = LayoutOverrides.from_dict(payload.get("layout"))
        target.storage.clear_cache()
        new_target = connect_target(target.storage, self.overrides)
        with self.state_lock:
            self.target = new_target
        self._refresh_worlds()
        print(f"Layout updated. Found {len(self.worlds)} world(s)")
        return {"layout": new_target.layout_display(), "worlds": self.worlds, "default_world": self.default_world}

    def job_status(self, job: Job, payload: dict) -> dict:
        target = self._require_target()
        target.storage.clear_cache()
        if payload.get("refresh_worlds"):
            self._refresh_worlds()
        world = self._require_world(payload)
        print(f"Reading {basename(world)} ...")
        status = world_status(target, world)
        print(f"{len(status['packs'])} pack(s), {len(status['problems'])} problem(s)")
        return status

    def job_install(self, job: Job, payload: dict) -> dict:
        target = self._require_target()
        world = self._require_world(payload)
        sources = [child for child in sorted(self.uploads_dir.iterdir(), key=lambda item: item.name.lower())]
        if not sources:
            raise JobFailure("Add some packs first", code="no_uploads")
        duplicate_mode = payload.get("duplicate_mode") or "replace"
        if duplicate_mode not in DUPLICATE_MODES:
            raise JobFailure(f"Unknown duplicate mode {duplicate_mode}")
        dry_run = bool(payload.get("dry_run"))
        target.storage.clear_cache()
        result = do_install(
            target,
            world,
            self.paths,
            job.state,
            duplicate_mode=duplicate_mode,
            reupload=bool(payload.get("reupload")),
            dry_run=dry_run,
            sources=sources,
        )
        if result.get("applied"):
            self._refresh_worlds()
            if result["stats"]["errors"] == 0:
                self.clear_uploads()
        return result

    def job_uninstall(self, job: Job, payload: dict) -> dict:
        target = self._require_target()
        world = self._require_world(payload)
        flags = {str(flag) for flag in payload.get("flags") or [] if str(flag).startswith("--uninstall-pack=")}
        if not flags:
            raise JobFailure("Select at least one pack to uninstall", code="nothing_selected")
        target.storage.clear_cache()
        try:
            result = do_uninstall(target, world, self.paths, flags, job.state, keep_files=bool(payload.get("keep_files")))
        except ValueError as exc:
            raise JobFailure(str(exc)) from exc
        self._refresh_worlds()
        return result

    def job_rebuild(self, job: Job, payload: dict) -> dict:
        target = self._require_target()
        world = self._require_world(payload)
        target.storage.clear_cache()
        result = do_rebuild(target, world, job.state)
        self._refresh_worlds()
        return result

    def job_cleanup(self, job: Job, payload: dict) -> dict:
        target = self._require_target()
        world = self._require_world(payload)
        target.storage.clear_cache()
        return do_cleanup_pack_folders(target, world, job.state, dry_run=bool(payload.get("dry_run")))

    def job_doctor(self, job: Job, payload: dict) -> dict:
        target = self._require_target()
        world = self._require_world(payload)
        target.storage.clear_cache()
        return do_doctor(target, world, job.state)

    def job_edit(self, job: Job, payload: dict) -> dict:
        target = self._require_target()
        world = self._require_world(payload)
        result = {}
        if payload.get("beta"):
            result["beta"] = do_beta(target, world, job.state)
        gamemode = payload.get("gamemode")
        if gamemode:
            if gamemode not in GAMEMODE_VALUES:
                raise JobFailure(f"Unknown gamemode {gamemode}")
            result["gamemode"] = do_set_gamemode(target, world, gamemode, job.state)
        if not result:
            raise JobFailure("Choose at least one change", code="nothing_selected")
        return result

    def job_backup(self, job: Job, payload: dict) -> dict:
        target = self._require_target()
        world = payload.get("world") or None
        if world is not None:
            world = self._require_world(payload)
        name = f"Backup_{basename(world)}" if world else None
        result = do_zip(target, self.paths, job.state, zip_name=f"{name}_{job.id}.zip" if name else None, output_dir=self.paths.backups_dir, world=world)
        result["download"] = f"/api/download/{result['zip_name']}"
        return result

    def disconnect(self) -> None:
        with self.state_lock:
            if self.target is not None:
                self.target.storage.close()
            self.target = None
            self.settings = None
            self.worlds = []
            self.default_world = None


def _strip(text: str) -> str:
    from ..logger import _strip_ansi

    return _strip_ansi(text).strip().strip("()")


def _settings_kwargs(raw: dict) -> dict:
    port = raw.get("port")
    try:
        port_value = int(port) if port not in (None, "") else None
    except (TypeError, ValueError):
        port_value = None
    return {
        "protocol": str(raw.get("protocol") or "local").lower(),
        "host": str(raw.get("host") or "").strip(),
        "port": port_value,
        "username": str(raw.get("username") or "").strip(),
        "root": str(raw.get("root") or "").strip(),
        "password": str(raw.get("password") or ""),
        "key_file": str(raw.get("key_file") or "").strip(),
        "key_passphrase": str(raw.get("key_passphrase") or ""),
        "tls_verify": bool(raw.get("tls_verify", True)),
        "passive": bool(raw.get("passive", True)),
        "trusted_fingerprint": str(raw.get("trusted_fingerprint") or "").strip(),
    }


JOB_ROUTES = {
    "/api/connect": ("connect", WebApp.job_connect),
    "/api/layout": ("layout", WebApp.job_layout),
    "/api/status": ("status", WebApp.job_status),
    "/api/install": ("install", WebApp.job_install),
    "/api/uninstall": ("uninstall", WebApp.job_uninstall),
    "/api/rebuild": ("rebuild", WebApp.job_rebuild),
    "/api/cleanup": ("cleanup", WebApp.job_cleanup),
    "/api/doctor": ("doctor", WebApp.job_doctor),
    "/api/edit": ("edit", WebApp.job_edit),
    "/api/backup": ("backup", WebApp.job_backup),
}


def make_handler(app: WebApp):
    class Handler(BaseHTTPRequestHandler):
        server_version = "BedrockPackManager"
        protocol_version = "HTTP/1.1"

        def log_message(self, format, *args):  # noqa: A002 - stdlib signature
            return

        # ---- helpers -----------------------------------------------------------------------

        def _send(self, status: int, body: bytes, content_type: str, extra: dict | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, status: int, data) -> None:
            self._send(status, json.dumps(data).encode("utf-8"), "application/json; charset=utf-8")

        def _error(self, status: int, message: str, code: str = "error") -> None:
            self._json(status, {"error": message, "error_code": code})

        def _host_ok(self) -> bool:
            host = (self.headers.get("Host") or "").lower()
            return host in app.allowed_hosts

        def _token_ok(self, query: dict) -> bool:
            supplied = self.headers.get("X-BPM-Token") or (query.get("t") or [""])[0]
            return secrets.compare_digest(supplied, app.token)

        def _read_json(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_JSON_BODY:
                raise ValueError("Request too large")
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(data, dict):
                raise ValueError("Expected a JSON object")
            return data

        def _guard(self, query: dict, *, need_token: bool = True) -> bool:
            if not self._host_ok():
                self._error(HTTPStatus.FORBIDDEN, "Bad Host header", "bad_host")
                return False
            if need_token and not self._token_ok(query):
                self._error(HTTPStatus.FORBIDDEN, "Missing or wrong token. Open the link printed in the terminal.", "bad_token")
                return False
            return True

        # ---- verbs -------------------------------------------------------------------------

        def do_GET(self) -> None:  # noqa: N802 - stdlib name
            parts = urlsplit(self.path)
            query = parse_qs(parts.query)
            path = parts.path

            if path in ("/", "/index.html"):
                if not self._guard(query):
                    return
                self._static("index.html")
                return
            if path.startswith("/static/"):
                if not self._guard(query, need_token=False):
                    return
                self._static(path[len("/static/") :])
                return
            if path == "/favicon.ico":
                self._send(HTTPStatus.NO_CONTENT, b"", "image/x-icon")
                return
            if not path.startswith("/api/") or not self._guard(query):
                if path.startswith("/api/"):
                    return
                self._error(HTTPStatus.NOT_FOUND, "Not found")
                return

            if path == "/api/state":
                self._json(HTTPStatus.OK, app.snapshot())
            elif path.startswith("/api/jobs/"):
                job = app.runner.get(path.rsplit("/", 1)[-1])
                if job is None:
                    self._error(HTTPStatus.NOT_FOUND, "Unknown job")
                    return
                since = int((query.get("since") or ["0"])[0] or 0)
                self._json(HTTPStatus.OK, job.as_dict(since))
            elif path == "/api/uploads":
                self._json(HTTPStatus.OK, {"uploads": app.upload_entries()})
            elif path.startswith("/api/download/"):
                self._download(path.rsplit("/", 1)[-1])
            else:
                self._error(HTTPStatus.NOT_FOUND, "Not found")

        def do_POST(self) -> None:  # noqa: N802
            parts = urlsplit(self.path)
            query = parse_qs(parts.query)
            if not self._guard(query):
                return
            try:
                payload = self._read_json()
            except (ValueError, UnicodeDecodeError) as exc:
                self._error(HTTPStatus.BAD_REQUEST, str(exc))
                return

            path = parts.path
            if path in JOB_ROUTES:
                kind, method = JOB_ROUTES[path]
                try:
                    job = app.runner.start(kind, lambda job: method(app, job, payload))
                except Busy as exc:
                    self._error(HTTPStatus.CONFLICT, str(exc), "busy")
                    return
                self._json(HTTPStatus.ACCEPTED, {"job": job.id})
            elif path == "/api/disconnect":
                if app.runner.active and app.runner.active.status == "running":
                    self._error(HTTPStatus.CONFLICT, "A task is still running", "busy")
                    return
                app.disconnect()
                self._json(HTTPStatus.OK, app.snapshot())
            elif path == "/api/profiles":
                name = str(payload.get("name") or "").strip()
                if not name:
                    self._error(HTTPStatus.BAD_REQUEST, "Profile name required")
                    return
                self._json(HTTPStatus.OK, {"profiles": app.save_profile(name, payload.get("settings") or {}, payload.get("layout"))})
            else:
                self._error(HTTPStatus.NOT_FOUND, "Not found")

        def do_PUT(self) -> None:  # noqa: N802
            parts = urlsplit(self.path)
            query = parse_qs(parts.query)
            if not self._guard(query):
                return
            if parts.path != "/api/uploads":
                self._error(HTTPStatus.NOT_FOUND, "Not found")
                return
            active = app.runner.active
            if active and active.status == "running" and active.kind == "install":
                self._error(HTTPStatus.CONFLICT, "Install is running", "busy")
                return
            relative = _safe_relative((query.get("path") or [""])[0])
            if relative is None:
                self._error(HTTPStatus.BAD_REQUEST, "Bad upload path")
                return
            length = int(self.headers.get("Content-Length") or 0)
            destination = app.uploads_dir / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            remaining = length
            with open(destination, "wb") as handle:
                while remaining > 0:
                    chunk = self.rfile.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    handle.write(chunk)
                    remaining -= len(chunk)
            if remaining:
                destination.unlink(missing_ok=True)
                self._error(HTTPStatus.BAD_REQUEST, "Upload was cut short")
                return
            self._json(HTTPStatus.OK, {"ok": True})

        def do_DELETE(self) -> None:  # noqa: N802
            parts = urlsplit(self.path)
            query = parse_qs(parts.query)
            if not self._guard(query):
                return
            if parts.path == "/api/uploads":
                if app.runner.active and app.runner.active.status == "running" and app.runner.active.kind == "install":
                    self._error(HTTPStatus.CONFLICT, "Install is running", "busy")
                    return
                try:
                    app.clear_uploads((query.get("name") or [None])[0])
                except ValueError as exc:
                    self._error(HTTPStatus.BAD_REQUEST, str(exc))
                    return
                self._json(HTTPStatus.OK, {"uploads": app.upload_entries()})
            elif parts.path == "/api/profiles":
                self._json(HTTPStatus.OK, {"profiles": app.delete_profile((query.get("name") or [""])[0])})
            else:
                self._error(HTTPStatus.NOT_FOUND, "Not found")

        # ---- files -------------------------------------------------------------------------

        def _static(self, name: str) -> None:
            relative = _safe_relative(name)
            file_path = STATIC_DIR / relative if relative else None
            if file_path is None or not file_path.is_file():
                self._error(HTTPStatus.NOT_FOUND, "Not found")
                return
            content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type in ("application/javascript",):
                content_type += "; charset=utf-8"
            extra = {"Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"}
            self._send(HTTPStatus.OK, file_path.read_bytes(), content_type, extra)

        def _download(self, name: str) -> None:
            relative = _safe_relative(name)
            file_path = app.paths.backups_dir / relative if relative and len(relative.parts) == 1 else None
            if file_path is None or not file_path.is_file():
                self._error(HTTPStatus.NOT_FOUND, "Not found")
                return
            size = file_path.stat().st_size
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", f'attachment; filename="{file_path.name}"')
            self.end_headers()
            with open(file_path, "rb") as handle:
                shutil.copyfileobj(handle, self.wfile, CHUNK)

    return Handler


def create_server(app: WebApp, port: int = 0) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app))
    server.daemon_threads = True
    actual_port = server.server_address[1]
    app.allowed_hosts = {f"127.0.0.1:{actual_port}", f"localhost:{actual_port}"}
    return server


def run_server(
    paths: ProjectPaths,
    *,
    port: int = 0,
    open_browser: bool = True,
    initial_settings: ConnectionSettings | None = None,
    overrides: LayoutOverrides | None = None,
) -> None:
    app = WebApp(paths, initial_settings=initial_settings, overrides=overrides)
    app.runner.install_router()
    server = create_server(app, port)
    url = f"http://127.0.0.1:{server.server_address[1]}/?t={app.token}"
    print(f"\n  Web UI running at: {C.CYAN}{url}{C.RESET}")
    print(f"  {C.DIM}Only this computer can reach it. Keep this window open; press Ctrl+C to stop.{C.RESET}\n", flush=True)
    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\n  Stopping web UI ...")
    finally:
        server.server_close()
        app.disconnect()
