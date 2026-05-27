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


class ImageBlock(BaseModel):
    bbox: BBox
    reading_index: int = 0


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


class UploadResponse(BaseModel):
    filename: str
    page_count: int
    global_map: GlobalMapping
    pages: list[PageBlocks]
    linear_blocks: list[FullBlock] = []


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
    block_type: Literal["paragraph", "figure", "table"] = "paragraph"
    filename: str | None = None
    page: int | None = None
    bbox: BBox | None = None
    caption_text: str = ""


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
