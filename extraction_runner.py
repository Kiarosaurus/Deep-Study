"""Parent-side orchestration for resilient PDF extraction.

Spawns `marker_worker` as a subprocess, watches for clean failure or hard
kill (OOM-killer), and retries with progressively smaller batches. If even
batch=1 fails to fit, falls back to chunked extraction: the PDF is split into
N-page sub-PDFs, each extracted independently in its own subprocess at
batch=1, and the results are stitched back into a single (pages, linear)
pair.

The subprocess boundary is what makes adaptive batch sizing actually work —
Marker / Surya read their `*_BATCH_SIZE` env vars at model-init time, so the
parent cannot change them between requests once it has imported marker. Each
retry spawns a fresh interpreter so the new env values take effect.

Fallback ladder (top tier first):
    1. Adaptive batch tier sequence (e.g. [4, 2, 1]).
    2. Chunked extraction at decreasing chunk sizes (e.g. [5, 2]), all
       with batch=1. Each chunk runs in its own subprocess so a single huge
       page that still OOMs at chunk=1 surfaces as ExtractionFailed.
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
    compute_chunk_fallback_tiers,
    compute_fallback_tiers,
    pick_batch,
    pick_chunk_size,
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


def _split_pdf_into_chunks(
    pdf_path: Path,
    chunk_size: int,
    workdir: Path,
) -> list[tuple[Path, int]]:
    """Split `pdf_path` into sub-PDFs of `chunk_size` pages.

    Returns a list of (sub_pdf_path, page_offset) pairs in original page order.
    `page_offset` is the 0-based index of the first page of each sub-PDF in
    the original document; the caller adds it back to every `page` and
    `reading_index` field while stitching.
    """
    import fitz  # PyMuPDF, already a dependency
    pairs: list[tuple[Path, int]] = []
    with fitz.open(pdf_path) as doc:
        total = doc.page_count
        idx = 0
        for start in range(0, total, chunk_size):
            end = min(total, start + chunk_size)
            sub_path = workdir / f"chunk_{idx:03d}_{start}_{end}.pdf"
            sub = fitz.open()
            sub.insert_pdf(doc, from_page=start, to_page=end - 1)
            sub.save(str(sub_path))
            sub.close()
            pairs.append((sub_path, start))
            idx += 1
    return pairs


def _stitch_chunk_results(
    chunk_results: list[tuple[dict, int]],
) -> tuple[list[PageBlocks], list[FullBlock]]:
    """Concatenate per-chunk results, shifting `page` and `reading_index`.

    Cross-chunk continuations are re-detected by re-running
    `_merge_continuations_linear` on the stitched linear list. Cross-chunk
    figure-caption pairs are NOT re-merged here: such a split (figure on
    page N, caption on page N+1, chunk boundary between them) is rare in
    practice, and the linear figure-caption pass only checks immediate
    neighbours.
    """
    from extraction import _merge_continuations_linear  # safe: lazy marker

    pages_all: list[dict] = []
    linear_all: list[dict] = []
    ri_offset = 0
    for payload, page_offset in chunk_results:
        max_ri_in_chunk = -1
        for p in payload.get("pages", []):
            p["page"] = p.get("page", 1) + page_offset
            pages_all.append(p)
        for b in payload.get("linear", []):
            b["page"] = b.get("page", 1) + page_offset
            b["reading_index"] = b.get("reading_index", 0) + ri_offset
            max_ri_in_chunk = max(max_ri_in_chunk, b["reading_index"])
            linear_all.append(b)
        # Next chunk's reading_index continues past the last one used.
        if max_ri_in_chunk >= 0:
            ri_offset = max_ri_in_chunk + 1

    pages = [PageBlocks(**p) for p in pages_all]
    linear = [FullBlock(**b) for b in linear_all]
    _merge_continuations_linear(linear)
    return pages, linear


def _run_chunked(
    pdf_path: Path,
    chunk_size: int,
    *,
    force_cpu: bool,
    timeout_s: float,
    profile: MachineProfile,
    n_pages_total: int,
    pdf_mb_total: float,
) -> tuple[list[PageBlocks], list[FullBlock]] | str:
    """Run one chunked-extraction tier. Each chunk runs in its own subprocess
    at batch=1. Returns the stitched (pages, linear) on success, or a string
    reason on failure (OOM-like or clean error in any chunk)."""
    with tempfile.TemporaryDirectory(prefix="deepstudy-chunked-") as td:
        workdir = Path(td)
        try:
            chunks = _split_pdf_into_chunks(pdf_path, chunk_size, workdir)
        except Exception as e:
            return f"split failed: {type(e).__name__}: {e}"

        collected: list[tuple[dict, int]] = []
        for sub_path, page_offset in chunks:
            rc, status, result = _run_subprocess(
                sub_path,
                batch=1,
                force_cpu=force_cpu,
                timeout_s=timeout_s,
            )
            if rc == 0 and result is not None:
                collected.append((result, page_offset))
                continue
            if _looks_like_oom(rc, status):
                append_history(
                    profile,
                    pdf_pages=n_pages_total,
                    pdf_mb=pdf_mb_total,
                    batch_tried=1,
                    result=f"chunked oom (chunk_size={chunk_size}, rc={rc})",
                )
                return f"chunk OOM (chunk_size={chunk_size}, rc={rc})"
            err_type = (status or {}).get("error_type", "UnknownError")
            err_msg = (status or {}).get("error_msg", "")
            append_history(
                profile,
                pdf_pages=n_pages_total,
                pdf_mb=pdf_mb_total,
                batch_tried=1,
                result=f"chunked error:{err_type}",
            )
            return f"chunk clean error: {err_type}: {err_msg}"

        try:
            pages, linear = _stitch_chunk_results(collected)
        except Exception as e:
            return f"stitch failed: {type(e).__name__}: {e}"
        return pages, linear


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

        # Batch tiers exhausted. Try chunked extraction: split the PDF into
        # smaller sub-PDFs so per-chunk peak RAM is bounded even when a single
        # whole-document run cannot fit at batch=1. The initial chunk size is
        # derived from current available RAM + per-page intermediate cost
        # coefficients in the machine profile; it then halves on each
        # subsequent failure down to `_MIN_CHUNK`.
        initial_chunk = pick_chunk_size(pdf_bytes, profile, n_pages=n_pages)
        chunk_tiers = compute_chunk_fallback_tiers(initial_chunk, n_pages)
        for chunk_size in chunk_tiers:
            outcome = _run_chunked(
                pdf_path,
                chunk_size,
                force_cpu=force_cpu,
                timeout_s=timeout_s,
                profile=profile,
                n_pages_total=n_pages,
                pdf_mb_total=pdf_mb,
            )
            if isinstance(outcome, tuple):
                append_history(
                    profile,
                    pdf_pages=n_pages,
                    pdf_mb=pdf_mb,
                    batch_tried=1,
                    result=f"chunked ok (chunk_size={chunk_size})",
                )
                save_profile(profile)
                return outcome
            last_error = outcome

        save_profile(profile)
        raise ExtractionFailed(
            f"All fallback tiers exhausted "
            f"(batch tiers={tiers}, chunk tiers={chunk_tiers}). "
            f"Last: {last_error}"
        )
    finally:
        try:
            os.unlink(pdf_path)
        except OSError:
            pass
