"""Smoke test for extraction.py — verifica que Marker produzca PageBlocks válidos."""
import sys
import json
from pathlib import Path

from extraction import extract_pages


def main():
    if len(sys.argv) < 2:
        # Default to test PDF
        pdf_path = Path("uploads") / "F2 - Optically connected and reconfigurable GPU architecture for optimized peer-to-peer access.pdf"
    else:
        pdf_path = Path(sys.argv[1])

    if not pdf_path.exists():
        print(f"PDF not found: {pdf_path}")
        sys.exit(1)

    print(f"Extracting: {pdf_path.name}")
    pdf_bytes = pdf_path.read_bytes()
    pages = extract_pages(pdf_bytes)

    print(f"\n{len(pages)} pages extracted\n")
    for p in pages:
        print(f"=== page {p.page} ({p.width:.0f} x {p.height:.0f}) ===")
        print(f"  blocks: {len(p.blocks)}, images: {len(p.images)}")
        for b in p.blocks:
            text_preview = b.text[:80].replace("\n", " ")
            cont = " CONT" if b.continuation else "     "
            print(
                f"  ri={b.reading_index:>2} sents={len(b.sentences):>2}{cont} | {text_preview}"
            )
        for im in p.images:
            bb = im.bbox
            print(f"  ri={im.reading_index:>2} IMG ({bb.x0:.0f},{bb.y0:.0f},{bb.x1:.0f},{bb.y1:.0f})")


if __name__ == "__main__":
    main()
