# Session 1193 — Export all spaces into one ZIP

**Date:** 2026-07-22
**Branch:** `feat/export-all-spaces`
**Closes:** #2964

## Summary

Add a frontend "Export All Spaces" action that iterates every space and writes each
into its own top-level folder inside a single ZIP, alongside the existing single-space
"Export All". Frontend-only; the raw CRDT/SQLite snapshot backup mentioned in #2964 is a
separate backend effort, intentionally out of scope here.

## The change

- **`src/lib/export-graph.ts`** — extracted `exportSpacePagesIntoZip(zip, spaceId,
  pathPrefix)` from `exportGraphAsZip`, containing the exact page-export /
  attachment-rewrite / collision-dedup logic that was inline. `exportGraphAsZip(spaceId)`
  now calls it with `pathPrefix: ''` — **proven byte-for-byte equivalent** to its prior
  behavior (all pre-existing tests pass unmodified). New `exportAllSpacesAsZip()` calls
  the helper once per space with `pathPrefix: '<folder>/'`, summing skipped
  pages/attachments across spaces into one combined `export-report.txt`. Also extracted
  `disambiguate(base, id, seen)` (the ULID-suffix collision scheme), shared between
  page-path and space-folder-name dedup.
- **Folder naming** — `spaceNameToFolderName(name)` flattens `/`→`_` then runs
  `sanitizeSegment` (never empty; falls back to `Untitled`). Duplicate sanitized names
  disambiguate via the first 8 chars of the space id, then a counter.
- **Zero spaces** — `exportAllSpacesAsZip()` returns `spaceCount` (no throw); DataTab
  shows a distinct `data.exportAllSpacesNoSpaces` warning, no empty ZIP.
- **`src/components/settings/DataTab.tsx`** — new "Export All Spaces" button
  (`data-testid="export-all-spaces-button"`) + `handleExportAllSpaces` mirroring
  `handleExportAll`'s loading/toast shape. Original "Export All" untouched.
- **i18n** — `data.exportAllSpaces{Desc,Button,Success_one/_other,Failed,NoSpaces}` +
  `data.exportingAllSpaces` in `common.ts`.

## Review fix

The zero-spaces branch originally `return`ed from inside the `try` before the trailing
`setExportingAllSpaces(false)` (which was not in a `finally`), leaving the button
disabled forever after a zero-space export. Fixed to `if/else`; added a
`not.toBeDisabled()` regression assertion to the no-spaces test.

## Tests

`export-graph.test.ts` (per-space folder nesting, duplicate-name disambiguation, combined
report, zero-spaces short-circuit, flush-before-list parity) and `DataTab.test.tsx` (new
button downloads / never calls the single-space path; old button unchanged; no-spaces
warning + not-disabled; partial-skip + error toasts; `axe` audit). 5 existing selectors
tightened from `/Export All/i` to exact `'Export All'` (the new name is a superstring).
Non-tautological (breaking the pathPrefix fails 2 tests). 236 pass; tsc + oxlint clean.
