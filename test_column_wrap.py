"""Regression for the two-column wrap in `_continuation_geometry_ok` (no PDF).

The bottom of the LEFT column wraps to the top of the RIGHT column — the normal
reading order of a two-column page. A prior "strict column-awareness" guard
rejected EVERY same-page left->right pair, so unfinished left tails never merged
with the right head (Lee et al., 2018: 11 wraps lost). The gate must now allow
the genuine wrap (next right of prev AND jumping upward) while still rejecting
downward / right->left / width-incompatible cross-column pairs.

Run: `python3 test_column_wrap.py`.
"""
import sys

from extraction import _continuation_geometry_ok
from models import BBox


def bb(x0, y0, x1, y1):
    return BBox(x0=x0, y0=y0, x1=x1, y1=y1)


B = (45.0, 546.0)  # page content x-span (both projections pass this)


def geom(prev, nxt, line_h=0.0, pp=1, np_=1):
    return _continuation_geometry_ok(prev, pp, nxt, np_, line_h, (), B, B)


CASES = [
    # (label, prev_bbox, next_bbox, line_h, expected)
    ("genuine wrap (left-bottom -> right-top)",
     bb(47, 462, 288, 604), bb(304, 331, 546, 385), 12.0, True),
    ("bad high-left -> mid-right (downward)",
     bb(47, 100, 288, 150), bb(304, 300, 546, 360), 12.0, False),
    ("right -> left same page (backwards)",
     bb(304, 100, 546, 200), bb(47, 300, 288, 400), 12.0, False),
    ("same-column downward",
     bb(47, 100, 288, 150), bb(47, 160, 288, 210), 0.0, True),
    ("width-incompatible full-width -> narrow column",
     bb(47, 300, 546, 350), bb(304, 100, 546, 160), 12.0, False),
]


def main():
    failures = 0
    for label, prev, nxt, lh, expected in CASES:
        got = geom(prev, nxt, lh)
        ok = got == expected
        print(f"  {'PASS' if ok else 'FAIL'} {label}: got={got} expected={expected}")
        if not ok:
            failures += 1

    # cross-page wrap (page A right/full -> page B left/full) still allowed
    xpage = _continuation_geometry_ok(
        bb(304, 600, 546, 700), 1, bb(47, 80, 288, 160), 2, 12.0, (), B, B
    )
    print(f"  {'PASS' if xpage else 'FAIL'} cross-page wrap still allowed: {xpage}")
    if not xpage:
        failures += 1

    if failures:
        print(f"\n{failures} case(s) failed")
        sys.exit(1)
    print("\nall column-wrap checks passed")


if __name__ == "__main__":
    main()
