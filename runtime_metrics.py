"""System-resource probing + per-installation machine profile.

The goal is to let extraction adapt to the host without the user configuring
anything. On first server start we detect total RAM, core count, and OS, then
persist a profile JSON so subsequent runs reuse it (and so observed peak RAM
from real extractions can later refine the cost coefficients).
"""

from __future__ import annotations

import json
import os
import platform
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional


_PROFILE_PATH = Path.home() / ".deepstudy" / "machine_profile.json"


@dataclass
class MachineProfile:
    detected_at: float
    os: str
    total_gb: float
    cores: int
    reserved_gb: float          # estimated baseline used by OS + other apps
    marker_base_gb: float       # cost of Marker singleton once loaded
    per_slot_gb_base: float     # additive cost per +1 batch slot, before density
    per_slot_gb_density: float  # multiplier on density (MB/page) for per-slot cost
    history: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _get_total_ram_gb() -> float:
    """Return total physical RAM in GB. Tries psutil, falls back to OS-native APIs."""
    try:
        import psutil
        return psutil.virtual_memory().total / 1e9
    except ImportError:
        pass

    system = platform.system()
    if system == "Windows":
        import ctypes
        import ctypes.wintypes as wt

        class _M(ctypes.Structure):
            _fields_ = [
                ("dwLength", wt.DWORD),
                ("dwMemoryLoad", wt.DWORD),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        m = _M()
        m.dwLength = ctypes.sizeof(_M)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        return m.ullTotalPhys / 1e9

    if hasattr(os, "sysconf"):
        try:
            pages = os.sysconf("SC_PHYS_PAGES")
            size = os.sysconf("SC_PAGE_SIZE")
            return pages * size / 1e9
        except (ValueError, OSError):
            pass
    return 0.0


def get_available_ram_gb() -> float:
    """Current free RAM, queried at call time (cheap)."""
    try:
        import psutil
        return psutil.virtual_memory().available / 1e9
    except ImportError:
        pass

    if platform.system() == "Windows":
        import ctypes
        import ctypes.wintypes as wt

        class _M(ctypes.Structure):
            _fields_ = [
                ("dwLength", wt.DWORD),
                ("dwMemoryLoad", wt.DWORD),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        m = _M()
        m.dwLength = ctypes.sizeof(_M)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        return m.ullAvailPhys / 1e9

    if platform.system() == "Linux":
        try:
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith("MemAvailable:"):
                        return int(line.split()[1]) * 1024 / 1e9
        except OSError:
            pass
    return 0.0


def _default_profile() -> MachineProfile:
    """Build a fresh profile by probing the host."""
    total = _get_total_ram_gb()
    system = platform.system()
    # Windows reserves more for OS + Defender + Explorer than typical Linux.
    reserved = 3.5 if system == "Windows" else 2.0
    return MachineProfile(
        detected_at=time.time(),
        os=system,
        total_gb=round(total, 2),
        cores=os.cpu_count() or 1,
        reserved_gb=reserved,
        marker_base_gb=2.8,
        per_slot_gb_base=0.5,
        per_slot_gb_density=0.35,
        history=[],
    )


def load_profile() -> MachineProfile:
    """Read profile from disk; create a new one on first run."""
    try:
        if _PROFILE_PATH.exists():
            data = json.loads(_PROFILE_PATH.read_text(encoding="utf-8"))
            return MachineProfile(**data)
    except (json.JSONDecodeError, TypeError, OSError):
        pass
    profile = _default_profile()
    save_profile(profile)
    return profile


def save_profile(profile: MachineProfile) -> None:
    try:
        _PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _PROFILE_PATH.write_text(
            json.dumps(profile.to_dict(), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError:
        # Best-effort. If we cannot persist, fall back to in-memory only.
        pass


def append_history(
    profile: MachineProfile,
    *,
    pdf_pages: int,
    pdf_mb: float,
    batch_tried: int,
    result: str,
    peak_gb_observed: Optional[float] = None,
) -> None:
    """Record a single extraction outcome. Caller persists with `save_profile`."""
    profile.history.append({
        "ts": time.time(),
        "pdf_pages": pdf_pages,
        "pdf_mb": round(pdf_mb, 2),
        "batch_tried": batch_tried,
        "result": result,
        "peak_gb_observed": (
            round(peak_gb_observed, 2) if peak_gb_observed is not None else None
        ),
    })
    # Cap history so the profile file does not grow unbounded.
    if len(profile.history) > 100:
        profile.history = profile.history[-100:]
