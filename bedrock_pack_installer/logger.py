import io
import re
import sys
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path


ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*m")


class TeeStream:
    def __init__(self, primary, mirror) -> None:
        self.primary = primary
        self.mirror = mirror
        self.encoding = getattr(primary, "encoding", "utf-8")

    def write(self, data: str) -> int:
        self.primary.write(data)
        self.mirror.write(data)
        return len(data)

    def flush(self) -> None:
        self.primary.flush()
        self.mirror.flush()

    def isatty(self) -> bool:
        return bool(getattr(self.primary, "isatty", lambda: False)())


def _strip_ansi(text: str) -> str:
    return ANSI_ESCAPE_RE.sub("", text)


def _prune_old_logs(logs_dir: Path, keep: int) -> None:
    timestamped_logs = sorted(
        logs_dir.glob("*.txt"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    timestamped_logs = [path for path in timestamped_logs if path.name != "latest.txt"]
    for old_log in timestamped_logs[keep:]:
        old_log.unlink(missing_ok=True)


@contextmanager
def capture_run_logs(logs_dir: Path):
    logs_dir.mkdir(parents=True, exist_ok=True)

    buffer = io.StringIO()
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    sys.stdout = TeeStream(original_stdout, buffer)
    sys.stderr = TeeStream(original_stderr, buffer)

    try:
        yield
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        sys.stdout = original_stdout
        sys.stderr = original_stderr

        log_text = _strip_ansi(buffer.getvalue())
        latest_path = logs_dir / "latest.txt"
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        dated_path = logs_dir / f"{timestamp}.txt"

        latest_path.write_text(log_text, encoding="utf-8")
        dated_path.write_text(log_text, encoding="utf-8")
        _prune_old_logs(logs_dir, keep=5)
