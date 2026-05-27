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
    FullBlock,
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


# ── Paragraph continuation detection ─────────────────────────────────────────

# Debug toggle: set DEEPSTUDY_CONT_DEBUG=1 in the backend env to dump the
# decision trace for every post-pass step (continuation linking + figure
# caption merging) to stdout. Off by default.
_CONT_DEBUG = os.getenv("DEEPSTUDY_CONT_DEBUG") == "1"


def _cont_log(msg: str) -> None:
    if _CONT_DEBUG:
        print(f"[continuation] {msg}")


def _snip(text: str | None, n: int = 80) -> str:
    if not text:
        return ""
    t = text.replace("\n", " ")
    return t[:n] + ("…" if len(t) > n else "")
# Soft-break chars (hyphen / em-dash / soft hyphen). Still used by the chain
# payload builder on the frontend side to know when joining two halves should
# strip the trailing break instead of inserting a space — but no longer gate
# the continuation detection itself.
_SOFT_BREAK = frozenset('-—¬')


def _is_continuation(prev_text: str, new_text: str) -> bool:
    """True iff `new_text` should be merged with `prev_text` as a continuation.

    Rule (user-imposed, NO exceptions): the new block starts with a lowercase
    letter AND a previous block exists. How the previous block ends is
    irrelevant — punctuation, brackets, citations, terminal period: none
    block the merge. Marker emitting a paragraph that begins in lowercase is
    treated as a hard signal that the layout-split was spurious."""
    new = new_text.lstrip() if new_text else ""
    if not new:
        return False
    if not (prev_text and prev_text.strip()):
        return False
    first = new[0]
    return first.isalpha() and first.islower()


# Caption-like opener heuristic: catches paragraphs Marker missed tagging as
# Caption but that clearly belong to a neighboring figure/table/image. Covers
# English and Spanish forms, with or without a trailing number/Roman numeral:
#   "Figure 3: Architecture overview", "Table II. Results", "Fig 4 ...",
#   "Figura 1 — Esquema general", "Tabla 2", "Imagen 7", "Esquema 3",
#   "Diagrama 5", "Cuadro 4".
_CAPTION_LIKE_RE = re.compile(
    r"^(?:"
    r"figure|figura|fig\.?|"
    r"table|tabla|tab\.?|cuadro|"
    r"image|imagen|img\.?|"
    r"esquema|diagrama|schema|diagram|chart"
    r")\s*"
    r"(?:[IVXLCDM]+|\d+)?"
    r"\b",
    re.IGNORECASE,
)


def _is_caption_block_pages(b: ParagraphBlock) -> bool:
    if b.role == "caption":
        return True
    if b.role == "paragraph" and bool(
        _CAPTION_LIKE_RE.match((b.text or "").lstrip())
    ):
        return True
    return False


def _union_bbox(bs: list[BBox]) -> BBox:
    return BBox(
        x0=min(b.x0 for b in bs),
        y0=min(b.y0 for b in bs),
        x1=max(b.x1 for b in bs),
        y1=max(b.y1 for b in bs),
    )


def _merge_figure_captions_pages(pages: list[PageBlocks]) -> None:
    """Per-page mirror of `_merge_figure_captions_linear`. For each ImageBlock,
    look at adjacent ParagraphBlocks (by reading_index) to find an attached
    caption. The caption may be Marker-tagged role='caption' or a paragraph
    matching `_CAPTION_LIKE_RE` (EN + ES forms). Direction is bidirectional:
    prefers the block AFTER (typical figure layout) then BEFORE (typical
    table layout). Allows up to ±2 reading_index slots to tolerate an
    intervening image in multi-panel figures.

    When merged, the caption's text/bbox is absorbed into ImageBlock and the
    caption block is removed from `page.blocks` so the frontend overlay no
    longer hovers it as a standalone paragraph."""
    _cont_log(f"=== pages figure-caption merge start: {len(pages)} pages ===")
    for p in pages:
        block_by_ri: dict[int, ParagraphBlock] = {
            b.reading_index: b for b in p.blocks
        }
        consumed_ids: set[int] = set()
        _cont_log(f"  -- page {p.page}: {len(p.images)} images, {len(p.blocks)} blocks --")
        for img in p.images:
            ri = img.reading_index
            cap: ParagraphBlock | None = None
            found_delta = None
            for delta in (1, -1, 2, -2):
                neighbor = block_by_ri.get(ri + delta)
                if neighbor is None or id(neighbor) in consumed_ids:
                    continue
                if _is_caption_block_pages(neighbor):
                    cap = neighbor
                    found_delta = delta
                    break
            if cap is None:
                _cont_log(f"    image ri={ri} role={img.role}: no caption found")
                continue
            _cont_log(
                f"    image ri={ri} role={img.role} merge caption from delta={found_delta} "
                f"role={cap.role} text={_snip(cap.text)!r}"
            )
            img.caption_text = cap.text
            cap_bboxes = list(cap.boxes or [])
            if cap_bboxes:
                cap_union = _union_bbox(cap_bboxes)
                img.caption_bbox = cap_union
                img.bbox = BBox(
                    x0=min(img.bbox.x0, cap_union.x0),
                    y0=min(img.bbox.y0, cap_union.y0),
                    x1=max(img.bbox.x1, cap_union.x1),
                    y1=max(img.bbox.y1, cap_union.y1),
                )
            consumed_ids.add(id(cap))
        if consumed_ids:
            p.blocks = [b for b in p.blocks if id(b) not in consumed_ids]
    _cont_log("=== pages figure-caption merge end ===")


def _merge_continuations_pages(pages: list[PageBlocks]) -> None:
    """Post-pass over the per-page projection. Mirrors `_merge_continuations_
    linear`: walks every paragraph and checks against the most recent prior
    paragraph, ignoring all intervening non-paragraph blocks (caption, equation,
    code, list). Walks across page boundaries."""
    _cont_log(f"=== pages post-pass start: {len(pages)} pages ===")
    prev_para_text = ""
    for p in pages:
        _cont_log(f"  -- page {p.page}: {len(p.blocks)} blocks --")
        for i, b in enumerate(p.blocks):
            if b.role != "paragraph":
                _cont_log(f"    [{i}] skip role={b.role} text={_snip(b.text)!r}")
                continue
            fires = bool(prev_para_text and _is_continuation(prev_para_text, b.text))
            _cont_log(
                f"    [{i}] check paragraph fires={fires} "
                f"prev_end={_snip(prev_para_text[-80:] if prev_para_text else '')!r} "
                f"next_start={_snip(b.text)!r}"
            )
            if fires:
                b.continuation = True
            prev_para_text = b.text
    _cont_log("=== pages post-pass end ===")


def _is_caption_block_linear(b: FullBlock) -> bool:
    """A FullBlock that visually belongs to an adjacent figure/table: either
    Marker tagged it Caption, or it's a paragraph that opens with a caption-
    like marker (Figure/Figura/Tabla/Imagen/Esquema/Diagrama/...)."""
    if b.role == "caption":
        return True
    if b.role == "paragraph" and bool(
        _CAPTION_LIKE_RE.match((b.text or "").lstrip())
    ):
        return True
    return False


def _merge_figure_captions_linear(blocks: list[FullBlock]) -> list[FullBlock]:
    """Merge each figure/table with its caption — checked BOTH directions in
    reading order. The caption may be:
      - Marker-tagged with role='caption', or
      - A paragraph whose text matches `_CAPTION_LIKE_RE` (EN + ES forms,
        with or without numbering).

    Tables and schemes commonly put captions ABOVE the visual; figures usually
    put captions BELOW. Both layouts are handled.

    Returns a new list with the caption block removed and its text/bbox stored
    on the figure block as `caption_text` / `caption_bbox`. The figure block's
    own `bbox` is expanded to the union so a single canvas crop on the
    frontend renders figure + caption together (and so the explain raster
    sent to Gemini includes the caption text alongside the image)."""
    _cont_log(f"=== linear figure-caption merge start: {len(blocks)} blocks ===")
    consumed: set[int] = set()
    merged: list[FullBlock] = []
    for i, b in enumerate(blocks):
        if i in consumed:
            _cont_log(f"  [{i}] already consumed as caption")
            continue
        if b.role in ("figure", "table"):
            cap_idx = None
            if i + 1 < len(blocks) and i + 1 not in consumed and _is_caption_block_linear(blocks[i + 1]):
                cap_idx = i + 1
            elif i - 1 >= 0 and i - 1 not in consumed and _is_caption_block_linear(blocks[i - 1]):
                cap_idx = i - 1
                if merged and merged[-1] is blocks[i - 1]:
                    merged.pop()
            if cap_idx is not None:
                cap = blocks[cap_idx]
                _cont_log(
                    f"  [{i}] {b.role} merge caption from [{cap_idx}] role={cap.role} "
                    f"text={_snip(cap.text)!r}"
                )
                b.caption_text = cap.text
                b.caption_bbox = cap.bbox
                b.bbox = BBox(
                    x0=min(b.bbox.x0, cap.bbox.x0),
                    y0=min(b.bbox.y0, cap.bbox.y0),
                    x1=max(b.bbox.x1, cap.bbox.x1),
                    y1=max(b.bbox.y1, cap.bbox.y1),
                )
                if cap.sentences:
                    b.sentences = cap.sentences
                consumed.add(cap_idx)
            else:
                _cont_log(f"  [{i}] {b.role} no adjacent caption found")
        merged.append(b)
    _cont_log(f"=== linear figure-caption merge end: {len(merged)} blocks ({len(consumed)} captions consumed) ===")
    return merged


def _merge_continuations_linear(linear_blocks: list[FullBlock]) -> None:
    """Post-pass over the linear projection. Walks every paragraph and checks
    `_is_continuation` against the most recent prior paragraph, ignoring ALL
    intervening non-paragraph blocks (caption, equation, figure, table, code,
    list, section_header, title, author). The `_is_continuation` heuristic
    itself is strict (prev must end mid-word/alnum or soft-break, next must
    start lowercase), so the bridging behavior cannot trigger on natural
    paragraph endings."""
    _cont_log(f"=== linear post-pass start: {len(linear_blocks)} blocks ===")
    prev_para_text = ""
    for i, b in enumerate(linear_blocks):
        if b.role != "paragraph":
            _cont_log(f"  [{i}] skip role={b.role} text={_snip(b.text)!r}")
            continue
        fires = bool(prev_para_text and _is_continuation(prev_para_text, b.text))
        _cont_log(
            f"  [{i}] check paragraph fires={fires} "
            f"prev_end={_snip(prev_para_text[-80:] if prev_para_text else '')!r} "
            f"next_start={_snip(b.text)!r}"
        )
        if fires:
            b.continuation = True
        prev_para_text = b.text
    _cont_log("=== linear post-pass end ===")


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


def _collect_lines(block, document, cache: dict | None = None) -> list[LineBlock]:
    """LineBlocks for a layout block, using Marker's per-line polygons.

    Pass `cache` (dict keyed by `id(block)`) when the same document is walked
    by multiple pipelines (see `extract_both`) to avoid re-traversing Marker's
    structure for each block.
    """
    if cache is not None:
        cached = cache.get(id(block))
        if cached is not None:
            return cached

    from marker.schema import BlockTypes

    out: list[LineBlock] = []
    for ln in block.contained_blocks(document, (BlockTypes.Line,)):
        if ln.removed:
            continue
        text = _WS_RE.sub(" ", ln.raw_text(document).replace("\n", " ")).strip()
        if not text:
            continue
        out.append(LineBlock(text=text, bbox=_polygon_to_bbox(ln.polygon)))

    if cache is not None:
        cache[id(block)] = out
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
def _run_marker(pdf_bytes: bytes):
    """Write pdf_bytes to a tmp file, build a Marker Document, clean up."""
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes)
        tmp_path = tmp.name
    try:
        converter = _get_converter()
        return converter.build_document(tmp_path)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _extract_pages_from_document(document, line_cache: dict | None = None) -> list[PageBlocks]:
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
                images.append(ImageBlock(
                    bbox=bbox,
                    reading_index=reading_idx,
                    role=_role_for_image_block(bt),
                ))
                reading_idx += 1
                continue

            # SectionHeader: state-update only, never emitted as a paragraph.
            if bt == "SectionHeader":
                header_text = " ".join(
                    l.text for l in _collect_lines(block, document, line_cache)
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

            inner_lines = _collect_lines(block, document, line_cache)
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
                    role=_role_for_text_block(bt),
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


def extract_pages(pdf_bytes: bytes) -> list[PageBlocks]:
    """Parse a PDF with Marker and return per-page blocks ready for the frontend."""
    document = _run_marker(pdf_bytes)
    pages = _extract_pages_from_document(document)
    _merge_figure_captions_pages(pages)
    _merge_continuations_pages(pages)
    return pages


# ── Linear (global reading-order) extraction ─────────────────────────────────
def _role_for_text_block(bt: str) -> str:
    if bt == "Caption":
        return "caption"
    if bt == "Equation":
        return "equation"
    if bt == "Code":
        return "code"
    # Text / TextInlineMath / ListItem / ListGroup / ComplexRegion → paragraph
    return "paragraph"


def _role_for_image_block(bt: str) -> str:
    return "table" if bt == "Table" else "figure"


def _extract_linear_from_document(document, line_cache: dict | None = None) -> list[FullBlock]:
    """Walk the whole Marker document in global reading order.

    Emits a FullBlock for every layout block (title, authors, headers, paragraphs,
    captions, figures, tables, equations, code). Applies the same stop / skip /
    page-1 noise filters as the per-page pipeline, but unlike that pipeline does
    not collapse SectionHeaders into state-only events.
    """
    output: list[FullBlock] = []
    stop_content = False
    pre_abstract = True
    skip_section = False
    title_emitted = False
    reading_index = 0
    # Cross-page continuation tracker (linear projection). Mirrors the
    # per-page pipeline:
    # - `last_emitted_text` updates on every text block (paragraph, equation,
    #   caption, …) so an intervening caption-after-page-break can still anchor
    #   the next paragraph's continuation check.
    # - `cross_page_candidate` flips on at the start of a new page and is
    #   consumed by the first non-caption text block. Figures / section
    #   headers do not consume it.
    last_emitted_text = ""
    cross_page_candidate = False

    for page_idx, page in enumerate(document.pages):
        if stop_content:
            break
        page_no = page_idx + 1
        cross_page_candidate = page_idx > 0 and bool(last_emitted_text)

        for block in _iter_layout_blocks(page):
            if stop_content:
                break

            bt = _block_type_name(block)
            if bt in _DROP_TYPES:
                continue

            bbox = _polygon_to_bbox(block.polygon)

            # SectionHeader: emit (as title / author / section_header) unless
            # it's a stop or skip header, which we still consume for state.
            if bt == "SectionHeader":
                header_text = " ".join(
                    l.text for l in _collect_lines(block, document, line_cache)
                ).strip()
                if not header_text:
                    continue
                if _is_stop_header(header_text):
                    stop_content = True
                    break
                if _is_skip_section(header_text):
                    skip_section = True
                    continue
                # First SectionHeader on page 1 is the paper title — even when
                # its text happens to match a body-section regex (rare but
                # possible, e.g. preprints whose first labeled block is the
                # word "Abstract"). Still apply body-section side-effects in
                # that overlap so subsequent text is processed correctly.
                if page_idx == 0 and not title_emitted:
                    role = "title"
                    title_emitted = True
                    if _is_body_section_name(header_text):
                        skip_section = False
                        pre_abstract = False
                elif _is_body_section_name(header_text):
                    skip_section = False
                    pre_abstract = False
                    role = "section_header"
                elif page_idx == 0 and pre_abstract and (
                    _is_soft_noise(header_text)
                    or _looks_like_author_line(header_text)
                ):
                    role = "author"
                else:
                    role = "section_header"
                output.append(
                    FullBlock(
                        role=role,
                        text=header_text,
                        page=page_no,
                        bbox=bbox,
                        reading_index=reading_index,
                    )
                )
                reading_index += 1
                continue

            if bt in _IMAGE_TYPES:
                output.append(
                    FullBlock(
                        role=_role_for_image_block(bt),
                        text="",
                        page=page_no,
                        bbox=bbox,
                        reading_index=reading_index,
                    )
                )
                reading_index += 1
                continue

            if bt not in _TEXT_TYPES:
                continue
            if skip_section:
                continue

            inner_lines = _collect_lines(block, document, line_cache)
            text = " ".join(l.text for l in inner_lines).strip()
            if not text or len(text.split()) < 3:
                continue

            if _is_stop_header(text):
                stop_content = True
                break

            role = _role_for_text_block(bt)

            if page_idx == 0:
                if _is_hard_noise(text):
                    continue
                if pre_abstract and (
                    _is_soft_noise(text) or _looks_like_author_line(text)
                ):
                    role = "author"

            sentences = (
                _build_sentences(text, inner_lines) if role == "paragraph" else []
            )

            is_continuation = (
                role == "paragraph"
                and cross_page_candidate
                and _is_continuation(last_emitted_text, text)
            )
            # Captions on a new page do not consume the cross-page candidate
            # state (a figure caption leading a page is not a paragraph tail),
            # but their text still updates `last_emitted_text` so a later
            # paragraph on the same page can check continuation against it —
            # same behaviour as the per-page pipeline.
            if role != "caption":
                cross_page_candidate = False

            output.append(
                FullBlock(
                    role=role,
                    text=text,
                    page=page_no,
                    bbox=bbox,
                    reading_index=reading_index,
                    sentences=sentences,
                    continuation=is_continuation,
                )
            )
            reading_index += 1
            last_emitted_text = text

        if page_idx == 0:
            pre_abstract = False

    return output


def extract_linear_blocks(pdf_bytes: bytes) -> list[FullBlock]:
    """Parse a PDF with Marker and return all blocks in global reading order."""
    document = _run_marker(pdf_bytes)
    blocks = _extract_linear_from_document(document)
    blocks = _merge_figure_captions_linear(blocks)
    _merge_continuations_linear(blocks)
    return blocks


def extract_both(
    pdf_bytes: bytes,
) -> tuple[list[PageBlocks], list[FullBlock]]:
    """Run Marker once; return both the per-page and linear projections.

    Both pipelines walk the same blocks and need their line geometry, so a
    shared `line_cache` (keyed by `id(block)`) is threaded through to halve
    the line-collection work.
    """
    document = _run_marker(pdf_bytes)
    line_cache: dict[int, list[LineBlock]] = {}
    pages  = _extract_pages_from_document(document, line_cache)
    linear = _extract_linear_from_document(document, line_cache)
    linear = _merge_figure_captions_linear(linear)
    _merge_figure_captions_pages(pages)
    _merge_continuations_pages(pages)
    _merge_continuations_linear(linear)
    return pages, linear
