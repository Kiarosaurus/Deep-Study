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
    marker_base_gb: float       # cost of Marker singleton once loaded (CPU/RAM path)
    per_slot_gb_base: float     # additive cost per +1 batch slot, before density (RAM)
    per_slot_gb_density: float  # multiplier on density (MB/page) for per-slot cost (RAM)
    chunk_per_page_gb_base: float = 0.15
    chunk_per_page_gb_density: float = 0.4
    default_device: str = "cpu"     # 'cuda' | 'mps' | 'cpu' — picked by torch on this host
    # GPU-side metrics. Populated when default_device == 'cuda'. MPS hosts use
    # unified memory so VRAM == system RAM and these stay zeroed (the planner
    # falls back to the RAM budget for MPS).
    gpu_total_gb: float = 0.0
    gpu_name: str = ""
    gpu_available_frac: float = 0.85  # assumed free fraction of VRAM at job start
    # Educated-guess cost coefficients on GPU. Cheaper per slot than CPU
    # because VRAM holds only tensor working sets, not Python objects.
    gpu_marker_base_gb: float = 2.0
    gpu_per_slot_gb_base: float = 0.35
    gpu_per_slot_gb_density: float = 0.25
    gpu_chunk_per_page_gb_base: float = 0.1
    gpu_chunk_per_page_gb_density: float = 0.3
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


def _probe_torch_device_and_vram() -> tuple[str, float, str]:
    """Detect torch device + total VRAM + GPU name in a subprocess.

    Returns ``(device, gpu_total_gb, gpu_name)``.

    Done out-of-process so the parent never loads torch (heavy import).
    For CUDA, reads `torch.cuda.get_device_properties(0).total_memory` to
    learn how much VRAM the planner can budget against. For MPS, we don't
    expose a separate VRAM number because Apple unified memory means VRAM
    == system RAM — the planner detects this and falls back to the RAM
    budget for MPS. CPU hosts return ``("cpu", 0.0, "")``.
    """
    import subprocess
    import sys

    code = (
        "import json\n"
        "out = {'device': 'cpu', 'vram_gb': 0.0, 'name': ''}\n"
        "try:\n"
        "    import torch\n"
        "    if torch.cuda.is_available():\n"
        "        idx = 0\n"
        "        props = torch.cuda.get_device_properties(idx)\n"
        "        out['device'] = 'cuda'\n"
        "        out['vram_gb'] = props.total_memory / 1e9\n"
        "        out['name'] = props.name\n"
        "    elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():\n"
        "        out['device'] = 'mps'\n"
        "        # MPS uses unified memory; do not duplicate the RAM number.\n"
        "        out['name'] = 'Apple MPS'\n"
        "except Exception:\n"
        "    pass\n"
        "print(json.dumps(out))\n"
    )
    try:
        result = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=25,
        )
        text = (result.stdout or "").strip().splitlines()
        if text:
            payload = json.loads(text[-1])
            device = payload.get("device", "cpu")
            vram = float(payload.get("vram_gb", 0.0) or 0.0)
            name = payload.get("name", "") or ""
            if device in ("cuda", "mps", "cpu"):
                return device, round(vram, 2), name
    except (subprocess.TimeoutExpired, OSError, json.JSONDecodeError, ValueError):
        pass
    return "cpu", 0.0, ""


def _probe_torch_device() -> str:
    """Back-compat wrapper for the device-only probe used by load_profile
    migration of older profiles that did not yet store VRAM metrics."""
    return _probe_torch_device_and_vram()[0]


def get_available_vram_gb(profile: MachineProfile) -> float:
    """Conservative estimate of currently-free VRAM.

    We do not re-probe `torch.cuda.mem_get_info()` here because that would
    require loading torch in the parent (or another subprocess per call).
    Instead we assume `gpu_available_frac` of `gpu_total_gb` is free — a
    safe lower bound when no other GPU workload is running. Real OOM events
    feed back into history so the fraction can be refined. Returns 0 when
    no GPU was detected.
    """
    if profile.gpu_total_gb <= 0:
        return 0.0
    return profile.gpu_total_gb * profile.gpu_available_frac


def _default_profile() -> MachineProfile:
    """Build a fresh profile by probing the host."""
    total = _get_total_ram_gb()
    system = platform.system()
    # Windows reserves more for OS + Defender + Explorer than typical Linux.
    reserved = 3.5 if system == "Windows" else 2.0
    device, gpu_gb, gpu_name = _probe_torch_device_and_vram()
    return MachineProfile(
        detected_at=time.time(),
        os=system,
        total_gb=round(total, 2),
        cores=os.cpu_count() or 1,
        reserved_gb=reserved,
        marker_base_gb=2.8,
        per_slot_gb_base=0.5,
        per_slot_gb_density=0.35,
        chunk_per_page_gb_base=0.15,
        chunk_per_page_gb_density=0.4,
        default_device=device,
        gpu_total_gb=gpu_gb,
        gpu_name=gpu_name,
        history=[],
    )


def load_profile() -> MachineProfile:
    """Read profile from disk; create a new one on first run.

    Performs a light migration: drops unknown keys (forward-incompatible
    profiles from a future version) and re-probes `default_device` whenever
    it is absent from an older profile written before the field existed.
    """
    try:
        if _PROFILE_PATH.exists():
            data = json.loads(_PROFILE_PATH.read_text(encoding="utf-8"))
            valid_keys = {f.name for f in MachineProfile.__dataclass_fields__.values()}
            filtered = {k: v for k, v in data.items() if k in valid_keys}
            if "default_device" not in filtered or "gpu_total_gb" not in filtered:
                device, gpu_gb, gpu_name = _probe_torch_device_and_vram()
                filtered.setdefault("default_device", device)
                filtered.setdefault("gpu_total_gb", gpu_gb)
                filtered.setdefault("gpu_name", gpu_name)
            profile = MachineProfile(**filtered)
            # Persist any migration so we don't redo the probe each load.
            if filtered != data:
                save_profile(profile)
            return profile
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
