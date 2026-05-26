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


class UploadResponse(BaseModel):
    filename: str
    page_count: int
    global_map: GlobalMapping
    pages: list[PageBlocks]


class DocumentInfo(BaseModel):
    filename: str
    size_bytes: int
    has_analysis: bool


class ExplainRequest(BaseModel):
    paragraph_sentences: list[str]
    global_map: dict


class ConceptExplanation(BaseModel):
    term: str
    explanation: str


class SentenceExplanation(BaseModel):
    sentence_indices: list[int]
    quote: str
    concepts: list[ConceptExplanation]


class ExplainResponse(BaseModel):
    sentence_explanations: list[SentenceExplanation]
