"""Marker child-process entrypoint.

Run as: `python -m marker_worker --pdf <path> --batch <n> --out <result.json>
                                 [--status <status.json>] [--cpu]`

The parent (`extraction_runner.py`) writes the PDF to a temp file, spawns this
script, and reads the result back from disk. Doing it in a fresh subprocess
gives us two things at once:

  1. Adaptive batch sizing — env vars are set HERE, before any `marker` import,
     so each retry can use a different batch without reloading the parent's
     interpreter.
  2. Resilient retry — if the OS OOM-killer terminates this process (no chance
     to write `status.json`), the parent sees a non-zero / signalled exit and
     can retry with a smaller batch.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback


def _set_batch_env(batch: int, device: str | None) -> None:
    """Set Marker/Surya batch env vars and torch device BEFORE marker import.

    `device` accepts 'cuda', 'mps', 'cpu', or None (let torch decide).
    """
    from batch_planner import env_overrides_for_batch

    for key, value in env_overrides_for_batch(batch).items():
        os.environ[key] = value
    if device:
        os.environ["TORCH_DEVICE"] = device


def _write_status(path: str | None, payload: dict) -> None:
    if not path:
        return
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
    except OSError:
        pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True, help="Path to source PDF.")
    parser.add_argument("--batch", type=int, required=True)
    parser.add_argument("--out", required=True, help="Result JSON path.")
    parser.add_argument("--status", default=None, help="Status JSON path.")
    parser.add_argument(
        "--device",
        default=None,
        choices=("cuda", "mps", "cpu"),
        help="Override torch device. Default: let torch decide.",
    )
    # Back-compat alias kept so older callers passing --cpu still work.
    parser.add_argument("--cpu", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    device = args.device or ("cpu" if args.cpu else None)
    _set_batch_env(args.batch, device)

    try:
        # Import here, AFTER env vars, so Marker reads our batch sizes.
        from extraction import extract_both
    except Exception:
        _write_status(args.status, {
            "ok": False,
            "phase": "import",
            "error_type": "ImportError",
            "trace": traceback.format_exc(),
        })
        return 2

    try:
        with open(args.pdf, "rb") as f:
            pdf_bytes = f.read()
        pages, linear = extract_both(pdf_bytes)
        payload = {
            "pages": [p.model_dump() for p in pages],
            "linear": [b.model_dump() for b in linear],
        }
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        _write_status(args.status, {
            "ok": True,
            "batch": args.batch,
            "device": device,
        })
        return 0
    except MemoryError:
        _write_status(args.status, {
            "ok": False,
            "phase": "extract",
            "error_type": "MemoryError",
            "batch": args.batch,
            "device": device,
        })
        return 137  # convention: system RAM OOM
    except Exception as e:
        # CUDA OOM is its own torch exception type. We detect it both by
        # class name (avoids importing torch in this branch) and by message
        # substring as a defensive fallback.
        cls_name = type(e).__name__
        msg = str(e)
        is_cuda_oom = (
            cls_name in ("OutOfMemoryError", "CUDAOutOfMemoryError")
            or "CUDA out of memory" in msg
            or "CUDA error: out of memory" in msg
        )
        _write_status(args.status, {
            "ok": False,
            "phase": "extract",
            "error_type": "CUDAOutOfMemoryError" if is_cuda_oom else cls_name,
            "error_msg": msg,
            "trace": traceback.format_exc(),
            "batch": args.batch,
            "device": device,
        })
        return 138 if is_cuda_oom else 3


if __name__ == "__main__":
    sys.exit(main())
