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
import sys
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
_marker_converter_config_key: tuple | None = None
_marker_lock = Lock()


def _get_converter(*, disable_ocr: bool = False):
    """Marker converter cached per (disable_ocr,) config.

    When `disable_ocr=True`, Surya recognition is skipped and the PDF's native
    text layer is used directly. This is ~50-200× faster than running the OCR
    transformer and is safe for any PDF whose `extract_text()` returns content
    on every page (typical for ACM/IEEE papers).
    """
    global _marker_converter, _marker_converter_config_key
    key = (bool(disable_ocr),)
    with _marker_lock:
        if _marker_converter is None or _marker_converter_config_key != key:
            from marker.converters.pdf import PdfConverter
            from marker.models import create_model_dict

            cfg = {"disable_image_extraction": True}
            if disable_ocr:
                cfg["disable_ocr"] = True
                cfg["force_ocr"] = False
            _marker_converter = PdfConverter(
                artifact_dict=create_model_dict(),
                config=cfg,
            )
            _marker_converter_config_key = key
        return _marker_converter


def has_native_text_layer(pdf_bytes: bytes, *, min_chars_per_page: int = 50) -> bool:
    """True if every page of the PDF has an embedded text layer above the
    threshold. Used to skip Surya OCR entirely on text-native PDFs.

    Returns False on the first page that lacks text or on any read error —
    conservative: if in doubt, run the full OCR pipeline.
    """
    try:
        import fitz  # PyMuPDF
        with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
            if doc.page_count == 0:
                return False
            for page in doc:
                text = page.get_text("text") or ""
                if len(text.strip()) < min_chars_per_page:
                    return False
        return True
    except Exception:
        return False


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

# Same stop sections, but glued to their body text on one line. Marker often
# emits "Acknowledgments. This work was supported by …" as a single paragraph
# rather than a standalone SectionHeader, so the end-anchored regex above misses
# it. Require the stop word at the very start (optional Arabic/Roman section
# number) followed by sentence punctuation + body, so a mid-sentence "…we
# acknowledge that…" or "References [1] show…" never trips it.
_STOP_SECTION_INLINE_RE = re.compile(
    r"^(?:(?:\d+|[ivxlcdm]+)[.\s]+)?"
    r"(?:acknowledg(?:e)?ments?|references?|bibliography|works?\s+cited)"
    r"\s*[.:—]\s+\S",
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
    t = text.strip()
    return bool(_STOP_SECTION_RE.match(t) or _STOP_SECTION_INLINE_RE.match(t))


def _is_skip_section(text: str) -> bool:
    return bool(_SKIP_SECTION_RE.match(text.strip()))


def _is_body_section_name(text: str) -> bool:
    return bool(_BODY_SECTION_RE.match(text.strip()))


# ── Page-1 noise heuristics ──────────────────────────────────────────────────
# Hard signals: copyright / ISBN / DOI / preprint / ACM-IEEE boilerplate.
# Drops anywhere on page 1, regardless of length.
_HARD_NOISE_RE = re.compile(
    r"(\bpermission\s+to\s+(?:make|copy|reproduce|distribute)\b|"
    r"\b(?:acm|ieee)\s+(?:reference\s+format|copyright)\b|"
    r"\bisbn\s*[\d\-]+|\bdoi[\.:\s]+\S+|\bdoi\.org\b|"
    r"\barxiv(?:\.org)?\b|\bpreprint\b|\bunder\s+review\b|"
    r"\bsubmitted\s+to\b|\bpublication\s+rights\b)",
    re.IGNORECASE,
)

# License / copyright signals — dropped on ANY page (license footers, CC
# banners, and "this work is licensed under …" boilerplate frequently repeat
# on body pages, not just the masthead). Kept separate from _HARD_NOISE_RE
# so the page-1-only filters above don't widen scope inadvertently.
_LICENSE_NOISE_RE = re.compile(
    r"(\bcreative\s+commons\b|"
    r"\bcc\s+by(?:[- ]?(?:nc|sa|nd))*(?:\s+\d+(?:\.\d+)?)?\b|"
    r"\battribution(?:[- ](?:non[- ]?commercial|share[- ]?alike|no[- ]?derivatives))*"
    r"\s+\d+(?:\.\d+)?\s+international(?:\s+license)?\b|"
    r"\b(?:licen[sc]ed?|distributed|made\s+available)\s+under\s+"
    r"(?:a\s+|the\s+)?(?:creative\s+commons|cc\s+by|gnu|mit|bsd|apache|gpl)\b|"
    r"\bcreativecommons\.org\S*|"
    r"©\s*\d{4}|\(c\)\s*\d{4}|"
    r"\bcopyright\s+(?:©|\(c\))?\s*(?:held|notice|\d{4}))",
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


def _is_license_noise(text: str) -> bool:
    return bool(_LICENSE_NOISE_RE.search(text))


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


# Affiliation-superscript / list punctuation stripped off each token before the
# proper-noun test ("Sun1" → "Sun", "Jouppi," → "Jouppi", "A." → "A").
_NAME_STRIP_CHARS = "0123456789.,;:*†‡§¶∗·¹²³⁴⁵⁶⁷⁸⁹⁰()[]{}"


def _is_dense_name_list(text: str) -> bool:
    """A run of mostly Title-Case proper-noun tokens with no prose — an author
    name list of ANY length (no 18-word cap, unlike `_looks_like_author_line`).
    Used to keep long author lines out of the body-paragraph anchor that fixes
    the masthead floor: an abstract is lowercase-heavy prose (low proper-noun
    fraction), a names line is ~all proper nouns even when it runs past a
    dozen authors."""
    words = text.split()
    if len(words) < 4:
        return False
    proper = sum(
        1 for w in words
        if (t := w.strip(_NAME_STRIP_CHARS)) and _PROPER_NOUN_RE.match(t)
    )
    return proper >= 0.6 * len(words)


# ── Paragraph continuation detection ─────────────────────────────────────────

# Debug toggle: set DEEPSTUDY_CONT_DEBUG=1 in the backend env to dump the
# decision trace for every post-pass step (continuation linking + figure
# caption merging) to stdout. Off by default.
_CONT_DEBUG = os.getenv("DEEPSTUDY_CONT_DEBUG") == "1"

# Debug toggle: set DEEPSTUDY_EXTRACT_DEBUG=1 to log every block Marker yields
# during linear extraction — including blocks that are filtered out — with their
# type, bbox y-range, and reason for being kept or discarded. Use this to find
# content that Marker produced but the pipeline dropped (or content Marker never
# produced at all, visible as gaps in the y-range sequence).
_EXTRACT_DEBUG = os.getenv("DEEPSTUDY_EXTRACT_DEBUG") == "1"


def _cont_log(msg: str) -> None:
    if _CONT_DEBUG:
        print(f"[continuation] {msg}")


def _extract_log(msg: str) -> None:
    if _EXTRACT_DEBUG:
        print(f"[extract] {msg}", file=sys.stderr, flush=True)


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


# Absorbs bbox rounding / antialias noise when comparing block edges (PDF points).
_GEOM_TOL = 2.0
# Max vertical gap (in line heights) between a paragraph's bottom and its
# continuation's top within the same column. A real mid-paragraph split is
# nearly touching (~0 lines); anything larger means another block sits between
# them, so they are not sequential and must not merge.
_MAX_CONT_GAP_LINES = 1.5


def _estimate_line_height(boxes: list[BBox]) -> float:
    """Median height of per-line boxes. 0.0 when no usable boxes."""
    hs = sorted(b.y1 - b.y0 for b in boxes if b.y1 - b.y0 > 0)
    if not hs:
        return 0.0
    return hs[len(hs) // 2]


# ── Footnote-by-font detection ───────────────────────────────────────────────
# Marker sometimes labels a real footnote as body "Text", so it slips past
# `_DROP_TYPES` and surfaces as a paragraph. Footnotes are set in a smaller
# font than the body and sit at the column bottom — require BOTH so a normal
# last paragraph or a mid-column small block is never dropped.
_BODY_TEXT_TYPES = frozenset({"Text", "TextInlineMath", "ListItem", "ListGroup"})
_FOOTNOTE_FONT_RATIO = 0.82   # block line height ≤ this × body line height → small


def _page_footnote_context(page, document, line_cache=None):
    """Per-page (body_line_height, [body-sized block bboxes]) for footnote-by-
    font detection. The body line height is the median over all body-text lines
    (a font-size proxy); `body_bboxes` holds only blocks whose own font is body-
    sized, so a footnote stacked above another footnote isn't kept alive by the
    smaller block beneath it."""
    rows: list[tuple[list, float]] = []  # (line bboxes, block median height)
    heights: list[float] = []
    for block in _iter_layout_blocks(page):
        if _block_type_name(block) not in _BODY_TEXT_TYPES:
            continue
        lines = _collect_lines(block, document, line_cache)
        hs = [l.bbox.y1 - l.bbox.y0 for l in lines if l.bbox.y1 - l.bbox.y0 > 0]
        if not hs:
            continue
        heights.extend(hs)
        rows.append(([l.bbox for l in lines], sorted(hs)[len(hs) // 2]))
    heights.sort()
    body_lh = heights[len(heights) // 2] if heights else 0.0
    body_bboxes = [
        _union_bbox(boxes)
        for boxes, blk_lh in rows
        if body_lh > 0 and blk_lh >= _FOOTNOTE_FONT_RATIO * body_lh
    ]
    return body_lh, body_bboxes


def _is_footnote_by_font(inner_lines, bbox: BBox, body_lh: float, body_bboxes) -> bool:
    """True when a body Text block is really a footnote: its font is clearly
    smaller than the body AND nothing body-sized sits below it in the same
    column (i.e. it is the trailing block of its column)."""
    if body_lh <= 0 or not inner_lines:
        return False
    lh = _estimate_line_height([l.bbox for l in inner_lines])
    if lh <= 0 or lh > _FOOTNOTE_FONT_RATIO * body_lh:
        return False
    for bb in body_bboxes:
        if bb.y0 > bbox.y1 - _GEOM_TOL and _x_overlaps(bbox.x0, bbox.x1, bb.x0, bb.x1):
            return False  # body text continues below → mid-column, not a footnote
    return True


def _column_kind(bbox: BBox, bounds: tuple[float, float]) -> str:
    """Classify a block's horizontal placement on its page: 'full' (spans the
    content width — single-column / full-width), 'left' (left column), 'right'
    (right column), or 'other' (ambiguous). `bounds` is the page's
    (min_x0, max_x1) over all blocks."""
    min_x0, max_x1 = bounds
    w = max_x1 - min_x0
    if w <= 0:
        return "full"
    if (bbox.x1 - bbox.x0) >= 0.75 * w:
        return "full"
    mid = min_x0 + w / 2
    if bbox.x1 <= mid + 0.12 * w:
        return "left"
    if bbox.x0 >= mid - 0.12 * w:
        return "right"
    return "other"


def _cross_page_columns_ok(
    prev_bbox: BBox,
    prev_bounds: tuple[float, float],
    next_bbox: BBox,
    next_bounds: tuple[float, float],
) -> bool:
    """A cross-page continuation flows from the LAST column of page A (bottom)
    to the FIRST column of page B (top). So prev must be the page-A tail —
    right column (multi-col) or full width (single-col) — and next the page-B
    head — left column or full width. Same-side links (both left, both right)
    are nonsensical across a page break and rejected."""
    pk = _column_kind(prev_bbox, prev_bounds)
    nk = _column_kind(next_bbox, next_bounds)
    return pk in ("right", "full") and nk in ("left", "full")


def _accumulate_bounds(
    bounds: dict[int, tuple[float, float]], page: int, x0: float, x1: float
) -> None:
    mn, mx = bounds.get(page, (x0, x1))
    bounds[page] = (min(mn, x0), max(mx, x1))


def _page_x_bounds_linear(blocks: list) -> dict[int, tuple[float, float]]:
    """Per-page (min_x0, max_x1) content span across all linear blocks."""
    bounds: dict[int, tuple[float, float]] = {}
    for b in blocks:
        _accumulate_bounds(bounds, b.page, b.bbox.x0, b.bbox.x1)
    return bounds


def _page_x_bounds_pages(pages: list) -> dict[int, tuple[float, float]]:
    """Per-page (min_x0, max_x1) content span across per-page blocks + images."""
    bounds: dict[int, tuple[float, float]] = {}
    for p in pages:
        for b in p.blocks:
            if b.boxes:
                ub = _union_bbox(b.boxes)
                _accumulate_bounds(bounds, p.page, ub.x0, ub.x1)
        for img in p.images:
            _accumulate_bounds(bounds, p.page, img.bbox.x0, img.bbox.x1)
    return bounds


def _continuation_geometry_ok(
    prev_bbox: BBox,
    prev_page: int,
    next_bbox: BBox,
    next_page: int,
    line_h: float = 0.0,
    intervening: list[BBox] = (),
    prev_bounds: tuple[float, float] | None = None,
    next_bounds: tuple[float, float] | None = None,
) -> bool:
    """Geometric gate layered on top of the lexical `_is_continuation` check.

    `_is_continuation` fires on any lowercase-starting paragraph, with zero
    geometry. In multi-column layouts that over-merges: a lowercase fragment
    high in the left column chains to one mid-right-column, etc. This gate keeps
    only mergers whose physical arrangement is a real, sequential text flow:

    - cross-page: prev must be page A's last column (right / full width) and
      next page B's first column (left / full width). Same-side links across a
      break (both left, both right) are rejected. Needs `prev_bounds` /
      `next_bounds` (per-page (min_x0, max_x1)); without them any forward page
      step is allowed;
    - same column (x-overlap ≥ 50%): next sits just below prev — downward AND
      within `_MAX_CONT_GAP_LINES` line heights of EMPTY space. The gap is
      measured excluding any intervening floats (figure / table / equation /
      caption) that the paragraph legitimately flows around, so a real
      float-interrupted continuation still merges while a jump over genuinely
      empty space (scrambled order / dropped block) does not;
    - different column, same page: ONLY the genuine column wrap — next is to the
      right of prev AND jumps upward to the top of the next column
      (next.y0 < prev.y0). Rejects high-left ↔ mid-right style bad mergers.

    `line_h` is the typical line height of the two blocks; when 0 (unmeasurable)
    the same-column gap cap is skipped and only the downward rule applies.
    `intervening` are bboxes of non-paragraph blocks sitting between prev and
    next on the same page (their covered height is discounted from the gap).
    """
    if next_page != prev_page:
        if next_page <= prev_page:
            return False
        if prev_bounds is None or next_bounds is None:
            return True
        return _cross_page_columns_ok(
            prev_bbox, prev_bounds, next_bbox, next_bounds
        )

    overlap = min(prev_bbox.x1, next_bbox.x1) - max(prev_bbox.x0, next_bbox.x0)
    narrower = min(prev_bbox.x1 - prev_bbox.x0, next_bbox.x1 - next_bbox.x0)
    same_column = narrower > 0 and overlap / narrower >= 0.5

    if same_column:
        # Must flow downward (next starts no higher than prev).
        if next_bbox.y0 < prev_bbox.y0 - _GEOM_TOL:
            return False
        if line_h <= 0:
            return True
        # Empty gap = raw gap minus the vertical span filled by intervening
        # floats the text flows around.
        gap = next_bbox.y0 - prev_bbox.y1
        for ib in intervening:
            if not (
                _x_overlaps(prev_bbox.x0, prev_bbox.x1, ib.x0, ib.x1)
                or _x_overlaps(next_bbox.x0, next_bbox.x1, ib.x0, ib.x1)
            ):
                continue
            lo = max(prev_bbox.y1, ib.y0)
            hi = min(next_bbox.y0, ib.y1)
            if hi > lo:
                gap -= hi - lo
        return gap <= _MAX_CONT_GAP_LINES * line_h

    # Different column on the same page: only the bottom→top, left→right wrap.
    return (
        next_bbox.x0 > prev_bbox.x1 - _GEOM_TOL
        and next_bbox.y0 < prev_bbox.y0 - _GEOM_TOL
    )


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

# "Source: ..." / "Fuente: ..." data-attribution line that sits directly under a
# figure/table. Unlike `_CAPTION_LIKE_RE` it carries no figure number, and
# "source" is a common body word — so it only counts as part of the image when
# it is the block IMMEDIATELY AFTER one (the merge passes accept it in the
# forward direction only, never above).
# Require the trailing colon ("Source:" / "Fuente:") so a body sentence opening
# with the word "Source" (e.g. "Source code is available …") is not mistaken
# for an attribution and swallowed into the image.
_SOURCE_ATTRIBUTION_RE = re.compile(r"^(?:source|fuente)\s*:", re.IGNORECASE)


def _is_source_attribution(b) -> bool:
    """True for a plain paragraph opening with 'Source'/'Fuente'. Duck-typed so
    it accepts both ParagraphBlock and FullBlock."""
    return getattr(b, "role", None) == "paragraph" and bool(
        _SOURCE_ATTRIBUTION_RE.match((getattr(b, "text", "") or "").lstrip())
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
    look at adjacent ParagraphBlocks (by reading_index) to find its attached
    text. Two kinds attach, and a single visual can carry BOTH:
      - a caption — Marker-tagged role='caption' or a paragraph matching
        `_CAPTION_LIKE_RE` (Figure/Table/Image …, EN + ES) — above (tables) or
        below (figures);
      - a "Source: …" / "Fuente: …" attribution line directly below.
    Allows up to ±2 reading_index slots to tolerate an intervening image in
    multi-panel figures.

    When merged, the pieces' text/bboxes are absorbed into the ImageBlock
    (joined top→bottom, bbox unioned) and the pieces are removed from
    `page.blocks` so the frontend overlay no longer hovers them standalone."""
    _cont_log(f"=== pages figure-caption merge start: {len(pages)} pages ===")
    for p in pages:
        block_by_ri: dict[int, ParagraphBlock] = {
            b.reading_index: b for b in p.blocks
        }
        consumed_ids: set[int] = set()
        _cont_log(f"  -- page {p.page}: {len(p.images)} images, {len(p.blocks)} blocks --")
        for img in p.images:
            ri = img.reading_index
            # Gather the visual's text pieces: its Figure/Table caption (above
            # OR below) PLUS a "Source: …" attribution line directly below. A
            # table with a "Table N" caption above AND a Source line below keeps
            # BOTH — they're all part of the same figure/table.
            pieces: list[ParagraphBlock] = []
            have_caption = False
            have_source = False
            for delta in (1, -1, 2, -2):
                neighbor = block_by_ri.get(ri + delta)
                if neighbor is None or id(neighbor) in consumed_ids:
                    continue
                if not have_caption and _is_caption_block_pages(neighbor):
                    pieces.append(neighbor)
                    have_caption = True
                elif not have_source and delta > 0 and _is_source_attribution(neighbor):
                    # Source attribution only attaches directly below the image.
                    pieces.append(neighbor)
                    have_source = True
                if have_caption and have_source:
                    break
            if not pieces:
                _cont_log(f"    image ri={ri} role={img.role}: no caption found")
                continue
            # Order top→bottom so a caption above reads before a source below.
            pieces.sort(key=lambda b: _union_bbox(b.boxes).y0 if b.boxes else 0.0)
            img.caption_text = "\n".join(b.text for b in pieces)
            _cont_log(
                f"    image ri={ri} role={img.role} merge {len(pieces)} piece(s): "
                f"{[_snip(b.text) for b in pieces]}"
            )
            cap_bboxes = [bb for b in pieces for bb in (b.boxes or [])]
            if cap_bboxes:
                cap_union = _union_bbox(cap_bboxes)
                img.caption_bbox = cap_union
                img.bbox = BBox(
                    x0=min(img.bbox.x0, cap_union.x0),
                    y0=min(img.bbox.y0, cap_union.y0),
                    x1=max(img.bbox.x1, cap_union.x1),
                    y1=max(img.bbox.y1, cap_union.y1),
                )
            for b in pieces:
                consumed_ids.add(id(b))
        if consumed_ids:
            p.blocks = [b for b in p.blocks if id(b) not in consumed_ids]
    _cont_log("=== pages figure-caption merge end ===")


def _merge_continuations_pages(pages: list[PageBlocks]) -> None:
    """Post-pass over the per-page projection. Mirrors `_merge_continuations_
    linear`: walks every paragraph and checks against the most recent prior
    paragraph, ignoring all intervening non-paragraph blocks (caption, equation,
    code, list). Walks across page boundaries."""
    _cont_log(f"=== pages post-pass start: {len(pages)} pages ===")
    page_bounds = _page_x_bounds_pages(pages)
    prev_text = ""
    prev_bbox: BBox | None = None
    prev_page = 0
    prev_lh = 0.0
    for p in pages:
        _cont_log(f"  -- page {p.page}: {len(p.blocks)} blocks --")
        prev_idx_in_page = -1
        for i, b in enumerate(p.blocks):
            if b.role != "paragraph":
                _cont_log(f"    [{i}] skip role={b.role} text={_snip(b.text)!r}")
                continue
            lexical = bool(prev_text and _is_continuation(prev_text, b.text))
            next_bbox = _union_bbox(b.boxes) if b.boxes else None
            next_lh = _estimate_line_height(b.boxes or [])
            # Floats between prev and this paragraph on the same page (non-
            # paragraph blocks + images), whose covered height the gate discounts.
            intervening: list[BBox] = []
            if prev_page == p.page and prev_idx_in_page >= 0:
                intervening = [
                    _union_bbox(o.boxes)
                    for o in p.blocks[prev_idx_in_page + 1 : i]
                    if o.role != "paragraph" and o.boxes
                ]
                intervening += [img.bbox for img in p.images]
            geom = bool(
                prev_bbox is not None
                and next_bbox is not None
                and _continuation_geometry_ok(
                    prev_bbox, prev_page, next_bbox, p.page,
                    max(prev_lh, next_lh), intervening,
                    page_bounds.get(prev_page), page_bounds.get(p.page),
                )
            )
            fires = lexical and geom
            _cont_log(
                f"    [{i}] check paragraph fires={fires} lexical={lexical} geom={geom} "
                f"prev_end={_snip(prev_text[-80:] if prev_text else '')!r} "
                f"next_start={_snip(b.text)!r}"
            )
            # Authoritative: overrides any provisional emit-time flag so the
            # column-aware geometry here is the single source of truth.
            b.continuation = fires
            prev_text = b.text
            if next_bbox is not None:
                prev_bbox = next_bbox
                prev_page = p.page
                prev_lh = next_lh
                prev_idx_in_page = i
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
    """Merge each figure/table with its attached text in reading order. A single
    visual can carry BOTH a caption and a source line, and they're all absorbed:
      - a caption — Marker role='caption' or a paragraph matching
        `_CAPTION_LIKE_RE` (EN + ES, with or without numbering). Tables/schemes
        put it ABOVE; figures put it BELOW. Both layouts are handled.
      - a "Source: …" / "Fuente: …" attribution line directly below.

    Returns a new list with the absorbed blocks removed and their text/bboxes
    stored on the figure block as `caption_text` (joined top→bottom) /
    `caption_bbox` (unioned). The figure's own `bbox` is expanded to the union
    so a single canvas crop renders figure + caption + source together (and the
    explain raster sent to Gemini includes that text alongside the image)."""
    _cont_log(f"=== linear figure-caption merge start: {len(blocks)} blocks ===")
    consumed: set[int] = set()
    merged: list[FullBlock] = []
    for i, b in enumerate(blocks):
        if i in consumed:
            _cont_log(f"  [{i}] already consumed as caption")
            continue
        if b.role in ("figure", "table"):
            # Collect the visual's text pieces: a Figure/Table caption (ABOVE
            # for tables, BELOW for figures) PLUS a "Source: …" attribution line
            # below. A table with a caption above AND a Source line below keeps
            # BOTH. A Source line never belongs above the image.
            piece_idxs: list[int] = []
            have_caption = False
            have_source = False
            # ABOVE: caption only.
            if i - 1 >= 0 and i - 1 not in consumed and _is_caption_block_linear(blocks[i - 1]):
                piece_idxs.append(i - 1)
                have_caption = True
            # BELOW: contiguous caption and/or source (e.g. "Figure N: …" then
            # "Source: …"). Stop at the first block that is neither.
            for j in (i + 1, i + 2):
                if j >= len(blocks) or j in consumed:
                    break
                nb = blocks[j]
                if not have_caption and _is_caption_block_linear(nb):
                    piece_idxs.append(j)
                    have_caption = True
                elif not have_source and _is_source_attribution(nb):
                    piece_idxs.append(j)
                    have_source = True
                else:
                    break
            if piece_idxs:
                # The above-caption was already appended to `merged` on its own
                # iteration — drop it so it isn't emitted as a standalone block.
                if (i - 1) in piece_idxs and merged and merged[-1] is blocks[i - 1]:
                    merged.pop()
                caps = sorted((blocks[j] for j in piece_idxs), key=lambda c: c.bbox.y0)
                _cont_log(
                    f"  [{i}] {b.role} merge {len(caps)} piece(s) from {piece_idxs}: "
                    f"{[_snip(c.text) for c in caps]}"
                )
                b.caption_text = "\n".join(c.text for c in caps)
                b.caption_bbox = _union_bbox([c.bbox for c in caps])
                b.bbox = BBox(
                    x0=min(b.bbox.x0, b.caption_bbox.x0),
                    y0=min(b.bbox.y0, b.caption_bbox.y0),
                    x1=max(b.bbox.x1, b.caption_bbox.x1),
                    y1=max(b.bbox.y1, b.caption_bbox.y1),
                )
                for c in caps:
                    if c.sentences:
                        b.sentences = c.sentences
                        break
                consumed.update(piece_idxs)
            else:
                _cont_log(f"  [{i}] {b.role} no adjacent caption found")
        merged.append(b)
    _cont_log(f"=== linear figure-caption merge end: {len(merged)} blocks ({len(consumed)} captions consumed) ===")
    return merged


# ── Algorithm-box detection ──────────────────────────────────────────────────
# Algorithm environments in IEEE/ACM/LaTeX papers carry a stable header like
# "Algorithm 1 Min-Max Decomposition" or "Algorithm 2: Foo". Marker decomposes
# the box into a mix of Text / ListItem / Equation / Code blocks because it
# lacks a native Algorithm block type, so we re-stitch them here by detecting
# the header and greedily absorbing visually contiguous blocks.
_ALGORITHM_HEADER_RE = re.compile(r"^\s*Algorithm\s+\d+\b", re.IGNORECASE)
_ALGORITHM_GAP_FACTOR = 1.8        # max y-gap as multiple of header line height
_ALGORITHM_HOVERLAP_MIN = 0.55     # min horizontal overlap fraction


def _hoverlap(a: BBox, b: BBox) -> float:
    inter = max(0.0, min(a.x1, b.x1) - max(a.x0, b.x0))
    width = max(1e-6, min(a.x1 - a.x0, b.x1 - b.x0))
    return inter / width


def _merge_algorithms_linear(blocks: list[FullBlock]) -> list[FullBlock]:
    """Detect 'Algorithm N ...' regions and collapse them into a single
    role='algorithm' FullBlock. Greedy absorption from the header forward:
    keep eating blocks that overlap horizontally with the running bbox and
    sit within a small vertical gap. Stop on structural breaks (section
    header, title, author, figure, table) or another algorithm header."""
    out: list[FullBlock] = []
    i = 0
    while i < len(blocks):
        b = blocks[i]
        text = (b.text or "").lstrip()
        if (
            b.role in ("paragraph", "code", "caption")
            and b.page is not None
            and _ALGORITHM_HEADER_RE.match(text)
        ):
            header = b
            header_h = max(1.0, header.bbox.y1 - header.bbox.y0)
            union = BBox(**header.bbox.model_dump())
            parts_text: list[str] = [header.text or ""]
            consumed = [i]
            j = i + 1
            while j < len(blocks):
                nb = blocks[j]
                if nb.page != header.page:
                    break
                if nb.role in ("section_header", "title", "author", "figure", "table"):
                    break
                if _ALGORITHM_HEADER_RE.match((nb.text or "").lstrip()):
                    break
                gap = nb.bbox.y0 - union.y1
                if gap > header_h * _ALGORITHM_GAP_FACTOR:
                    break
                if _hoverlap(union, nb.bbox) < _ALGORITHM_HOVERLAP_MIN:
                    break
                union = BBox(
                    x0=min(union.x0, nb.bbox.x0),
                    y0=min(union.y0, nb.bbox.y0),
                    x1=max(union.x1, nb.bbox.x1),
                    y1=max(union.y1, nb.bbox.y1),
                )
                parts_text.append(nb.text or "")
                consumed.append(j)
                j += 1
            if len(consumed) >= 2:
                header_line = (header.text or "").splitlines()[0].strip()
                out.append(FullBlock(
                    role="algorithm",
                    text="\n".join(p for p in parts_text if p),
                    page=header.page,
                    bbox=union,
                    reading_index=header.reading_index,
                    sentences=[],
                    flat_block_ref=header.flat_block_ref,
                    continuation=False,
                    caption_text=header_line,
                    caption_bbox=header.bbox,
                ))
                i = j
                continue
        out.append(b)
        i += 1
    return out


def _merge_algorithms_pages(pages: list[PageBlocks]) -> None:
    """Per-page mirror. Detects algorithm regions inside `blocks` (paragraph
    list) and lifts them into `images` as ImageBlock(role='algorithm') so the
    paginated PdfViewer treats them like a figure/table crop."""
    for pg in pages:
        kept: list[ParagraphBlock] = []
        i = 0
        while i < len(pg.blocks):
            b = pg.blocks[i]
            text = (b.text or "").lstrip()
            if b.role in ("paragraph", "code", "caption") and _ALGORITHM_HEADER_RE.match(text):
                # Block-level bbox from paragraph.boxes union (ParagraphBlock has
                # no single bbox attribute — derive it).
                def pbbox(p: ParagraphBlock) -> BBox | None:
                    if not p.boxes:
                        return None
                    xs0 = min(bx.x0 for bx in p.boxes)
                    ys0 = min(bx.y0 for bx in p.boxes)
                    xs1 = max(bx.x1 for bx in p.boxes)
                    ys1 = max(bx.y1 for bx in p.boxes)
                    return BBox(x0=xs0, y0=ys0, x1=xs1, y1=ys1)
                hbb = pbbox(b)
                if hbb is None:
                    kept.append(b)
                    i += 1
                    continue
                union = BBox(**hbb.model_dump())
                header_h = max(1.0, hbb.y1 - hbb.y0)
                header_line = (b.text or "").splitlines()[0].strip()
                consumed = 1
                j = i + 1
                while j < len(pg.blocks):
                    nb = pg.blocks[j]
                    if nb.role in ("section_header", "title", "author"):
                        break
                    if _ALGORITHM_HEADER_RE.match((nb.text or "").lstrip()):
                        break
                    nbb = pbbox(nb)
                    if nbb is None:
                        break
                    gap = nbb.y0 - union.y1
                    if gap > header_h * _ALGORITHM_GAP_FACTOR:
                        break
                    if _hoverlap(union, nbb) < _ALGORITHM_HOVERLAP_MIN:
                        break
                    union = BBox(
                        x0=min(union.x0, nbb.x0),
                        y0=min(union.y0, nbb.y0),
                        x1=max(union.x1, nbb.x1),
                        y1=max(union.y1, nbb.y1),
                    )
                    consumed += 1
                    j += 1
                if consumed >= 2:
                    pg.images.append(ImageBlock(
                        bbox=union,
                        reading_index=b.reading_index,
                        role="algorithm",
                        caption_text=header_line,
                        caption_bbox=hbb,
                    ))
                    i = j
                    continue
            kept.append(b)
            i += 1
        pg.blocks = kept


def _reorder_authors_after_title(blocks: list[FullBlock]) -> None:
    """Move author + affiliation blocks into a contiguous group immediately
    after the title, sorted by natural reading order (top-to-bottom,
    left-to-right). Marker reads two-column mastheads column-by-column, so an
    author / affiliation sitting in the SECOND column physically next to the
    title gets emitted AFTER the abstract (which lives at the bottom of column
    one) — and Marker frequently mislabels those stray author lines as
    `SectionHeader`. Both effects leave author blocks stranded after the
    abstract in the linear stream.

    Detection is GEOMETRIC, not reading-order or text based: on the title page
    the masthead is the vertical band ABOVE the first body block — the first
    "Abstract" / "Introduction" header, or failing that the first substantial
    paragraph. Every title-page `paragraph` / `section_header` whose top edge
    lies inside that band is masthead material. A real numbered section header
    such as "2 PHOTONIC GPU ARCHITECTURE" sits BELOW the band and is left
    untouched — a pure text heuristic wrongly grabs it because its all-caps /
    Title-Case text reads like a name list. When the title page has no body
    anchor at all (abstract on a later page), fall back to the author/
    affiliation text heuristics.

    Always includes blocks Marker already tagged `role=='author'`. All matched
    blocks are re-stamped `role='author'` so downstream code (frontend block-
    role styling, sentence-stop filters) treats them uniformly. Only touches
    the linear projection — the paginated view still mirrors the page layout.
    """
    if not blocks:
        return

    title_idx  = next((i for i, b in enumerate(blocks) if b.role == "title"), -1)
    title_page = blocks[title_idx].page if title_idx >= 0 else (blocks[0].page if blocks else 1)
    first_after = title_idx + 1 if title_idx >= 0 else 0

    # Masthead floor = top edge of the highest body block on the title page.
    # A body block is a body/skip section header (Abstract / Introduction / …)
    # or a substantial paragraph (>30 words ≈ abstract or first body para).
    # Authors live strictly above this line; numbered section headers below it.
    body_tops = [
        b.bbox.y0
        for b in blocks
        if b.page == title_page
        and (
            (
                b.role == "section_header"
                and (
                    _is_body_section_name((b.text or "").strip())
                    or _is_skip_section((b.text or "").strip())
                )
            )
            or (
                b.role == "paragraph"
                and len((b.text or "").split()) > 30
                and not _is_dense_name_list(b.text or "")
            )
        )
    ]
    masthead_bottom = min(body_tops) if body_tops else None

    candidate_idxs: list[int] = []
    for i, b in enumerate(blocks):
        if b.role == "author":
            candidate_idxs.append(i)
            continue
        if b.page != title_page or b.role not in ("paragraph", "section_header"):
            continue
        txt = (b.text or "").strip()
        if not txt:
            continue
        # Body / skip section headers are NEVER masthead — even when they fall
        # inside the band (a sub-header that bleeds up). Without this guard a
        # header like "References" or "Acknowledgments" could get pulled up.
        if b.role == "section_header" and (
            _is_body_section_name(txt) or _is_skip_section(txt)
        ):
            continue
        if masthead_bottom is not None:
            # In-band → masthead. Test the block's vertical CENTER, not its top
            # edge: in two-column layouts the first body fragment of column 2
            # shares the abstract's top y, so a `y0 <` test flips on a float
            # tie. A body block extends below the floor (center fails); authors
            # sit entirely above it. This catches stray authors Marker
            # mislabeled as section_header and long author-name lines the text
            # heuristic misses, while excluding real headers below the band.
            if (b.bbox.y0 + b.bbox.y1) / 2 < masthead_bottom:
                candidate_idxs.append(i)
        elif _looks_like_author_line(txt) or _is_soft_noise(txt):
            candidate_idxs.append(i)

    if not candidate_idxs:
        return

    candidates = [blocks[i] for i in candidate_idxs]
    insert_at  = first_after
    for i in sorted(candidate_idxs, reverse=True):
        blocks.pop(i)
    insert_at -= sum(1 for i in candidate_idxs if i < insert_at)
    for c in candidates:
        c.role = "author"
    candidates.sort(key=lambda b: (b.page, b.bbox.y0, b.bbox.x0))
    for k, c in enumerate(candidates):
        blocks.insert(insert_at + k, c)
    # Reassign reading_index in array order so the cross-mode sequence
    # builder (frontend buildLinearReadingSequence) stays consistent with
    # the new visual order.
    for i, b in enumerate(blocks):
        b.reading_index = i


def _merge_continuations_linear(linear_blocks: list[FullBlock]) -> None:
    """Post-pass over the linear projection. Walks every paragraph and checks
    the most recent prior paragraph, ignoring ALL intervening non-paragraph
    blocks (caption, equation, figure, table, code, list, section_header,
    title, author).

    A merge fires only when BOTH gates pass:
    - lexical (`_is_continuation`): next paragraph starts with a lowercase
      letter;
    - geometric (`_continuation_geometry_ok`): the two are physically a real
      text flow (same-column downward, the bottom→top column wrap, or a
      cross-page wrap).

    The geometric gate is what stops a lowercase fragment in one column from
    chaining to an unrelated paragraph in another column in multi-column
    layouts."""
    _cont_log(f"=== linear post-pass start: {len(linear_blocks)} blocks ===")
    page_bounds = _page_x_bounds_linear(linear_blocks)
    prev_para: FullBlock | None = None
    prev_idx = -1
    for i, b in enumerate(linear_blocks):
        if b.role != "paragraph":
            _cont_log(f"  [{i}] skip role={b.role} text={_snip(b.text)!r}")
            continue
        lexical = bool(prev_para and _is_continuation(prev_para.text, b.text))
        line_h = max(
            _estimate_line_height([bx for s in prev_para.sentences for bx in s.boxes]) if prev_para else 0.0,
            _estimate_line_height([bx for s in b.sentences for bx in s.boxes]),
        )
        # Non-paragraph blocks between prev paragraph and this one on the same
        # page — floats the text may flow around (discounted from the gap).
        intervening = [
            o.bbox
            for o in linear_blocks[prev_idx + 1 : i]
            if prev_para and o.page == prev_para.page == b.page
        ]
        geom = bool(
            prev_para
            and _continuation_geometry_ok(
                prev_para.bbox, prev_para.page, b.bbox, b.page, line_h, intervening,
                page_bounds.get(prev_para.page), page_bounds.get(b.page),
            )
        )
        fires = lexical and geom
        _cont_log(
            f"  [{i}] check paragraph fires={fires} lexical={lexical} geom={geom} "
            f"prev_end={_snip(prev_para.text[-80:] if prev_para else '')!r} "
            f"next_start={_snip(b.text)!r}"
        )
        # Authoritative: overrides any provisional emit-time flag so the
        # column-aware geometry here is the single source of truth.
        b.continuation = fires
        prev_para = b
        prev_idx = i
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


def _x_overlaps(a0: float, a1: float, b0: float, b1: float, min_ratio: float = 0.3) -> bool:
    """True if two x-ranges share at least min_ratio of the narrower range's width."""
    overlap = min(a1, b1) - max(a0, b0)
    if overlap <= 0:
        return False
    return overlap / min(a1 - a0, b1 - b0) >= min_ratio


def _rescue_footnotes_on_page(page) -> set[int]:
    """Return id()s of Footnote blocks that have a non-Footnote text block
    below them in the same column.

    Real footnotes sit at the page bottom with no body text after them.
    If Marker labels a block Footnote but body text appears below it in the
    same column, the label is wrong — promote the block to Text.
    The column check (x-overlap) prevents a right-column Text block from
    rescuing a real left-column footnote.
    """
    blocks_info = [
        (_block_type_name(b), _polygon_to_bbox(b.polygon), b)
        for b in _iter_layout_blocks(page)
    ]
    text_boxes = [
        bbox for bt, bbox, _ in blocks_info
        if bt in _TEXT_TYPES  # _TEXT_TYPES never includes Footnote
    ]
    rescued: set[int] = set()
    for bt, bbox, block in blocks_info:
        if bt != "Footnote":
            continue
        for t_bbox in text_boxes:
            if t_bbox.y0 > bbox.y0 and _x_overlaps(bbox.x0, bbox.x1, t_bbox.x0, t_bbox.x1):
                rescued.add(id(block))
                break
    return rescued


def _column_major_order(items: list[tuple[object, BBox]]) -> list:
    """Sort (block, bbox) pairs into column-major reading order.

    Marker's reading order can scramble within a column (a paragraph's last
    short line emitted before the paragraph body, footnotes dumped at page end,
    right-column blocks interleaved past the figure). That leaves the true
    sequential neighbours non-adjacent so the continuation merge never compares
    them. Re-derive the order purely from geometry:

    - only blocks that span the full content width (title / abstract /
      spanning figure-caption — they reach BOTH content edges) act as
      horizontal barriers and are emitted in `y` order;
    - every other block is assigned to the column it horizontally overlaps
      more, and between barriers the LEFT column is emitted top-to-bottom,
      then the RIGHT column top-to-bottom.

    A wide block rooted in one column (a broad table, a paragraph that creeps
    just past page centre) is NOT a barrier: it reaches only one content edge,
    so it joins its own column instead of flushing the other one early. That
    is the case that used to scramble order — a wide left block would flush the
    accumulated RIGHT column ahead of the LEFT blocks still below it.

    Single-column pages (all blocks full width) collapse to a plain top-to-
    bottom sort, so this is a no-op there.
    """
    if len(items) < 2:
        return [b for b, _ in items]
    min_x0 = min(bb.x0 for _, bb in items)
    max_x1 = max(bb.x1 for _, bb in items)
    w = max_x1 - min_x0
    mid = min_x0 + w / 2

    result: list = []
    left: list[tuple[object, BBox]] = []
    right: list[tuple[object, BBox]] = []

    def flush() -> None:
        result.extend(b for b, _ in sorted(left, key=lambda it: it[1].y0))
        result.extend(b for b, _ in sorted(right, key=lambda it: it[1].y0))
        left.clear()
        right.clear()

    def spans_columns(bb: BBox) -> bool:
        # True barrier: reaches near both content edges (≈ full width). Any
        # block narrower than that is rooted in one column and must not flush.
        return bb.x0 <= min_x0 + 0.12 * w and bb.x1 >= max_x1 - 0.12 * w

    for b, bb in sorted(items, key=lambda it: it[1].y0):
        if w <= 0 or spans_columns(bb):  # full-width → barrier
            flush()
            result.append(b)
            continue
        # Assign to the column it overlaps more (page centre splits the two).
        left_ov = min(bb.x1, mid) - bb.x0
        right_ov = bb.x1 - max(bb.x0, mid)
        (right if right_ov > left_ov else left).append((b, bb))
    flush()
    return result


def _reorder_reading_order(blocks: list) -> list:
    """Column-major reading-order sort over raw Marker layout blocks."""
    return _column_major_order([(b, _polygon_to_bbox(b.polygon)) for b in blocks])


def _latex_from_equation_block(block) -> str:
    """Return LaTeX text set by EquationProcessor on an Equation block.

    EquationProcessor runs Surya recognition on each Equation block and stores
    the result in block.html as <math display="block">...LaTeX...</math>.
    Strip the tags to get the raw LaTeX for the text pipeline.
    Returns "" if block.html is unset or contains no math content.
    """
    html = getattr(block, "html", None)
    if not html:
        return ""
    return re.sub(r"<[^>]+>", "", html).strip()


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
def _run_marker(pdf_bytes: bytes, *, disable_ocr: bool = False):
    """Write pdf_bytes to a tmp file, build a Marker Document, clean up."""
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes)
        tmp_path = tmp.name
    try:
        converter = _get_converter(disable_ocr=disable_ocr)
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
        rescued_footnotes = _rescue_footnotes_on_page(page)
        page_blocks = _reorder_reading_order(list(_iter_layout_blocks(page)))
        body_lh, body_bboxes = _page_footnote_context(page, document, line_cache)

        for block in page_blocks:
            if stop_content:
                break

            bt = _block_type_name(block)
            if bt == "Footnote" and id(block) in rescued_footnotes:
                bt = "Text"
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
            if bt == "Equation":
                eq_latex = _latex_from_equation_block(block)
                if eq_latex:
                    text = eq_latex
            if not text or len(text.split()) < 3:
                continue

            if (
                bt in _BODY_TEXT_TYPES
                and id(block) not in rescued_footnotes
                and not _CAPTION_LIKE_RE.match(text)
                and not _SOURCE_ATTRIBUTION_RE.match(text)
                and _is_footnote_by_font(inner_lines, bbox, body_lh, body_bboxes)
            ):
                continue

            if _is_stop_header(text):
                stop_content = True
                break

            # License / copyright boilerplate — drop on any page.
            if _is_license_noise(text):
                continue

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
    _merge_algorithms_pages(pages)
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


# Decorative-icon thresholds. Standard CC BY button is 88x31 pt, CC mark is
# ~50x50 pt, conference / publisher logos in headers and corners are
# similarly small. Real paper figures either fill a column (typically
# >200pt wide) or carry a "Figure N: ..." caption that pulls them through
# the merge pass with caption_text populated.
_ICON_MAX_W_PT       = 130
_ICON_MAX_H_PT       = 70
_ICON_MAX_AREA_PT_SQ = 12000


def _looks_like_decorative_icon(bbox, caption_text: str | None) -> bool:
    """Tiny image with no caption — license badge, publisher logo, page-
    corner mark. Filtered out of both the per-page `images` list and the
    linear projection so they never reach the explain pipeline (no ✦
    button, no Gemini analysis on a Creative Commons icon)."""
    if caption_text:
        return False
    w = max(0.0, bbox.x1 - bbox.x0)
    h = max(0.0, bbox.y1 - bbox.y0)
    if w < _ICON_MAX_W_PT and h < _ICON_MAX_H_PT:
        return True
    if w * h < _ICON_MAX_AREA_PT_SQ:
        return True
    return False


def _drop_decorative_icons_pages(pages: list[PageBlocks]) -> None:
    for pg in pages:
        pg.images = [
            im for im in pg.images
            if im.role != "figure"
            or not _looks_like_decorative_icon(im.bbox, im.caption_text)
        ]


def _drop_decorative_icons_linear(blocks: list[FullBlock]) -> list[FullBlock]:
    return [
        b for b in blocks
        if b.role != "figure"
        or not _looks_like_decorative_icon(b.bbox, b.caption_text)
    ]


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

        rescued_footnotes = _rescue_footnotes_on_page(page)
        page_blocks = _reorder_reading_order(list(_iter_layout_blocks(page)))
        body_lh, body_bboxes = _page_footnote_context(page, document, line_cache)
        _extract_log(f"=== page {page_no} rescued_footnotes={len(rescued_footnotes)} ===")
        for block in page_blocks:
            if stop_content:
                break

            bt = _block_type_name(block)
            bbox = _polygon_to_bbox(block.polygon)
            was_rescued = False
            if bt == "Footnote" and id(block) in rescued_footnotes:
                _extract_log(
                    f"  bt=Footnote→Text (rescued) y=[{bbox.y0:.1f},{bbox.y1:.1f}] "
                    f"x=[{bbox.x0:.1f},{bbox.x1:.1f}]"
                )
                bt = "Text"
                was_rescued = True
            else:
                _extract_log(
                    f"  bt={bt} y=[{bbox.y0:.1f},{bbox.y1:.1f}] "
                    f"x=[{bbox.x0:.1f},{bbox.x1:.1f}]"
                )

            if bt in _DROP_TYPES:
                _extract_log(f"    → SKIP drop_type")
                continue

            # SectionHeader: emit (as title / author / section_header) unless
            # it's a stop or skip header, which we still consume for state.
            if bt == "SectionHeader":
                header_text = " ".join(
                    l.text for l in _collect_lines(block, document, line_cache)
                ).strip()
                if not header_text:
                    _extract_log(f"    → SKIP empty header")
                    continue
                if _is_stop_header(header_text):
                    _extract_log(f"    → STOP stop_header {_snip(header_text)!r}")
                    stop_content = True
                    break
                if _is_skip_section(header_text):
                    _extract_log(f"    → SKIP skip_section {_snip(header_text)!r}")
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
                _extract_log(f"    → EMIT role={role} {_snip(header_text)!r}")
                reading_index += 1
                continue

            if bt in _IMAGE_TYPES:
                _extract_log(f"    → EMIT role={_role_for_image_block(bt)} (image)")
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
                _extract_log(f"    → SKIP not text_type")
                continue
            if skip_section:
                _extract_log(f"    → SKIP skip_section active")
                continue

            inner_lines = _collect_lines(block, document, line_cache)
            text = " ".join(l.text for l in inner_lines).strip()
            # Marker's Footnote layout polygon is loose and can overrun the
            # block below; tighten a rescued block to its real text extent so
            # its render crop / highlight doesn't overlap the next paragraph.
            if was_rescued and inner_lines:
                bbox = _union_bbox([l.bbox for l in inner_lines])
            if bt == "Equation":
                eq_latex = _latex_from_equation_block(block)
                if eq_latex:
                    text = eq_latex
            if not text or len(text.split()) < 3:
                _extract_log(f"    → SKIP too_short {_snip(text)!r}")
                continue

            if (
                bt in _BODY_TEXT_TYPES
                and not was_rescued
                and not _CAPTION_LIKE_RE.match(text)
                and not _SOURCE_ATTRIBUTION_RE.match(text)
                and _is_footnote_by_font(inner_lines, bbox, body_lh, body_bboxes)
            ):
                _extract_log(f"    → SKIP footnote_by_font {_snip(text)!r}")
                continue

            if _is_stop_header(text):
                _extract_log(f"    → STOP stop_header {_snip(text)!r}")
                stop_content = True
                break

            # License / copyright boilerplate — drop on any page.
            if _is_license_noise(text):
                _extract_log(f"    → SKIP license_noise {_snip(text)!r}")
                continue

            role = _role_for_text_block(bt)

            if page_idx == 0:
                if _is_hard_noise(text):
                    _extract_log(f"    → SKIP hard_noise {_snip(text)!r}")
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

            _extract_log(
                f"    → EMIT role={role} continuation={is_continuation} "
                f"{_snip(text)!r}"
            )
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


def _clip_vertical_overlaps_linear(blocks: list[FullBlock]) -> None:
    """Remove vertical overlap between same-column blocks (in place).

    LinearReader renders each block as its own crop of the page canvas. When
    two same-column blocks overlap in y (Marker's loose layout boxes, a rescued
    footnote overrunning the block below), the shared strip is cropped twice and
    the text appears duplicated / superimposed. Shrink the upper block's bottom
    to the lower block's top so the crops tile seamlessly and read as one.
    Blocks are already in reading order, so the nearest prior x-overlapping
    block on the same page is the column neighbour directly above.
    """
    for i, b in enumerate(blocks):
        for j in range(i - 1, -1, -1):
            a = blocks[j]
            if a.page != b.page:
                break  # earlier blocks are on earlier pages
            if not _x_overlaps(a.bbox.x0, a.bbox.x1, b.bbox.x0, b.bbox.x1):
                continue
            if a.bbox.y0 <= b.bbox.y0 and a.bbox.y1 > b.bbox.y0 + _GEOM_TOL:
                a.bbox = BBox(
                    x0=a.bbox.x0, y0=a.bbox.y0, x1=a.bbox.x1, y1=b.bbox.y0
                )
            break  # only the nearest column neighbour above


def extract_linear_blocks(pdf_bytes: bytes, *, disable_ocr: bool = False) -> list[FullBlock]:
    """Parse a PDF with Marker and return all blocks in global reading order."""
    document = _run_marker(pdf_bytes, disable_ocr=disable_ocr)
    blocks = _extract_linear_from_document(document)
    blocks = _merge_figure_captions_linear(blocks)
    blocks = _merge_algorithms_linear(blocks)
    blocks = _drop_decorative_icons_linear(blocks)
    _reorder_authors_after_title(blocks)
    _merge_continuations_linear(blocks)
    _clip_vertical_overlaps_linear(blocks)
    return blocks


def extract_both(
    pdf_bytes: bytes,
    *,
    disable_ocr: bool = False,
) -> tuple[list[PageBlocks], list[FullBlock]]:
    """Run Marker once; return both the per-page and linear projections.

    Both pipelines walk the same blocks and need their line geometry, so a
    shared `line_cache` (keyed by `id(block)`) is threaded through to halve
    the line-collection work.

    `disable_ocr=True` skips Surya text-recognition entirely and uses the
    PDF's native text layer. Set this when the caller has already verified
    the PDF is text-native (e.g. via `has_native_text_layer`).
    """
    document = _run_marker(pdf_bytes, disable_ocr=disable_ocr)
    line_cache: dict[int, list[LineBlock]] = {}
    pages  = _extract_pages_from_document(document, line_cache)
    linear = _extract_linear_from_document(document, line_cache)
    linear = _merge_figure_captions_linear(linear)
    linear = _merge_algorithms_linear(linear)
    linear = _drop_decorative_icons_linear(linear)
    _reorder_authors_after_title(linear)
    _merge_figure_captions_pages(pages)
    _merge_algorithms_pages(pages)
    _drop_decorative_icons_pages(pages)
    _merge_continuations_pages(pages)
    _merge_continuations_linear(linear)
    _clip_vertical_overlaps_linear(linear)
    return pages, linear
