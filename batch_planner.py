"""Decide a Marker batch size adaptive to the current machine state, and
produce a progressive fallback sequence used by the resilient extractor.

The cost model is intentionally simple: peak RAM during extraction is modelled
as `marker_base_gb + batch * per_slot_gb(density)`, and we pick the largest
batch whose modelled cost fits within current available RAM minus a safety
cushion. Coefficients live in the persisted `MachineProfile` so they can be
refined over time from observed runs.
"""

from __future__ import annotations

import io
from typing import Iterable

from runtime_metrics import MachineProfile, get_available_ram_gb


_MIN_BATCH = 1
_MAX_BATCH = 6
_SAFETY_CUSHION_GB = 1.0  # never burn more than (available - this) on batch slots

# Chunked extraction (used as fallback after every batch tier failed).
# A chunk is a sub-PDF of N pages. Per-chunk peak RAM grows with N because
# Marker stages intermediate outputs across pages of one chunk.
_MIN_CHUNK = 2     # below this it's identical to running batch=1 already tried
_MAX_CHUNK = 20    # cap to keep stitch overhead reasonable


def quick_page_count(pdf_bytes: bytes) -> int:
    """Fast page count via PyMuPDF (already a dependency for figure cropping)."""
    try:
        import fitz  # PyMuPDF
        with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
            return doc.page_count
    except Exception:
        return 1


def estimate_density_mb_per_page(pdf_bytes: bytes, n_pages: int) -> float:
    size_mb = len(pdf_bytes) / 1e6
    return size_mb / max(1, n_pages)


def pick_batch(
    pdf_bytes: bytes,
    profile: MachineProfile,
    *,
    available_gb: float | None = None,
) -> int:
    """Pick an initial batch size for this PDF + current free RAM.

    Args:
        pdf_bytes: raw PDF (used for size + page count).
        profile: persisted machine profile.
        available_gb: override (mainly for testing). Defaults to live psutil read.
    """
    if available_gb is None:
        available_gb = get_available_ram_gb()
    n_pages = quick_page_count(pdf_bytes)
    density = estimate_density_mb_per_page(pdf_bytes, n_pages)

    # Headroom = what is free now, minus the safety cushion, minus the cost of
    # loading Marker itself (only relevant on first run of a subprocess — but
    # since each retry spawns fresh, we always pay this cost).
    headroom = available_gb - _SAFETY_CUSHION_GB - profile.marker_base_gb
    if headroom <= 0:
        return _MIN_BATCH

    per_slot = profile.per_slot_gb_base + density * profile.per_slot_gb_density
    if per_slot <= 0:
        return _MAX_BATCH

    batch = int(headroom / per_slot)
    batch = max(_MIN_BATCH, min(_MAX_BATCH, batch))
    return batch


def compute_fallback_tiers(initial: int) -> list[int]:
    """Sequence of batches to try, each more conservative than the last.

    Halves on each step until reaching 1, deduplicated and ordered.
    """
    tiers: list[int] = []
    current = max(_MIN_BATCH, min(_MAX_BATCH, initial))
    while True:
        if not tiers or tiers[-1] != current:
            tiers.append(current)
        if current <= _MIN_BATCH:
            break
        current = max(_MIN_BATCH, current // 2)
    return tiers


def pick_chunk_size(
    pdf_bytes: bytes,
    profile: MachineProfile,
    *,
    available_gb: float | None = None,
    n_pages: int | None = None,
) -> int:
    """Pick an initial chunk size (pages per sub-PDF) for the chunked
    fallback tier. Uses the same headroom model as `pick_batch` but applied
    to per-page intermediate cost when Marker processes a sub-PDF at batch=1.
    """
    if available_gb is None:
        available_gb = get_available_ram_gb()
    if n_pages is None:
        n_pages = quick_page_count(pdf_bytes)
    density = estimate_density_mb_per_page(pdf_bytes, n_pages)

    headroom = available_gb - _SAFETY_CUSHION_GB - profile.marker_base_gb
    if headroom <= 0:
        return _MIN_CHUNK

    per_page = profile.chunk_per_page_gb_base + density * profile.chunk_per_page_gb_density
    if per_page <= 0:
        return min(_MAX_CHUNK, n_pages)

    chunk = int(headroom / per_page)
    chunk = max(_MIN_CHUNK, min(_MAX_CHUNK, chunk))
    # Never produce a chunk larger than the document itself.
    chunk = min(chunk, max(_MIN_CHUNK, n_pages))
    return chunk


def compute_chunk_fallback_tiers(initial: int, n_pages: int) -> list[int]:
    """Sequence of chunk sizes to try, each smaller than the last.

    Halves on each step until reaching `_MIN_CHUNK`. Skips any size that
    would equal or exceed the page count (a single chunk = whole document,
    which is what the batch=1 tier already attempted).
    """
    tiers: list[int] = []
    current = max(_MIN_CHUNK, min(_MAX_CHUNK, initial))
    current = min(current, max(_MIN_CHUNK, n_pages - 1))
    while True:
        if current < n_pages and (not tiers or tiers[-1] != current):
            tiers.append(current)
        if current <= _MIN_CHUNK:
            break
        current = max(_MIN_CHUNK, current // 2)
    return tiers


def env_overrides_for_batch(batch: int) -> dict[str, str]:
    """Env vars consumed by Marker/Surya at model-init time. Must be set BEFORE
    `import marker` happens in the target process.

    Names are defensive: we set both bare and `SURYA_`-prefixed variants
    because newer Surya versions migrated some of the names.
    """
    b = str(max(1, batch))
    return {
        "RECOGNITION_BATCH_SIZE": b,
        "DETECTOR_BATCH_SIZE": b,
        "LAYOUT_BATCH_SIZE": b,
        "ORDER_BATCH_SIZE": b,
        "TEXIFY_BATCH_SIZE": b,
        "TABLE_REC_BATCH_SIZE": b,
        "OCR_ERROR_BATCH_SIZE": b,
        "SURYA_RECOGNITION_BATCH_SIZE": b,
        "SURYA_DETECTOR_BATCH_SIZE": b,
        "SURYA_LAYOUT_BATCH_SIZE": b,
        "SURYA_ORDER_BATCH_SIZE": b,
    }
