import logging
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.fake_sftp import make_sftp_storage  # noqa: E402


@pytest.fixture
def ftp_server(tmp_path):
    """A real FTP server on localhost serving ``tmp_path / 'ftp'`` (user ``mc`` / ``pw``)."""

    pytest.importorskip("pyftpdlib")
    from pyftpdlib.authorizers import DummyAuthorizer
    from pyftpdlib.handlers import FTPHandler
    from pyftpdlib.servers import FTPServer

    logging.getLogger("pyftpdlib").setLevel(logging.WARNING)
    root = tmp_path / "ftp"
    root.mkdir()
    authorizer = DummyAuthorizer()
    authorizer.add_user("mc", "pw", str(root), perm="elradfmwMT")
    handler = type("Handler", (FTPHandler,), {"authorizer": authorizer, "banner": "test"})
    server = FTPServer(("127.0.0.1", 0), handler)
    port = server.socket.getsockname()[1]
    thread = threading.Thread(target=server.serve_forever, kwargs={"timeout": 0.05, "blocking": True}, daemon=True)
    thread.start()
    try:
        yield {"host": "127.0.0.1", "port": port, "root": root, "username": "mc", "password": "pw"}
    finally:
        server.close_all()
        thread.join(timeout=2)


@pytest.fixture
def ftp_storage(ftp_server):
    from bedrock_pack_manager.storage.ftp import FTPStorage

    storage = FTPStorage(ftp_server["host"], port=ftp_server["port"], username="mc", password="pw", root="/")
    try:
        yield storage
    finally:
        storage.close()


@pytest.fixture
def sftp_storage(tmp_path):
    root = tmp_path / "sftp"
    root.mkdir()
    storage = make_sftp_storage(root)
    try:
        yield storage
    finally:
        storage.close()


@pytest.fixture(params=["local", "ftp", "sftp"])
def any_storage(request, tmp_path):
    """The same storage contract exercised against every backend.

    Yields ``(storage, real_root)`` where ``real_root`` is the local folder backing it.
    """

    if request.param == "local":
        from bedrock_pack_manager.storage import LocalStorage

        root = tmp_path / "local"
        root.mkdir()
        yield LocalStorage(root), root
    elif request.param == "ftp":
        server = request.getfixturevalue("ftp_server")
        yield request.getfixturevalue("ftp_storage"), server["root"]
    else:
        yield request.getfixturevalue("sftp_storage"), tmp_path / "sftp"
