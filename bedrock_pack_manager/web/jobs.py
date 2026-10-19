"""Background jobs for the web UI, with per-job console capture."""

import sys
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from ..console import AppState
from ..logger import _strip_ansi


class Busy(Exception):
    pass


class JobFailure(Exception):
    """An expected failure with a machine-readable code for the UI."""

    def __init__(self, message: str, code: str = "error", data: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.data = data or {}


@dataclass
class Job:
    kind: str
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    status: str = "running"
    lines: list[str] = field(default_factory=list)
    result: Any = None
    error: str | None = None
    error_code: str | None = None
    error_data: dict = field(default_factory=dict)
    state: AppState = field(default_factory=AppState)
    started: float = field(default_factory=time.time)
    finished: float | None = None
    _partial: str = ""

    def write(self, text: str) -> None:
        text = _strip_ansi(text)
        if not text:
            return
        combined = self._partial + text
        parts = combined.split("\n")
        self._partial = parts.pop()
        self.lines.extend(parts)

    def flush_partial(self) -> None:
        if self._partial:
            self.lines.append(self._partial)
            self._partial = ""

    def as_dict(self, since: int = 0) -> dict:
        lines = self.lines[since:]
        if self.status != "running" and self._partial:
            lines = lines + [self._partial]
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "lines": lines,
            "next": len(self.lines),
            "result": self.result if self.status != "running" else None,
            "error": self.error,
            "error_code": self.error_code,
            "error_data": self.error_data,
            "warnings": list(self.state.warnings),
            "elapsed": round((self.finished or time.time()) - self.started, 1),
        }


class ThreadRouter:
    """Replacement for sys.stdout that sends writes from job threads to that job."""

    def __init__(self, primary) -> None:
        self.primary = primary
        self.local = threading.local()
        self.encoding = getattr(primary, "encoding", "utf-8")

    def write(self, data: str) -> int:
        job = getattr(self.local, "job", None)
        if job is not None:
            job.write(data)
        try:
            self.primary.write(data)
        except Exception:
            pass
        return len(data)

    def flush(self) -> None:
        try:
            self.primary.flush()
        except Exception:
            pass

    def isatty(self) -> bool:
        return False


class JobRunner:
    """Runs one job at a time: every job talks to the same server connection."""

    def __init__(self, keep: int = 30) -> None:
        self.jobs: dict[str, Job] = {}
        self.order: list[str] = []
        self.keep = keep
        self.lock = threading.Lock()
        self.active: Job | None = None
        self.router: ThreadRouter | None = None

    def install_router(self) -> None:
        if not isinstance(sys.stdout, ThreadRouter):
            self.router = ThreadRouter(sys.stdout)
            sys.stdout = self.router
        else:
            self.router = sys.stdout

    def start(self, kind: str, func: Callable[[Job], Any], *, background: bool = True) -> Job:
        with self.lock:
            if self.active is not None and self.active.status == "running":
                raise Busy(f"Another task ({self.active.kind}) is still running")
            job = Job(kind=kind)
            self.active = job
            self.jobs[job.id] = job
            self.order.append(job.id)
            while len(self.order) > self.keep:
                self.jobs.pop(self.order.pop(0), None)

        def _run() -> None:
            if self.router is not None:
                self.router.local.job = job
            try:
                job.result = func(job)
                job.status = "done"
            except JobFailure as exc:
                job.status = "error"
                job.error = str(exc)
                job.error_code = exc.code
                job.error_data = exc.data
            except Exception as exc:  # surfaced to the UI rather than crashing the server
                job.status = "error"
                job.error = str(exc) or exc.__class__.__name__
                job.error_code = exc.__class__.__name__
                job.write(traceback.format_exc())
            finally:
                job.flush_partial()
                job.finished = time.time()
                if self.router is not None:
                    self.router.local.job = None

        if background:
            threading.Thread(target=_run, name=f"job-{job.id}", daemon=True).start()
        else:
            _run()
        return job

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)
