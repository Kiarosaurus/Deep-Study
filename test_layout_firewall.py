"""Unit checks for the column layout-type firewall (no PDF / Marker needed).

Covers the two surgical pieces of the reading-order predecessor fix:
  1. `_assign_layout_types_linear` — geometry → {one-column,left-column,
     right-column} tagging during bucketing.
  2. `_layout_predecessor_ok` — the predecessor state machine the continuation
     linker consults so a right-column head never chains to the wide block above
     it (its logical predecessor is the last left-column block).

Run: `python3 test_layout_firewall.py` (exits non-zero on first failure).
"""
import sys

from extraction import _assign_layout_types_linear, _layout_predecessor_ok
from models import BBox, FullBlock


def _block(x0, x1, *, y0=100.0, y1=130.0, page=1) -> FullBlock:
    return FullBlock(
        role="paragraph",
        text="x",
        page=page,
        bbox=BBox(x0=x0, y0=y0, x1=x1, y1=y1),
        reading_index=0,
    )


def test_assign_layout_types():
    # Content band x ∈ [50, 550] → w=500, mid=300, gutter=25.
    wide = _block(50, 550, y0=100, y1=130)    # reaches both edges → one-column
    left = _block(50, 280, y0=140, y1=200)    # centre 165 < 300   → left-column
    right = _block(320, 550, y0=140, y1=200)  # centre 435 > 300   → right-column
    _assign_layout_types_linear([wide, left, right])
    assert wide.layout_type == "one-column", wide.layout_type
    assert left.layout_type == "left-column", left.layout_type
    assert right.layout_type == "right-column", right.layout_type

    # A gutter-crossing centred block (50%-indented) is also one-column.
    crosser = _block(200, 400, page=2)        # 200<275 and 400>325 → crosses
    edge = _block(60, 240, page=2)            # keeps page-2 bounds at [60,540]
    edge2 = _block(360, 540, page=2)
    _assign_layout_types_linear([crosser, edge, edge2])
    assert crosser.layout_type == "one-column", crosser.layout_type


def test_predecessor_state_machine():
    ok = _layout_predecessor_ok
    # Rule (a): one-column MAY precede left-column.
    assert ok("one-column", "left-column") is True
    # Rule (b): one-column NEVER precedes right-column (the reported mis-link).
    assert ok("one-column", "right-column") is False
    # Rule (c): a right-column head continues the last left-column block …
    assert ok("left-column", "right-column") is True
    # … and a deeper right-column line continues the prior right-column block.
    assert ok("right-column", "right-column") is True
    # Same-column / unrestricted pairings stay open for the lexical+geom gates.
    assert ok("one-column", "one-column") is True
    assert ok("left-column", "left-column") is True
    assert ok("right-column", "left-column") is True
    # An unclassified predecessor can never seed a right-column continuation.
    assert ok(None, "right-column") is False
    assert ok(None, "left-column") is True


def main():
    failures = 0
    for name, fn in (
        ("assign_layout_types", test_assign_layout_types),
        ("predecessor_state_machine", test_predecessor_state_machine),
    ):
        try:
            fn()
            print(f"  PASS {name}")
        except AssertionError as e:
            failures += 1
            print(f"  FAIL {name}: {e}")
    if failures:
        print(f"\n{failures} test(s) failed")
        sys.exit(1)
    print("\nall layout-firewall checks passed")


if __name__ == "__main__":
    main()
