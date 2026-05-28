"""Parent-side orchestration for resilient PDF extraction.

Spawns `marker_worker` as a subprocess, watches for clean failure or hard
kill (OOM-killer), and retries with progressively smaller batches.

The subprocess boundary is what makes adaptive batch sizing actually work —
Marker / Surya read their `*_BATCH_SIZE` env vars at model-init time, so the
parent cannot change them between requests once it has imported marker. Each
retry spawns a fresh interpreter so the new env values take effect.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from batch_planner import (
    compute_fallback_tiers,
    pick_batch,
    quick_page_count,
)
from models import FullBlock, PageBlocks
from runtime_metrics import (
    MachineProfile,
    append_history,
    load_profile,
    save_profile,
)


class ExtractionFailed(RuntimeError):
    """Raised when every fallback tier has been exhausted."""


# Process exit codes / signals that we treat as "ran out of memory, retry
# with a smaller batch". We use a heuristic OR rather than an exclusive list
# because OOM presents differently across OSes:
#   - WSL / Linux: SIGKILL by OOM-killer → subprocess returncode == -9
#   - Windows: TerminateProcess on commit-limit hit → returncode is a Win32
#     status (often huge negative, sometimes 1, sometimes 0xC0000005-style).
#   - Clean MemoryError caught in child → returncode 137 (our convention).
# Anything non-zero with no successful result file is treated as OOM-like
# and retried at a lower tier. A clean error_type other than MemoryError
# from the status file aborts retries (e.g. unparseable PDF).
def _looks_like_oom(returncode: int, status: dict[str, Any] | None) -> bool:
    if status is not None and not status.get("ok", False):
        err = status.get("error_type", "")
        if err == "MemoryError":
            return True
        # Any other clean error from the child is a real bug, not OOM.
        return False
    if returncode == 0:
        return False
    return True  # non-zero with no status file → likely hard kill


def _run_subprocess(
    pdf_path: Path,
    batch: int,
    *,
    force_cpu: bool,
    timeout_s: float,
) -> tuple[int, dict[str, Any] | None, dict[str, Any] | None]:
    """Run marker_worker once. Returns (returncode, status_dict, result_dict)."""
    with tempfile.TemporaryDirectory(prefix="deepstudy-extract-") as td:
        out_path = Path(td) / "out.json"
        status_path = Path(td) / "status.json"
        cmd = [
            sys.executable,
            "-m",
            "marker_worker",
            "--pdf",
            str(pdf_path),
            "--batch",
            str(batch),
            "--out",
            str(out_path),
            "--status",
            str(status_path),
        ]
        if force_cpu:
            cmd.append("--cpu")
        try:
            completed = subprocess.run(
                cmd,
                check=False,
                timeout=timeout_s,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            rc = completed.returncode
        except subprocess.TimeoutExpired:
            return (-1000, {"ok": False, "error_type": "Timeout"}, None)

        status = None
        if status_path.exists():
            try:
                status = json.loads(status_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                status = None

        result = None
        if rc == 0 and out_path.exists():
            try:
                result = json.loads(out_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                result = None
        return rc, status, result


def extract_resilient(
    pdf_bytes: bytes,
    *,
    force_cpu: bool = False,
    timeout_s: float = 600.0,
) -> tuple[list[PageBlocks], list[FullBlock]]:
    """Run extraction in a subprocess, retrying with smaller batches on OOM.

    Each retry spawns a fresh interpreter so that Marker re-reads its batch
    env vars. The fallback sequence is derived from the host's current free
    RAM and the PDF's size + page count, then halved on each failure down to
    batch=1. If batch=1 still OOMs, raises `ExtractionFailed`.
    """
    profile = load_profile()
    initial = pick_batch(pdf_bytes, profile)
    tiers = compute_fallback_tiers(initial)
    n_pages = quick_page_count(pdf_bytes)
    pdf_mb = len(pdf_bytes) / 1e6

    # Stage the PDF on disk once so each retry can read it without holding
    # multi-MB buffers in the parent.
    with tempfile.NamedTemporaryFile(
        mode="wb",
        suffix=".pdf",
        prefix="deepstudy-extract-",
        delete=False,
    ) as f:
        f.write(pdf_bytes)
        pdf_path = Path(f.name)

    last_error: str | None = None
    try:
        for batch in tiers:
            rc, status, result = _run_subprocess(
                pdf_path,
                batch,
                force_cpu=force_cpu,
                timeout_s=timeout_s,
            )

            if rc == 0 and result is not None:
                append_history(
                    profile,
                    pdf_pages=n_pages,
                    pdf_mb=pdf_mb,
                    batch_tried=batch,
                    result="ok",
                )
                save_profile(profile)
                pages = [PageBlocks(**p) for p in result["pages"]]
                linear = [FullBlock(**b) for b in result["linear"]]
                return pages, linear

            if _looks_like_oom(rc, status):
                append_history(
                    profile,
                    pdf_pages=n_pages,
                    pdf_mb=pdf_mb,
                    batch_tried=batch,
                    result=f"oom (rc={rc})",
                )
                last_error = f"OOM-like exit (rc={rc}) at batch={batch}"
                continue

            # Clean non-OOM error from child — don't bother retrying.
            err_type = (status or {}).get("error_type", "UnknownError")
            err_msg = (status or {}).get("error_msg", "")
            append_history(
                profile,
                pdf_pages=n_pages,
                pdf_mb=pdf_mb,
                batch_tried=batch,
                result=f"error:{err_type}",
            )
            save_profile(profile)
            raise ExtractionFailed(
                f"Extraction failed in child: {err_type}: {err_msg}"
            )

        save_profile(profile)
        raise ExtractionFailed(
            f"All fallback tiers exhausted ({tiers}). Last: {last_error}"
        )
    finally:
        try:
            os.unlink(pdf_path)
        except OSError:
            pass
