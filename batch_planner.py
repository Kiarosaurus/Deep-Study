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

from runtime_metrics import (
    MachineProfile,
    get_available_ram_gb,
    get_available_vram_gb,
)


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


def gpu_is_viable(
    profile: MachineProfile,
    pdf_bytes: bytes | None = None,
) -> tuple[bool, str]:
    """Pre-flight check: is the detected GPU worth trying at all?

    Returns (viable, reason). Viable means VRAM is large enough to hold
    Marker's base footprint plus at least one batch slot — otherwise the
    very first GPU attempt would CUDA-OOM and we would just have to fall
    back to CPU after wasting time.

    Thresholds use the profile's estimated coefficients; when `pdf_bytes`
    is provided we factor in the actual page density, which makes very
    image-heavy PDFs require more VRAM than text-only ones.
    """
    if profile.default_device != "cuda" or profile.gpu_total_gb <= 0:
        return False, f"no CUDA device detected (device={profile.default_device!r})"

    avail = get_available_vram_gb(profile)
    fixed_overhead = _SAFETY_CUSHION_GB + profile.gpu_marker_base_gb
    if avail <= fixed_overhead:
        return (
            False,
            f"VRAM too small for Marker base "
            f"(available≈{avail:.2f} GB, need >{fixed_overhead:.2f} GB)",
        )

    if pdf_bytes is not None:
        n_pages = quick_page_count(pdf_bytes)
        density = estimate_density_mb_per_page(pdf_bytes, n_pages)
    else:
        density = 0.0
    per_slot = profile.gpu_per_slot_gb_base + density * profile.gpu_per_slot_gb_density
    headroom = avail - fixed_overhead
    if headroom < per_slot:
        return (
            False,
            f"VRAM cannot fit one batch slot "
            f"(headroom={headroom:.2f} GB, per_slot≈{per_slot:.2f} GB)",
        )

    return True, (
        f"GPU viable: avail≈{avail:.2f} GB, headroom={headroom:.2f} GB, "
        f"per_slot≈{per_slot:.2f} GB"
    )


def _budget_for_device(
    profile: MachineProfile,
    device: str,
    available_gb: float | None,
) -> tuple[float, float, float, float]:
    """Return (available, marker_base, per_slot_base, per_slot_density)
    for the given device. Device 'cuda' draws from the VRAM budget; 'mps'
    and 'cpu' share the system-RAM budget (MPS uses unified memory)."""
    if device == "cuda":
        avail = available_gb if available_gb is not None else get_available_vram_gb(profile)
        return (
            avail,
            profile.gpu_marker_base_gb,
            profile.gpu_per_slot_gb_base,
            profile.gpu_per_slot_gb_density,
        )
    avail = available_gb if available_gb is not None else get_available_ram_gb()
    return (
        avail,
        profile.marker_base_gb,
        profile.per_slot_gb_base,
        profile.per_slot_gb_density,
    )


def pick_batch(
    pdf_bytes: bytes,
    profile: MachineProfile,
    *,
    device: str | None = None,
    available_gb: float | None = None,
) -> int:
    """Pick an initial batch size for this PDF + current free memory.

    Args:
        pdf_bytes: raw PDF (used for size + page count).
        profile: persisted machine profile.
        device: 'cuda' / 'mps' / 'cpu'. Defaults to `profile.default_device`.
            Selects which memory pool (VRAM vs system RAM) is used as budget.
        available_gb: override (mainly for testing). Defaults to live probe.
    """
    if device is None:
        device = profile.default_device
    avail, marker_base, slot_base, slot_density = _budget_for_device(
        profile, device, available_gb
    )
    n_pages = quick_page_count(pdf_bytes)
    density = estimate_density_mb_per_page(pdf_bytes, n_pages)

    headroom = avail - _SAFETY_CUSHION_GB - marker_base
    if headroom <= 0:
        return _MIN_BATCH

    per_slot = slot_base + density * slot_density
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
    device: str | None = None,
    available_gb: float | None = None,
    n_pages: int | None = None,
) -> int:
    """Pick an initial chunk size (pages per sub-PDF) for the chunked
    fallback tier. Uses the same headroom model as `pick_batch` but applied
    to per-page intermediate cost when Marker processes a sub-PDF at batch=1.
    """
    if device is None:
        device = profile.default_device
    if device == "cuda":
        avail = available_gb if available_gb is not None else get_available_vram_gb(profile)
        marker_base = profile.gpu_marker_base_gb
        page_base = profile.gpu_chunk_per_page_gb_base
        page_density = profile.gpu_chunk_per_page_gb_density
    else:
        avail = available_gb if available_gb is not None else get_available_ram_gb()
        marker_base = profile.marker_base_gb
        page_base = profile.chunk_per_page_gb_base
        page_density = profile.chunk_per_page_gb_density

    if n_pages is None:
        n_pages = quick_page_count(pdf_bytes)
    density = estimate_density_mb_per_page(pdf_bytes, n_pages)

    headroom = avail - _SAFETY_CUSHION_GB - marker_base
    if headroom <= 0:
        return _MIN_CHUNK

    per_page = page_base + density * page_density
    if per_page <= 0:
        return min(_MAX_CHUNK, n_pages)

    chunk = int(headroom / per_page)
    chunk = max(_MIN_CHUNK, min(_MAX_CHUNK, chunk))
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
