"""PDF layout extraction backed by Marker (Document object, no JSON render).

Marker's layout-detection models classify each block (Text, SectionHeader,
Caption, Figure, ...) and group child Lines and Spans with precise polygon
data. This module bypasses the JSONRenderer and walks
`document.pages[i].structure` directly, which yields:

- Line-level polygons, enabling precise sentence bounding boxes without
  re-parsing the PDF.
- No BeautifulSoup pass and no content-ref unfolding.
- No additional PyMuPDF read for line geometry.

Filters (these blocks never reach the frontend payload nor the Gemini prompt):

- PageHeader / PageFooter / Footnote / Reference / TableOfContents /
  Handwriting / Form: dropped by block type (Marker labels these natively).
- SectionHeader (ALL): section and subsection titles are never emitted as
  paragraphs. This covers the paper title, "1 Introduction", "2.1 Architecture",
  and so on. The header text is still consumed to drive internal state:
  detecting Acknowledgments triggers stop-content; CCS or Keywords sections
  enable body-skip; canonical body-section names reopen content. When Marker
  mislabels an author line as a SectionHeader, the line is dropped as well,
  since no SectionHeader is ever emitted.
- Author and affiliation blocks classified as Text on page 1 before the first
  body section: email, "@", "University of", "Institute", "School of", and
  lines composed mostly of Title Case tokens.
- Page-1 metadata blocks: copyright (©), "Permission to make", DOI/ISBN,
  "ACM Reference Format", "arXiv", "preprint", venue boilerplate.
- "CCS Concepts" / "Keywords" / "Index Terms" / "Categories and Subject
  Descriptors" / "ACM Reference Format" sections: the header is dropped and
  every block in the body is skipped until the next body-section header.
- All content after a SectionHeader matching "Acknowledgments" / "References"
  / "Bibliography" / "Works Cited" (stop-content).

Cross-page paragraph merge: when the first non-Caption paragraph on page N
(N > 0) satisfies the two-rule heuristic — the previous paragraph does not
end with `.!?…` and the new one begins with a lowercase letter — it is
flagged with `continuation=True`. Downstream code (see `main.py`) joins
continuations with the previous paragraph when assembling the `full_text`
payload that is sent to Gemini.
"""
import os
import re
import tempfile
from threading import Lock

from models import (
    BBox,
    ImageBlock,
    LineBlock,
    PageBlocks,
    ParagraphBlock,
    SentenceBlock,
)

# ── Marker singleton ─────────────────────────────────────────────────────────
_marker_converter = None
_marker_lock = Lock()


def _get_converter():
    global _marker_converter
    with _marker_lock:
        if _marker_converter is None:
            from marker.converters.pdf import PdfConverter
            from marker.models import create_model_dict

            _marker_converter = PdfConverter(
                artifact_dict=create_model_dict(),
                config={"disable_image_extraction": True},
            )
        return _marker_converter


# ── Block-type buckets ───────────────────────────────────────────────────────
# SectionHeader is intentionally excluded: section / subsection names are not
# emitted as paragraphs (they're recognized for state tracking but dropped).
_TEXT_TYPES = frozenset({
    "Text",
    "TextInlineMath",
    "ListItem",
    "ListGroup",
    "Caption",
    "Code",
    "Equation",
    "ComplexRegion",
})

_IMAGE_TYPES = frozenset({"Figure", "Picture", "Table"})

_DROP_TYPES = frozenset({
    "PageHeader",
    "PageFooter",
    "Footnote",
    "Reference",
    "TableOfContents",
    "Handwriting",
    "Form",
})

_GROUP_TYPES = frozenset({"FigureGroup", "PictureGroup", "TableGroup"})


# ── Section-header classification ────────────────────────────────────────────
_STOP_SECTION_RE = re.compile(
    r"^\s*(?:\d+[\.\s]+)?"
    r"(acknowledg(?:e)?ments?|references?|bibliography|works?\s+cited)"
    r"\b[\s:.]*$",
    re.IGNORECASE,
)

# Section headers whose CONTENT must be skipped (boilerplate sections that
# precede or follow the abstract on conference templates).
_SKIP_SECTION_RE = re.compile(
    r"^\s*(ccs\s+concepts?|keywords?|key\s+words?|index\s+terms?|"
    r"categories\s+and\s+subject\s+descriptors|"
    r"acm\s+reference\s+format|general\s+terms?)"
    r"\b[\s:.]*$",
    re.IGNORECASE,
)

# Canonical body-section names. If a SectionHeader matches, it's a real
# section — not the document title, not a skip section.
_BODY_SECTION_RE = re.compile(
    r"^\s*(?:\d+(?:\.\d+)*[\.\s]+)*"
    r"(abstract|introduction|background|related\s+work|prior\s+work|"
    r"motivation|methods?|methodology|materials\s+and\s+methods|"
    r"experiments?|experimental\s+(?:setup|results?|evaluation|methodology)|"
    r"results?|evaluation|analysis|"
    r"discussion|conclusion|conclusions?(?:\s+and\s+(?:future|proposed)\s+work)?|"
    r"future\s+work|summary|"
    r"appendix|preliminaries|notation|problem\s+statement|"
    r"overview|design|implementation|architecture|system\s+(?:design|model|architecture)|"
    r"approach|proposed\s+(?:method|approach|system)|"
    r"limitations|threats\s+to\s+validity)\b",
    re.IGNORECASE,
)


def _is_stop_header(text: str) -> bool:
    return bool(_STOP_SECTION_RE.match(text.strip()))


def _is_skip_section(text: str) -> bool:
    return bool(_SKIP_SECTION_RE.match(text.strip()))


def _is_body_section_name(text: str) -> bool:
    return bool(_BODY_SECTION_RE.match(text.strip()))


# ── Page-1 noise heuristics ──────────────────────────────────────────────────
# Hard signals: copyright / ISBN / DOI / preprint / ACM-IEEE boilerplate.
# Drops anywhere on page 1, regardless of length.
_HARD_NOISE_RE = re.compile(
    r"(\bpermission\s+to\s+(?:make|copy|reproduce|distribute)\b|"
    r"©\s*\d{4}|\bcopyright\s+(?:held|notice|\d{4})|"
    r"\b(?:acm|ieee)\s+(?:reference\s+format|copyright)\b|"
    r"\bisbn\s*[\d\-]+|\bdoi[\.:\s]+\S+|\bdoi\.org\b|"
    r"\barxiv(?:\.org)?\b|\bpreprint\b|\bunder\s+review\b|"
    r"\bsubmitted\s+to\b|\bpublication\s+rights\b|"
    r"\bcc\s+by(?:[- ]\w+)*\b)",
    re.IGNORECASE,
)

# Soft signals: author / affiliation / venue. Applied only to short page-1
# blocks before the first body-section header (the masthead region).
_SOFT_NOISE_RE = re.compile(
    r"(@|\buniversit(?:y|ies)\b|\binstitute\b|\bdepartment\b|\bcollege\b|"
    r"\baffiliation\b|\bschool\s+of\b|\blab(?:oratory|oratories)?\b|"
    r"\b(?:e-?mail|correspondence|corresponding\s+author)\b|"
    r"\bproceedings\s+of\b|\bconference\s+on\b|\bin\s+proceedings\b|"
    r"\bworkshop\s+on\b)",
    re.IGNORECASE,
)

# A proper-noun token: "Alice", "O'Brien", "García-López", "MEMSYS".
_PROPER_NOUN_RE = re.compile(r"^[A-ZÁÉÍÓÚÑÜ][\w'’\-]*$", re.UNICODE)


def _is_hard_noise(text: str) -> bool:
    return bool(_HARD_NOISE_RE.search(text))


def _is_soft_noise(text: str) -> bool:
    words = text.split()
    return len(words) <= 60 and bool(_SOFT_NOISE_RE.search(text))


def _looks_like_author_line(text: str) -> bool:
    """Short, title-cased line with no sentence structure — likely a name list."""
    words = text.split()
    if not (1 <= len(words) <= 18):
        return False
    if text.count(".") > 2 or text.count(";") > 2:
        return False
    proper = sum(1 for w in words if _PROPER_NOUN_RE.match(w))
    # Allow a few connectors ("and", "of", "the", "&", and their Spanish
    # equivalents such as "y", "de", which can appear in author lists).
    return proper >= max(2, len(words) - 4)


# ── Cross-page continuation detection ────────────────────────────────────────
_TERMINAL_PUNCT = frozenset('.!?…')


def _is_continuation(prev_text: str, new_text: str) -> bool:
    """True if `new_text` is the cross-page tail of `prev_text`."""
    prev = prev_text.rstrip()
    new = new_text.lstrip()
    if not prev or not new:
        return False
    if prev[-1] in _TERMINAL_PUNCT:
        return False
    first = new[0]
    return first.isalpha() and first.islower()


# ── Sentence segmentation ────────────────────────────────────────────────────
_SENT_BOUNDARY_RE = re.compile(r'(?<=[.!?…])\s+(?=[A-ZÁÉÍÓÚÑ¿¡"\(])')


def _split_sentences(text: str) -> list[tuple[str, int, int]]:
    spans: list[tuple[str, int, int]] = []
    cursor = 0
    for m in _SENT_BOUNDARY_RE.finditer(text):
        end = m.start()
        s = cursor
        while s < end and text[s].isspace():
            s += 1
        if s < end:
            spans.append((text[s:end], s, end))
        cursor = m.end()
    if cursor < len(text):
        s = cursor
        while s < len(text) and text[s].isspace():
            s += 1
        if s < len(text):
            spans.append((text[s:], s, len(text)))
    return spans


def _sentence_boxes(
    visual_lines: list[LineBlock], sent_start: int, sent_end: int
) -> list[BBox]:
    boxes: list[BBox] = []
    cursor = 0
    for line in visual_lines:
        ln_len = len(line.text)
        ln_start = cursor
        ln_end = cursor + ln_len
        cursor = ln_end + 1  # +1 for the join space inserted between lines

        ovl_s = max(sent_start, ln_start)
        ovl_e = min(sent_end, ln_end)
        if ovl_e <= ovl_s or ln_len == 0:
            continue

        local_s = ovl_s - ln_start
        local_e = ovl_e - ln_start

        bb = line.bbox
        line_w = bb.x1 - bb.x0
        ratio = line_w / ln_len
        new_x0 = bb.x0 + local_s * ratio
        new_x1 = bb.x0 + local_e * ratio

        boxes.append(
            BBox(
                x0=round(new_x0, 2),
                y0=round(bb.y0, 2),
                x1=round(new_x1, 2),
                y1=round(bb.y1, 2),
            )
        )
    return boxes


def _build_sentences(text: str, visual_lines: list[LineBlock]) -> list[SentenceBlock]:
    if not visual_lines:
        return []
    out: list[SentenceBlock] = []
    for sent_text, s, e in _split_sentences(text):
        boxes = _sentence_boxes(visual_lines, s, e)
        if boxes:
            out.append(SentenceBlock(text=sent_text, boxes=boxes))
    return out


# ── Marker Document accessors ────────────────────────────────────────────────
def _polygon_to_bbox(polygon) -> BBox:
    bb = polygon.bbox  # [x0, y0, x1, y1]
    return BBox(
        x0=round(bb[0], 2),
        y0=round(bb[1], 2),
        x1=round(bb[2], 2),
        y1=round(bb[3], 2),
    )


def _block_type_name(block) -> str:
    bt = getattr(block, "block_type", None)
    return bt.name if bt is not None else ""


_WS_RE = re.compile(r"\s+")


def _collect_lines(block, document) -> list[LineBlock]:
    """LineBlocks for a layout block, using Marker's per-line polygons."""
    from marker.schema import BlockTypes

    out: list[LineBlock] = []
    for ln in block.contained_blocks(document, (BlockTypes.Line,)):
        if ln.removed:
            continue
        text = _WS_RE.sub(" ", ln.raw_text(document).replace("\n", " ")).strip()
        if not text:
            continue
        out.append(LineBlock(text=text, bbox=_polygon_to_bbox(ln.polygon)))
    return out


def _iter_layout_blocks(page):
    """Yield page top-level layout blocks in reading order, unwrapping groups."""
    if not page.structure:
        return
    for bid in page.structure:
        block = page.get_block(bid)
        if block is None or block.removed:
            continue
        if _block_type_name(block) in _GROUP_TYPES and block.structure:
            for child_id in block.structure:
                child = page.get_block(child_id)
                if child and not child.removed:
                    yield child
        else:
            yield block


# ── Main entry point ─────────────────────────────────────────────────────────
def extract_pages(pdf_bytes: bytes) -> list[PageBlocks]:
    """Parse a PDF with Marker and return per-page blocks ready for the frontend."""
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes)
        tmp_path = tmp.name

    try:
        converter = _get_converter()
        document = converter.build_document(tmp_path)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    output: list[PageBlocks] = []
    stop_content = False
    pre_abstract = True  # page-1 masthead window (authors/affiliations live here)
    last_emitted_text = ""  # text of the most recent paragraph (cross-page tracker)

    for page_idx, page in enumerate(document.pages):
        if stop_content:
            break

        # skip_section is page-scoped: a CCS/Keywords boilerplate region never
        # legitimately spans pages.
        skip_section = False
        # Cross-page continuation only fires on the first non-Caption paragraph
        # of a new page (figures captioning frequently lead a page but are not
        # paragraph continuations themselves).
        cross_page_candidate = page_idx > 0 and bool(last_emitted_text)

        page_w = page.polygon.width
        page_h = page.polygon.height

        paragraphs: list[ParagraphBlock] = []
        images: list[ImageBlock] = []
        reading_idx = 0

        for block in _iter_layout_blocks(page):
            if stop_content:
                break

            bt = _block_type_name(block)
            if bt in _DROP_TYPES:
                continue

            bbox = _polygon_to_bbox(block.polygon)

            if bt in _IMAGE_TYPES:
                images.append(ImageBlock(bbox=bbox, reading_index=reading_idx))
                reading_idx += 1
                continue

            # SectionHeader: state-update only, never emitted as a paragraph.
            if bt == "SectionHeader":
                header_text = " ".join(
                    l.text for l in _collect_lines(block, document)
                ).strip()
                if not header_text:
                    continue
                if _is_stop_header(header_text):
                    stop_content = True
                    break
                if _is_skip_section(header_text):
                    skip_section = True
                elif _is_body_section_name(header_text):
                    skip_section = False
                    pre_abstract = False
                continue

            if bt not in _TEXT_TYPES:
                continue
            if skip_section:
                continue

            inner_lines = _collect_lines(block, document)
            text = " ".join(l.text for l in inner_lines).strip()
            if not text or len(text.split()) < 3:
                continue

            if _is_stop_header(text):
                stop_content = True
                break

            # Page-1 noise filters.
            if page_idx == 0:
                if _is_hard_noise(text):
                    continue
                if pre_abstract and (
                    _is_soft_noise(text) or _looks_like_author_line(text)
                ):
                    continue

            is_cont = (
                cross_page_candidate
                and bt != "Caption"
                and _is_continuation(last_emitted_text, text)
            )
            if bt != "Caption":
                cross_page_candidate = False

            sentences = _build_sentences(text, inner_lines)

            paragraphs.append(
                ParagraphBlock(
                    text=text,
                    boxes=[bbox],
                    sentences=sentences,
                    reading_index=reading_idx,
                    continuation=is_cont,
                )
            )
            reading_idx += 1
            last_emitted_text = text

        if page_idx == 0:
            pre_abstract = False

        output.append(
            PageBlocks(
                page=page_idx + 1,
                width=round(page_w, 2),
                height=round(page_h, 2),
                blocks=paragraphs,
                images=images,
            )
        )

    return output
