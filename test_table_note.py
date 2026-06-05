"""Diagnostic + regression for APA table-Note merging (no PDF / Marker needed).

Builds synthetic linear arrays that mimic the post-extraction reading order and
runs the REAL `_merge_tables_linear`, so we can see exactly when a table's
"Note." block is absorbed vs orphaned.

Scenarios:
  A. Label-anchored table  [Table N caption][table][Note.]  — already worked.
  B. Gutter-ordered table, NO "Table N" caption: the wide table is a column
     barrier, so the narrow Note is bucketed below the columns with body
     paragraphs wedged between. The regression — note capture was gated behind
     label detection, so the Note was orphaned.
  C. Standalone table whose Note uses a superscript-letter marker ("a. …") and
     sits 180pt below the table — exercises the widened Y-gap (was 140) and the
     letter form of the note regex.
  D. Guardrail: a role='figure' with a Note-like block below must be left ALONE
     by the tables pass (only role='table' claims notes).

Run: `python3 test_table_note.py`.
"""
import sys

from extraction import _merge_tables_linear, _merge_table_notes_pages, _is_table_note
from models import BBox, FullBlock, ParagraphBlock, ImageBlock, PageBlocks


def fb(role, text, x0, y0, x1, y1, *, page=1, ri=0) -> FullBlock:
    return FullBlock(
        role=role, text=text, page=page, reading_index=ri,
        bbox=BBox(x0=x0, y0=y0, x1=x1, y1=y1),
    )


def note_in_table(out: list[FullBlock]) -> bool:
    """A table block carries the note text AND no standalone note paragraph
    survives."""
    orphan = any(b.role != "table" and _is_table_note(b) for b in out)
    in_table = any(
        b.role == "table" and ("Note." in (b.text or "") or "a. " in (b.text or ""))
        for b in out
    )
    return in_table and not orphan


def scenario_A():
    return [
        fb("caption",   "Table 1. Performance results.",            60, 90, 540, 110, ri=0),
        fb("table",     "",                                         60, 120, 540, 200, ri=1),
        fb("paragraph", "Note. N = 32 per condition.",              60, 210, 400, 235, ri=2),
    ]


def scenario_B():
    # Wide table (barrier) at top; region below flushes left then right column,
    # so the right-column Note lands at the END with 3 paragraphs wedged in.
    return [
        fb("table",     "",                                              60, 120, 540, 200, ri=0),
        fb("paragraph", "The system was evaluated across eight nodes.",  60, 210, 290, 320, ri=1),
        fb("paragraph", "Throughput scaled linearly with bandwidth.",    60, 330, 290, 440, ri=2),
        fb("paragraph", "In contrast, latency remained flat overall.",  320, 210, 540, 300, ri=3),
        fb("paragraph", "Note. Values are means; SD in parentheses.",   320, 310, 540, 340, ri=4),
    ]


def scenario_C():
    # Standalone table, superscript-letter note 180pt below (within the new
    # 200pt ceiling, beyond the old 140pt one).
    return [
        fb("table",     "",                                       60, 120, 540, 200, ri=0),
        fb("paragraph", "a. Values are weighted means across runs.", 60, 380, 420, 405, ri=1),
    ]


def scenario_D():
    # Figure (not a table) with a Note-like block below — tables pass must skip.
    return [
        fb("figure",    "",                                  60, 120, 540, 200, ri=0),
        fb("paragraph", "Note. Error bars show 95% CI.",     60, 210, 400, 235, ri=1),
    ]


def scenario_pages():
    """Per-page projection (canvas Reader): a table ImageBlock with its 'Table N'
    caption already merged, and a 'Note.' ParagraphBlock floating below it. The
    note must be folded into the image (caption_text + bbox) and removed from
    blocks. Includes a figure + its own note-like block as a guardrail."""
    blocks = [
        ParagraphBlock(role="paragraph", text="Body paragraph above.",
                       boxes=[BBox(x0=60, y0=60, x1=290, y1=110)], reading_index=0),
        ParagraphBlock(role="paragraph", text="Note. Values are means; SD in parentheses.",
                       boxes=[BBox(x0=60, y0=210, x1=290, y1=240)], reading_index=2),
        # A figure note below a FIGURE — must stay standalone (guardrail).
        ParagraphBlock(role="paragraph", text="Note. Error bars show 95% CI.",
                       boxes=[BBox(x0=320, y0=210, x1=540, y1=240)], reading_index=4),
    ]
    images = [
        ImageBlock(bbox=BBox(x0=60, y0=120, x1=290, y1=200), role="table",
                   reading_index=1, caption_text="Table 1. Results."),
        ImageBlock(bbox=BBox(x0=320, y0=120, x1=540, y1=200), role="figure",
                   reading_index=3, caption_text="Figure 1. Gradient."),
    ]
    return PageBlocks(page=1, width=600, height=300, blocks=blocks, images=images)


def test_pages():
    pg = scenario_pages()
    _merge_table_notes_pages([pg])
    table = next(im for im in pg.images if im.role == "table")
    figure = next(im for im in pg.images if im.role == "figure")
    stray_notes = [b for b in pg.blocks if _is_table_note(b)]

    ok = True
    if "Values are means" not in (table.caption_text or ""):
        print("  FAIL pages: table did not absorb its note into caption_text"); ok = False
    if abs(table.bbox.y1 - 240) > 1:  # bbox extended to swallow note (y1 210->240)
        print(f"  FAIL pages: table bbox not extended (y1={table.bbox.y1})"); ok = False
    if "Error bars" in (figure.caption_text or ""):
        print("  FAIL pages: figure wrongly absorbed a note"); ok = False
    # Only the FIGURE's note may remain standalone; the table's note is gone.
    if len(stray_notes) != 1 or "Error bars" not in stray_notes[0].text:
        print(f"  FAIL pages: expected only the figure note to remain, got {len(stray_notes)}"); ok = False
    return ok


def _report(tag, arr):
    tbl = next((k for k, b in enumerate(arr) if b.role == "table"), None)
    note = next((k for k, b in enumerate(arr) if _is_table_note(b)), None)
    wedged = (note - tbl - 1) if (tbl is not None and note is not None) else None
    print(f"  [{tag}] table@{tbl} note@{note} blocks_wedged_between={wedged}")
    return _merge_tables_linear(list(arr))


def main():
    print("INPUT diagnostic — where does the Note land, and is it absorbed?")
    failures = 0

    # A,B,C: the note SHOULD end up inside the table block.
    for tag, builder in (("A label", scenario_A), ("B gutter", scenario_B),
                         ("C letter+gap", scenario_C)):
        out = _report(tag, builder())
        ok = note_in_table(out)
        print(f"  [{tag}] note_in_table={ok}  (out={len(out)} blocks)")
        if ok:
            print(f"  PASS {tag}")
        else:
            failures += 1
            print(f"  FAIL {tag}: table note was orphaned")

    # D: guardrail — the figure must NOT swallow the note; it stays standalone.
    out_d = _report("D figure", scenario_D())
    fig_swallowed = any(
        b.role == "figure" and "Note." in (b.text or "") for b in out_d
    )
    note_kept = any(_is_table_note(b) for b in out_d)
    print(f"  [D figure] fig_swallowed={fig_swallowed} note_kept={note_kept}")
    if not fig_swallowed and note_kept:
        print("  PASS D figure (note left untouched by tables pass)")
    else:
        failures += 1
        print("  FAIL D figure: tables pass must not touch figures")

    # E: per-page projection (canvas Reader) — table image must absorb its note.
    if test_pages():
        print("  PASS E pages (per-page table absorbs note; figure note left alone)")
    else:
        failures += 1
        print("  FAIL E pages")

    if failures:
        print(f"\n{failures} scenario(s) failed")
        sys.exit(1)
    print("\nall table-note checks passed")


if __name__ == "__main__":
    main()
