"""Debug: list every top-level layout block on page 1 with type + first text."""
import re
import tempfile
from pathlib import Path

from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.schema import BlockTypes


def main():
    pdf_path = (
        Path("uploads")
        / "F2 - Optically connected and reconfigurable GPU architecture for optimized peer-to-peer access.pdf"
    )
    pdf_bytes = pdf_path.read_bytes()

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes)
        tmp_path = tmp.name

    converter = PdfConverter(
        artifact_dict=create_model_dict(),
        config={"disable_image_extraction": True},
    )
    document = converter.build_document(tmp_path)

    print(f"pages: {len(document.pages)}")
    for pi, page in enumerate(document.pages[:2]):
        print(f"\n=== page {pi+1} polygon={page.polygon.bbox} ===")
        for bi, bid in enumerate(page.structure or []):
            block = page.get_block(bid)
            if block is None:
                continue
            bt = block.block_type.name if block.block_type else "?"
            lines = block.contained_blocks(document, (BlockTypes.Line,))
            txt_parts = [
                ln.raw_text(document).strip().replace("\n", " ")
                for ln in lines
                if not ln.removed
            ]
            txt = re.sub(r"\s+", " ", " ".join(txt_parts))
            removed = " REMOVED" if block.removed else ""
            print(f"  [{bi:>2}] {bt:<18} ({len(lines)} lines){removed} | {txt[:90]!r}")


if __name__ == "__main__":
    main()
