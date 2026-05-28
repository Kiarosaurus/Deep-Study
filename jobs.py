"""In-memory job registry for long-running extraction work.

The upload endpoint creates a `Job`, returns its id immediately, and runs
extraction in a background asyncio task (the CPU-heavy parts execute in a
thread-pool executor). Progress events are pushed to an asyncio.Queue
attached to the job; the SSE endpoint reads from that queue and forwards
each event to the client.

This is a process-local registry. It is sufficient for the current
single-instance backend; if we later run multiple workers behind a reverse
proxy, this will need to move to a shared store (Redis, etc.).
"""

from __future__ import annotations

import asyncio
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class Job:
    id: str
    filename: str
    status: str  # 'queued' | 'running' | 'done' | 'failed'
    created_at: float
    loop: asyncio.AbstractEventLoop
    events: asyncio.Queue
    result: Optional[dict] = None
    error: Optional[str] = None
    finished_at: Optional[float] = None
    last_event: Optional[dict] = field(default=None)

    def push_event(self, event: dict) -> None:
        """Thread-safe event submission. Callable from any thread — uses the
        loop's call_soon_threadsafe to enqueue, so the SSE consumer wakes up
        without blocking the worker."""
        self.last_event = event
        try:
            self.loop.call_soon_threadsafe(self.events.put_nowait, event)
        except RuntimeError:
            # Loop already closed (server shutting down). Drop silently.
            pass


class JobRegistry:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def create(self, filename: str, loop: asyncio.AbstractEventLoop) -> Job:
        job = Job(
            id=uuid.uuid4().hex,
            filename=filename,
            status="queued",
            created_at=time.time(),
            loop=loop,
            events=asyncio.Queue(),
        )
        with self._lock:
            self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def mark_done(self, job_id: str, result: dict) -> None:
        job = self.get(job_id)
        if job is None:
            return
        job.status = "done"
        job.result = result
        job.finished_at = time.time()
        # The result can be multi-MB; we keep it on the job (clients refetch
        # via /documents/{filename}/analysis if needed) but the SSE 'done'
        # event only carries a pointer so the stream stays small.
        job.push_event({
            "phase": "done",
            "message": "Análisis completado",
            "filename": job.filename,
        })
        job.push_event({"__terminal__": True})

    def mark_failed(self, job_id: str, error: str) -> None:
        job = self.get(job_id)
        if job is None:
            return
        job.status = "failed"
        job.error = error
        job.finished_at = time.time()
        job.push_event({
            "phase": "failed",
            "message": error,
        })
        job.push_event({"__terminal__": True})

    def prune(self, max_age_seconds: int = 3600) -> int:
        """Drop finished jobs older than `max_age_seconds`. Returns count removed."""
        cutoff = time.time() - max_age_seconds
        removed = 0
        with self._lock:
            to_del = [
                k
                for k, j in self._jobs.items()
                if j.finished_at is not None and j.finished_at < cutoff
            ]
            for k in to_del:
                del self._jobs[k]
                removed += 1
        return removed


JOBS = JobRegistry()


def progress_callback_for(job: Job):
    """Build a callback closure compatible with `extract_resilient(on_event=...)`."""
    def _cb(event: dict) -> None:
        job.push_event(event)
    return _cb
