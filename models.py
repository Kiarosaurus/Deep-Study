from typing import Literal

from pydantic import BaseModel


class BBox(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float


class LineBlock(BaseModel):
    text: str
    bbox: BBox


class SentenceBlock(BaseModel):
    text: str
    boxes: list[BBox]


class FootnoteAnnotation(BaseModel):
    # A symbol-marked footnote (Phase 1: * † ‡ § ¶ …) linked to the paragraph
    # that cites it via a matching in-text superscript. Kept as a DISTINCT box
    # (rendered green) — never folded into the paragraph's own bbox — but its
    # text rides along into that paragraph's AI explanation, labeled "Footnote".
    text: str
    bbox: BBox
    marker: str = ""


class ParagraphBlock(BaseModel):
    text: str
    boxes: list[BBox]
    sentences: list[SentenceBlock] = []
    reading_index: int = 0
    # True when this paragraph is the cross-page continuation of the previous
    # paragraph (prev did not end in terminal punctuation, this one begins
    # with a lowercase letter). Consumers join continuations with the previous
    # paragraph instead of treating them as a separate unit.
    continuation: bool = False
    # Sub-type of the text block. Mirrors the linear projection's role enum
    # for the subset of types that the per-page pipeline emits as ParagraphBlock
    # (text-derived only — figures/tables/pictures live in PageBlocks.images).
    # Used by `_merge_continuations_pages` to skip decorative inserts (caption,
    # equation) when chaining continuations and reset on structural breaks.
    # Default "paragraph" preserves backward compatibility with analysis.json
    # files generated before this field was introduced.
    role: Literal["paragraph", "caption", "equation", "code"] = "paragraph"
    # Symbol-marked footnotes cited by this paragraph (Phase 1). Each is a
    # distinct green box in the reader and is fed into the explanation.
    footnotes: list[FootnoteAnnotation] = []


class ImageBlock(BaseModel):
    bbox: BBox
    reading_index: int = 0
    # Sub-type: "figure" (default) or "table". Set by extraction based on the
    # underlying Marker block type. Mirrors the linear projection's role.
    role: Literal["figure", "table", "algorithm"] = "figure"
    # Populated when `_merge_figure_captions_pages` finds an adjacent caption
    # (Marker-tagged or paragraph matching `_CAPTION_LIKE_RE`) and absorbs it
    # into this image. Frontend treats the union bbox as the hover region so
    # the caption is "contained" by the image's overlay.
    caption_text: str = ""
    caption_bbox: BBox | None = None


class PageBlocks(BaseModel):
    page: int
    width: float = 0.0
    height: float = 0.0
    blocks: list[ParagraphBlock]
    images: list[ImageBlock] = []


class Acronym(BaseModel):
    term: str
    definition: str


class GlobalMapping(BaseModel):
    acronyms: list[Acronym]
    core_methodology: str
    assumed_concepts: list[str]


FullBlockRole = Literal[
    "title",
    "author",
    "section_header",
    "paragraph",
    "caption",
    "figure",
    "table",
    "equation",
    "code",
    "list",
    "algorithm",
]


class FullBlock(BaseModel):
    role: FullBlockRole
    text: str = ""
    page: int
    bbox: BBox
    reading_index: int
    sentences: list[SentenceBlock] = []
    flat_block_ref: int | None = None
    # True iff this paragraph is the cross-page tail of the previous paragraph
    # (same heuristic as ParagraphBlock.continuation). Lets the linear reader
    # render N-1 and N visually contiguous and merge them for explain payloads.
    continuation: bool = False
    # Populated for figure/table blocks when a following caption (Marker-tagged
    # Caption role or paragraph that begins with "Figure N" / "Table N" / etc.)
    # was merged into this block by `_merge_figure_captions_linear`. Frontend
    # renders the caption beneath the image and uses these for the explain flow.
    caption_text: str = ""
    caption_bbox: BBox | None = None
    # Symbol-marked footnotes cited by this paragraph (Phase 1). Distinct green
    # boxes in the reader; their text is fed into the explanation.
    footnotes: list[FootnoteAnnotation] = []


class UploadResponse(BaseModel):
    filename: str
    page_count: int
    global_map: GlobalMapping
    pages: list[PageBlocks]
    linear_blocks: list[FullBlock] = []
    # Explanation language chosen at upload. Persisted in analysis.json so the
    # reader can echo it back on every explain request — explanations come back
    # in this language regardless of the UI language. Older analysis files
    # without this field fall back to "es" at read time.
    language: str = "es"


class DocumentInfo(BaseModel):
    filename: str
    size_bytes: int
    has_analysis: bool


class ExplainRequest(BaseModel):
    paragraph_sentences: list[str] = []
    global_map: dict
    # Fields below are only meaningful when block_type != "paragraph". For a
    # figure/table the backend rasterizes the bbox of the source PDF, sends
    # the image to Gemini multimodal, and uses caption_text as accompanying
    # context.
    block_type: Literal["paragraph", "figure", "table", "algorithm"] = "paragraph"
    filename: str | None = None
    page: int | None = None
    bbox: BBox | None = None
    caption_text: str = ""
    # Symbol-marked footnotes cited by the paragraph. Injected into the prompt
    # labeled "Footnote" so the explanation accounts for them.
    footnotes: list[str] = []
    # Explanation language for this request (es | en | zh-Hant). Drives the
    # Gemini output language; independent of the UI language. Defaults to es
    # for older clients that don't send it.
    language: str = "es"


class ConceptExplanation(BaseModel):
    term: str
    explanation: str


class SentenceExplanation(BaseModel):
    sentence_indices: list[int]
    quote: str
    concepts: list[ConceptExplanation]


class ParagraphContext(BaseModel):
    section_role: str
    narrative: str


class ExplainResponse(BaseModel):
    sentence_explanations: list[SentenceExplanation]
    paragraph_context: ParagraphContext
