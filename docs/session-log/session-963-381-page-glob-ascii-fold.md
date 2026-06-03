# Session 963 — #381: symmetric ASCII case-fold for the page-glob filter

**Date:** 2026-06-03
**Scope:** SQL-review finding #381 (medium) — page-glob search silently fails
to match titles with uppercase non-ASCII letters.

## Symptom

The page-name glob filter lowercased the two sides asymmetrically: the bound
pattern via Rust `str::to_lowercase()` (full Unicode fold) at
`fts/glob_filter.rs:67`, and the column via SQLite's stock
`LOWER(pc.title) GLOB ?` (ASCII A–Z only — no ICU compiled in). For a title
with an uppercase accented/Cyrillic/Greek letter (e.g. `CAFÉ`),
`LOWER('CAFÉ')` = `'cafÉ'` while the pattern became `'*café*'`, and GLOB is
case-sensitive byte comparison, so `'cafÉ' GLOB '*café*'` is false — the page
is invisible to a glob query the user reasonably expects to match.

## Fix

One line: fold the pattern with `to_ascii_lowercase()` instead of
`to_lowercase()`, so both sides fold ASCII A–Z only and identically. Matching
is now case-insensitive for ASCII and exact for non-ASCII letters — symmetric
and predictable, instead of silently unmatched. Doc comment updated to state
the ASCII-fold contract.

(A full Unicode collation would be more correct but is a much larger change —
out of scope; this restores symmetry at zero risk.)

## Verification

- New `ascii_fold_preserves_non_ascii_case_381`: `"CAFÉ"` → `"*cafÉ*"` (C→c
  folds, É preserved), proving symmetry with the column's `LOWER`.
- `cargo nextest` glob_filter suite: 24/24.
