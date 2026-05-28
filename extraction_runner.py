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
    0. Pre-flight: drop CUDA from the ladder if VRAM cannot fit Marker's
       base footprint plus one batch slot. Avoids paying 10-30s of GPU
       cold-start only to CUDA-OOM on the first attempt.
    1. GPU pass (only if CUDA/MPS detected AND the pre-flight check
       passed): adaptive batch tiers sized against VRAM, then chunked tiers
       sized against VRAM. The first CUDA OOM during the pass abandons
       this device immediately (smaller batch on the same VRAM doesn't
       help when the model itself doesn't fit).
    2. CPU pass: adaptive batch tiers sized against system RAM, then
       chunked tiers sized against system RAM. Safety net.
    3. ExtractionFailed.

GPU vs CPU OOM are distinguished by child exit code (138 vs 137) and the
`error_type` field of the status JSON.
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
    gpu_is_viable,
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


def _emit(on_event, payload: dict) -> None:
    """Fire a progress event, swallowing exceptions so a buggy listener can
    never break extraction. Events are plain dicts; consumers (SSE, logs,
    progress bars) decide how to render them."""
    if on_event is None:
        return
    try:
        on_event(payload)
    except Exception:
        pass




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
    """OOM-like = retry candidate. Includes RAM OOM (137), CUDA OOM (138),
    and any non-zero exit with no status file (likely OS hard kill)."""
    if status is not None and not status.get("ok", False):
        err = status.get("error_type", "")
        if err in ("MemoryError", "CUDAOutOfMemoryError"):
            return True
        return False
    if returncode == 0:
        return False
    return True


def _is_cuda_oom(returncode: int, status: dict[str, Any] | None) -> bool:
    """Specifically a CUDA OOM — used to abandon the GPU pass early without
    further GPU retries (smaller batches usually don't help once VRAM is
    fragmented or the model itself doesn't fit)."""
    if status is not None and status.get("error_type") == "CUDAOutOfMemoryError":
        return True
    return returncode == 138


def _run_subprocess(
    pdf_path: Path,
    batch: int,
    *,
    device: str | None,
    timeout_s: float,
) -> tuple[int, dict[str, Any] | None, dict[str, Any] | None]:
    """Run marker_worker once. Returns (returncode, status_dict, result_dict).

    `device` overrides the child's torch device. Pass None to let torch pick
    the default; pass 'cpu' / 'cuda' / 'mps' to force one.
    """
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
        if device:
            cmd.extend(["--device", device])
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
    device: str | None,
    timeout_s: float,
    profile: MachineProfile,
    n_pages_total: int,
    pdf_mb_total: float,
    on_event=None,
) -> tuple[list[PageBlocks], list[FullBlock]] | dict:
    """Run one chunked-extraction tier. Each chunk runs in its own subprocess
    at batch=1 on the given device. Returns the stitched (pages, linear) on
    success, or a structured failure dict:
      - {'kind': 'oom'|'cuda_oom', 'message': str}  → caller can retry at a
        smaller chunk size (smaller chunk = smaller peak RAM).
      - {'kind': 'error', 'message': str}            → clean error in child
        or in split/stitch glue. Smaller chunks won't help; caller should
        abort the chunk-tier loop on this device.
    """
    with tempfile.TemporaryDirectory(prefix="deepstudy-chunked-") as td:
        workdir = Path(td)
        try:
            chunks = _split_pdf_into_chunks(pdf_path, chunk_size, workdir)
        except Exception as e:
            return {
                "kind": "error",
                "message": f"split failed: {type(e).__name__}: {e}",
            }

        total_chunks = len(chunks)
        _emit(on_event, {
            "phase": "chunk_started",
            "device": device,
            "chunk_size": chunk_size,
            "total_chunks": total_chunks,
            "message": f"Modo chunk activado ({chunk_size} páginas por chunk, {total_chunks} chunks)",
        })

        collected: list[tuple[dict, int]] = []
        for chunk_idx, (sub_path, page_offset) in enumerate(chunks):
            _emit(on_event, {
                "phase": "chunk_progress",
                "device": device,
                "chunk_size": chunk_size,
                "chunk_index": chunk_idx,
                "total_chunks": total_chunks,
                "message": f"Procesando chunk {chunk_idx + 1} de {total_chunks}",
            })
            rc, status, result = _run_subprocess(
                sub_path,
                batch=1,
                device=device,
                timeout_s=timeout_s,
            )
            if rc == 0 and result is not None:
                collected.append((result, page_offset))
                continue
            if _is_cuda_oom(rc, status):
                append_history(
                    profile,
                    pdf_pages=n_pages_total,
                    pdf_mb=pdf_mb_total,
                    batch_tried=1,
                    result=f"chunked cuda_oom (chunk_size={chunk_size})",
                )
                return {
                    "kind": "cuda_oom",
                    "message": f"chunk CUDA OOM (chunk_size={chunk_size})",
                }
            if _looks_like_oom(rc, status):
                append_history(
                    profile,
                    pdf_pages=n_pages_total,
                    pdf_mb=pdf_mb_total,
                    batch_tried=1,
                    result=f"chunked oom (chunk_size={chunk_size}, rc={rc})",
                )
                return {
                    "kind": "oom",
                    "message": f"chunk OOM (chunk_size={chunk_size}, rc={rc})",
                }
            err_type = (status or {}).get("error_type", "UnknownError")
            err_msg = (status or {}).get("error_msg", "")
            append_history(
                profile,
                pdf_pages=n_pages_total,
                pdf_mb=pdf_mb_total,
                batch_tried=1,
                result=f"chunked error:{err_type}",
            )
            return {
                "kind": "error",
                "message": f"chunk clean error: {err_type}: {err_msg}",
            }

        try:
            pages, linear = _stitch_chunk_results(collected)
        except Exception as e:
            return {
                "kind": "error",
                "message": f"stitch failed: {type(e).__name__}: {e}",
            }
        return pages, linear


def _run_device_pass(
    pdf_path: Path,
    pdf_bytes: bytes,
    *,
    device: str,
    profile: MachineProfile,
    timeout_s: float,
    n_pages: int,
    pdf_mb: float,
    on_event=None,
) -> tuple[list[PageBlocks], list[FullBlock]] | dict:
    """Run a full batch+chunk pass on the given device.

    Returns (pages, linear) on success, or a dict with:
        - 'kind': 'cuda_oom' | 'oom' | 'error' | 'exhausted'
        - 'last_error': str
        - 'batch_tiers': list[int]
        - 'chunk_tiers': list[int]
    so the caller can decide whether to move to the next device.
    """
    batch_init = pick_batch(pdf_bytes, profile, device=device)
    batch_tiers = compute_fallback_tiers(batch_init)
    _emit(on_event, {
        "phase": "device_started",
        "device": device,
        "batch_tiers": batch_tiers,
        "message": f"Iniciando extracción en {device} (batch tiers={batch_tiers})",
    })

    last_error: str | None = None
    for tier_idx, batch in enumerate(batch_tiers):
        _emit(on_event, {
            "phase": "batch_attempt",
            "device": device,
            "batch": batch,
            "tier_index": tier_idx,
            "total_tiers": len(batch_tiers),
            "message": (
                f"Intentando batch={batch} en {device}"
                if tier_idx == 0
                else f"Fallback: batch reducido a {batch} en {device}"
            ),
        })
        rc, status, result = _run_subprocess(
            pdf_path,
            batch,
            device=device,
            timeout_s=timeout_s,
        )

        if rc == 0 and result is not None:
            append_history(
                profile,
                pdf_pages=n_pages,
                pdf_mb=pdf_mb,
                batch_tried=batch,
                result=f"ok ({device})",
            )
            _emit(on_event, {
                "phase": "batch_success",
                "device": device,
                "batch": batch,
                "message": f"Extracción exitosa en {device} (batch={batch})",
            })
            pages = [PageBlocks(**p) for p in result["pages"]]
            linear = [FullBlock(**b) for b in result["linear"]]
            return pages, linear

        if _is_cuda_oom(rc, status):
            append_history(
                profile,
                pdf_pages=n_pages,
                pdf_mb=pdf_mb,
                batch_tried=batch,
                result=f"cuda_oom ({device}, batch={batch})",
            )
            _emit(on_event, {
                "phase": "cuda_oom_abandon",
                "device": device,
                "batch": batch,
                "message": "Fallback: GPU descartada por falta de memoria",
            })
            return {
                "kind": "cuda_oom",
                "last_error": f"CUDA OOM at batch={batch}",
                "batch_tiers": batch_tiers,
                "chunk_tiers": [],
            }

        if _looks_like_oom(rc, status):
            append_history(
                profile,
                pdf_pages=n_pages,
                pdf_mb=pdf_mb,
                batch_tried=batch,
                result=f"oom ({device}, batch={batch}, rc={rc})",
            )
            _emit(on_event, {
                "phase": "batch_oom",
                "device": device,
                "batch": batch,
                "rc": rc,
                "message": f"Fallback: OOM en batch={batch}, reintentando con batch más pequeño",
            })
            last_error = f"OOM at batch={batch} on {device} (rc={rc})"
            continue

        err_type = (status or {}).get("error_type", "UnknownError")
        err_msg = (status or {}).get("error_msg", "")
        append_history(
            profile,
            pdf_pages=n_pages,
            pdf_mb=pdf_mb,
            batch_tried=batch,
            result=f"error:{err_type} ({device})",
        )
        _emit(on_event, {
            "phase": "child_error",
            "device": device,
            "batch": batch,
            "error_type": err_type,
            "error_msg": err_msg,
            "message": f"Error en hijo: {err_type}: {err_msg}",
        })
        return {
            "kind": "error",
            "last_error": f"{err_type}: {err_msg}",
            "batch_tiers": batch_tiers,
            "chunk_tiers": [],
        }

    # Batch tiers exhausted — try chunked extraction on the same device.
    chunk_init = pick_chunk_size(pdf_bytes, profile, device=device, n_pages=n_pages)
    chunk_tiers = compute_chunk_fallback_tiers(chunk_init, n_pages)
    _emit(on_event, {
        "phase": "chunk_tier_started",
        "device": device,
        "chunk_tiers": chunk_tiers,
        "message": f"Fallback: modo chunk activado en {device} (chunk tiers={chunk_tiers})",
    })
    for chunk_size in chunk_tiers:
        outcome = _run_chunked(
            pdf_path,
            chunk_size,
            device=device,
            timeout_s=timeout_s,
            profile=profile,
            n_pages_total=n_pages,
            pdf_mb_total=pdf_mb,
            on_event=on_event,
        )
        if isinstance(outcome, tuple):
            append_history(
                profile,
                pdf_pages=n_pages,
                pdf_mb=pdf_mb,
                batch_tried=1,
                result=f"chunked ok (chunk_size={chunk_size}, {device})",
            )
            _emit(on_event, {
                "phase": "chunked_success",
                "device": device,
                "chunk_size": chunk_size,
                "message": f"Extracción exitosa en {device} (chunk_size={chunk_size})",
            })
            return outcome

        # Structured failure from _run_chunked. CUDA OOM → abandon device
        # (smaller chunk on same VRAM won't help). Clean error → abort the
        # chunk-tier loop (PDF/split issue won't be cured by smaller chunks).
        # Plain OOM → retry next smaller chunk_size.
        kind = outcome.get("kind", "error")
        msg = outcome.get("message", "")
        if kind == "cuda_oom":
            _emit(on_event, {
                "phase": "cuda_oom_abandon",
                "device": device,
                "chunk_size": chunk_size,
                "message": "Fallback: GPU descartada por OOM durante chunk",
            })
            return {
                "kind": "cuda_oom",
                "last_error": msg,
                "batch_tiers": batch_tiers,
                "chunk_tiers": chunk_tiers,
            }
        if kind == "error":
            _emit(on_event, {
                "phase": "child_error",
                "device": device,
                "chunk_size": chunk_size,
                "message": f"Error no recuperable en chunk: {msg}",
            })
            return {
                "kind": "error",
                "last_error": msg,
                "batch_tiers": batch_tiers,
                "chunk_tiers": chunk_tiers,
            }
        # kind == "oom"
        _emit(on_event, {
            "phase": "chunk_oom",
            "device": device,
            "chunk_size": chunk_size,
            "message": f"Fallback: chunk_size={chunk_size} en {device} falló por OOM, reduciendo",
        })
        last_error = f"{device} chunked: {msg}"

    return {
        "kind": "exhausted",
        "last_error": last_error or "no attempts",
        "batch_tiers": batch_tiers,
        "chunk_tiers": chunk_tiers,
    }


def extract_resilient(
    pdf_bytes: bytes,
    *,
    force_cpu: bool = False,
    timeout_s: float = 600.0,
    on_event=None,
) -> tuple[list[PageBlocks], list[FullBlock]]:
    """Run extraction with full GPU-then-CPU device fallback.

    Each device runs its own batch + chunk tier sequence in fresh subprocesses
    so Marker / Surya re-read their env vars per attempt. If the host has a
    CUDA device, we try GPU first (sized against VRAM); on CUDA OOM or any
    GPU-side OOM we fall through to a CPU pass (sized against system RAM).
    `force_cpu=True` skips the GPU pass entirely.

    `on_event` is an optional callable receiving progress dicts so callers
    (SSE, progress bar, logs) can react to fallbacks in real time.
    """
    profile = load_profile()
    n_pages = quick_page_count(pdf_bytes)
    pdf_mb = len(pdf_bytes) / 1e6
    _emit(on_event, {
        "phase": "started",
        "n_pages": n_pages,
        "pdf_mb": round(pdf_mb, 2),
        "default_device": profile.default_device,
        "message": f"Iniciando extracción ({n_pages} páginas, {pdf_mb:.2f} MB)",
    })

    # Stage PDF once so each retry reads from disk and the parent does not
    # keep the multi-MB buffer alive while a child runs.
    with tempfile.NamedTemporaryFile(
        mode="wb",
        suffix=".pdf",
        prefix="deepstudy-extract-",
        delete=False,
    ) as f:
        f.write(pdf_bytes)
        pdf_path = Path(f.name)

    # Build device sequence. CUDA only enters the ladder when it passes the
    # pre-flight VRAM-viability check — if the GPU is too small to fit
    # Marker's base plus a single batch slot, trying it would always CUDA-OOM
    # on the first attempt and waste 10-30s of cold-start. Skipping it
    # outright keeps the ladder strictly "try things that might work".
    # MPS is treated as a distinct tier so torch can use Metal even though
    # the memory budget is shared with system RAM.
    devices: list[str] = []
    last_summary: list[str] = []
    if not force_cpu:
        if profile.default_device == "cuda":
            viable, reason = gpu_is_viable(profile, pdf_bytes)
            if viable:
                devices.append("cuda")
            else:
                last_summary.append(f"cuda[skipped]: {reason}")
                _emit(on_event, {
                    "phase": "device_skipped",
                    "device": "cuda",
                    "reason": reason,
                    "message": f"Fallback: GPU descartada ({reason})",
                })
        elif profile.default_device == "mps":
            devices.append("mps")
    if not devices or devices[-1] != "cpu":
        devices.append("cpu")
    _emit(on_event, {
        "phase": "device_ladder",
        "devices": devices,
        "message": f"Devices a probar: {', '.join(devices)}",
    })
    try:
        for device in devices:
            outcome = _run_device_pass(
                pdf_path,
                pdf_bytes,
                device=device,
                profile=profile,
                timeout_s=timeout_s,
                n_pages=n_pages,
                pdf_mb=pdf_mb,
                on_event=on_event,
            )
            if isinstance(outcome, tuple):
                save_profile(profile)
                return outcome

            last_summary.append(
                f"{device}[{outcome['kind']}]: {outcome['last_error']} "
                f"(batch tiers={outcome['batch_tiers']}, "
                f"chunk tiers={outcome['chunk_tiers']})"
            )

            if outcome["kind"] == "error":
                save_profile(profile)
                _emit(on_event, {
                    "phase": "failed",
                    "device": device,
                    "message": f"Extracción falló en {device}: {outcome['last_error']}",
                })
                raise ExtractionFailed(
                    f"Extraction failed in child on {device}: "
                    f"{outcome['last_error']}"
                )
            _emit(on_event, {
                "phase": "device_exhausted",
                "device": device,
                "message": f"Fallback: {device} agotado, intentando siguiente device",
            })

        save_profile(profile)
        _emit(on_event, {
            "phase": "failed",
            "message": "Todos los fallbacks agotados",
        })
        raise ExtractionFailed(
            "All fallback tiers exhausted across devices "
            f"({' | '.join(last_summary)})"
        )
    finally:
        try:
            os.unlink(pdf_path)
        except OSError:
            pass
