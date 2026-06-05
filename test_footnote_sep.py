"""Regression for the footnote-separator cluster filter (no PDF / Marker needed).

A footnote separator is an ISOLATED bottom-region rule. A table/figure grid is
≥2 parallel rules stacked close together. `_isolated_separator_y` must reject the
grid (else a bottom-of-page table's top rule becomes the "separator" and every
block below it — the table's Note and any body text — is dropped as a footnote).

Real case (Lee et al., 2018, page 8): Table 2's 3 grid rules at y=613/631/674
were chosen as a separator at y=613, dropping the table Note AND the Experiment 2
"Participants" paragraph. Page 1's genuine author-note rule (y=629.5) must still
be detected.

Run: `python3 test_footnote_sep.py`.
"""
import sys

from extraction import _isolated_separator_y, _FOOTNOTE_SEP_CLUSTER_GAP


CASES = [
    # (label, rule_tops, expected)
    ("empty",                       [],                    None),
    ("page1 lone separator",        [629.5],               629.5),
    ("page8 Table 2 grid (3 rules)", [613.0, 631.2, 674.2], None),
    ("2-rule grid within gap",      [600.0, 600.0 + _FOOTNOTE_SEP_CLUSTER_GAP - 1], None),
    ("lone rule + grid below",      [560.0, 700.0, 740.0], 560.0),  # 560 isolated, 700/740 cluster
]


def main():
    failures = 0
    for label, ys, expected in CASES:
        got = _isolated_separator_y(list(ys))
        ok = got == expected
        print(f"  {'PASS' if ok else 'FAIL'} {label}: {ys} -> {got} (expected {expected})")
        if not ok:
            failures += 1

    # Documented limitation: two rules spaced WIDER than the cluster gap read as
    # two isolated rules, so a tall 2-rule table could still misfire. Asserted so
    # the behaviour is explicit, not silently assumed safe.
    wide = [600.0, 600.0 + _FOOTNOTE_SEP_CLUSTER_GAP + 10]
    got = _isolated_separator_y(wide)
    print(f"  NOTE limitation — wide 2-rule {wide} -> {got} (picks top; tall 2-rule "
          f"tables not covered by gap={_FOOTNOTE_SEP_CLUSTER_GAP})")
    if got != 600.0:
        failures += 1
        print("  FAIL limitation assertion changed unexpectedly")

    if failures:
        print(f"\n{failures} case(s) failed")
        sys.exit(1)
    print("\nall footnote-separator checks passed")


if __name__ == "__main__":
    main()
