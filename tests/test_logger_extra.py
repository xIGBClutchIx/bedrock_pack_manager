import io

from bedrock_pack_installer.logger import TeeStream


class FakePrimary(io.StringIO):
    def isatty(self):
        return True


def test_teestream_isatty_tracks_primary():
    primary = FakePrimary()
    mirror = io.StringIO()
    stream = TeeStream(primary, mirror)

    assert stream.isatty() is True
    stream.write("hello")
    stream.flush()
    assert primary.getvalue() == "hello"
    assert mirror.getvalue() == "hello"
