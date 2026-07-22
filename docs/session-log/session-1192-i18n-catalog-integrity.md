# Session 1192 — i18n catalog integrity: two missing keys + an exhaustive guard

**Date:** 2026-07-22
**Branch:** `fix/i18n-catalog-integrity`
**Closes:** #2917, #2946

## Summary

Two cohesive i18n fixes shipped together: define two keys that existed only as
inline `defaultValue` fallbacks (#2917), and add the exhaustive missing-key guard
that would have caught them (#2946).

## #2917 — keys existing only as inline defaults

`t('history.foreignOp', { defaultValue: 'Synced from another device (audit-only;
not revertible here)' })` (used twice in `HistoryItemCore.tsx` — sr-only span +
tooltip) and `t('search.filterHelper.dateInvalid', { defaultValue: 'Enter a valid
date (YYYY-MM-DD)' })` (`SearchDateFilterForm.tsx`) referenced keys that were never
defined in the catalog, violating the single-source convention.

- Added `history.foreignOp` to `src/lib/i18n/history.ts` and
  `search.filterHelper.dateInvalid` to `src/lib/i18n/references.ts` (the owning
  namespace file for all `search.*` keys), each **byte-identical** to the removed
  inline default (verified char-for-char — no rendered-text drift).
- Dropped the now-redundant inline `defaultValue` at all three call sites.

## #2946 — exhaustive missing-key guard

`src/lib/i18n/__tests__/catalog-parity.test.ts` (new): imports the same merged
runtime catalog (`i18n.getResourceBundle('en', 'translation')`), statically scans
every non-test `.ts`/`.tsx` under `src/` for string-literal `t('...')` /
`translate('...')` keys (comment-stripped, template-literal/dynamic keys skipped),
and hard-asserts each resolves in the catalog — accounting for i18next plural
suffixes (`_one/_other/_zero/_few/_many/_two`). Failure lists every missing key +
its source file. `KNOWN_MISSING` is empty (0 genuinely-missing keys across ~2019
distinct literal keys after the #2917 fix). The inverse orphan check is
**informational only** (`console.info`) with a documented dynamic-key skiplist —
a hard orphan assertion produced 260+ false positives from
template-literal/lookup-table indirection a static scan can't resolve, so it is
deliberately non-failing.

## Verification

`vitest run` (catalog-parity + existing i18n suite) 116 pass; `tsc -b --noEmit` +
`oxlint` clean. Non-tautology proven: renaming a catalog key makes the guard fail
with a precise key+file message, then restore → green.
