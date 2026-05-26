"""Smoke test for extract_linear_blocks: prints first 30 blocks of the linear stream."""
import sys
from pathlib import Path

from extraction import extract_linear_blocks


def main():
    if len(sys.argv) < 2:
        pdf_path = Path("uploads") / "F2 - Optically connected and reconfigurable GPU architecture for optimized peer-to-peer access.pdf"
    else:
        pdf_path = Path(sys.argv[1])

    if not pdf_path.exists():
        print(f"PDF not found: {pdf_path}")
        sys.exit(1)

    print(f"Extracting linear blocks: {pdf_path.name}")
    pdf_bytes = pdf_path.read_bytes()
    blocks = extract_linear_blocks(pdf_bytes)

    print(f"\n{len(blocks)} linear blocks total\n")
    for b in blocks[:30]:
        preview = b.text[:90].replace("\n", " ") if b.text else "—"
        print(
            f"  ri={b.reading_index:>3} p{b.page:>2} {b.role:<16} | {preview}"
        )


if __name__ == "__main__":
    main()
