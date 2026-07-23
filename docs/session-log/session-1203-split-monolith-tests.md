# Session 1203 — Split two monolith frontend test files

**Date:** 2026-07-23
**Branch:** `refactor/split-monolith-tests`
**Closes:** #2929 (partial — the two largest non-editor monoliths)

## Summary

The frontend suite concentrated in a few multi-thousand-line test files that serialize the
vitest suite and are merge-conflict magnets under the parallel-worktree workflow. This splits
the two largest **non-editor** monoliths into cohesive per-concern files — purely mechanical,
behavior-preserving, **zero tests lost**. (BlockTree/SortableBlock test monoliths were left for
a separate pass to avoid colliding with in-flight editor work.)

## The change

- **`src/stores/__tests__/page-blocks.test.ts`** (6,177 lines, **250 tests**) → **7 files**:
  `page-blocks.crud` (54), `.split-indent` (42), `.move-reparent` (28), `.reorder` (46),
  `.optimistic-invariants` (44), `.undo-registry` (19), `.paste-prefetch` (17). Sum = 250.
- **`src/components/__tests__/PageBrowser.test.tsx`** (4,504 lines, **138 tests**) → **11 files**
  by concern (core-loading, crud, row-interaction-a11y, namespaces, search-filter, sort,
  starred-pages, pagination, density-rows, frontend-hardening, deep-review-fixes). Sum = 138.
- Originals deleted; `PageBrowser.multiselect.test.tsx` (unrelated sibling) left untouched.

## Shared setup

`vi.mock` is per-file hoisted, so each split file got its **own full copy** of the `vi.mock`
blocks + module-level consts/`vi.hoisted`/`beforeEach` it needs (page-blocks: 3 mocks;
PageBrowser: 2), with imports trimmed per-file to what each references. No shared helper module —
chosen to eliminate the hoisting-correctness risk.

## Verification

Independent adversarial review confirmed: baseline counts 250/138 (no `.skip`/`.todo`/`.each`);
post-split **388/388 pass** across 18 files; the `it`/`test` **title-sets are byte-identical**
original-vs-split (no describe-drop); all 3/2 `vi.mock` blocks present in every split file
(spot-checked byte-for-byte); `git diff origin/main --stat` touches only the 2 deleted files
(no non-test source changed). `tsc -b --noEmit` clean, `oxlint` clean, test-file-naming guard
passes.

The `axe-presence in component tests` guard requires every `src/components/__tests__/*.test.tsx`
to carry an `axe()` audit; splitting `PageBrowser.test.tsx` left 4 of the 11 split files without
one (the a11y describe landed only in `PageBrowser.row-interaction-a11y.test.tsx`). A minimal
`axe(container)` audit (mirroring the original's pattern — render → settle → `toHaveNoViolations`)
was added to those 4 (`core-loading`, `crud`, `namespaces`, `pagination`), so all 41 component
test files pass the guard. Final split total: 250 (page-blocks) + 142 (PageBrowser, 138 + 4 new
a11y audits) = **392 pass**.
