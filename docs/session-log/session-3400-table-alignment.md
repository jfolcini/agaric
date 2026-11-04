# Session 3400 — Tables keep their column alignment (#6277 C2)

Set out to build #6277 C2: a GFM table whose delimiter row is `|:--|--:|:-:|` lost its alignment on its first edit, because the parser dropped the colons and `serializeTable` wrote `---` for every column; the mirrored file would lose it the same way.

**What shipped.** `buildTableRows` reads each column's alignment from the delimiter row onto that column's cells as `attrs.align` (TipTap 3.32's table cells already carry that attribute and draw it as `text-align`, so the schema did not change); an unaligned cell gets no attrs, so existing tables parse as before. `tableDelimiterCell` writes `:---`, `---:`, `:---:` or `---`, and `serializeTable` takes each column's alignment from the first cell in it that has one, since "add row above" inserts unaligned cells over the header. The static view aligns cells, and HTML paste carries a cell's `text-align` or `align` into the delimiter row.

**Review fix.** Agaric writes two tables back to back in one block; a width change split them only when the second delimiter was a bare `---`, so an aligned second table merged into the first on the next parse. `ABSORBED_TABLE_SEPARATOR_CELL` now takes `:?-{3,}:?`.

**Changed existing tests.** Nine `markdown-parse.test.ts` cases parsed aligned delimiter rows and expected cells without alignment, the behaviour this changes: the row-boundary ones compare through `unaligned()`, and the aligned short-dash one expects its alignment.

**For #6304.** The new `block-content.vectors.json` row carries no `rustReads` field; whichever of this PR and #6304 lands second regenerates the file under `CONFORMANCE_UPDATE=1`.

**Tests.** Parse, serialize (including a row added above the header), round-trip seeds and an aligned `arbTable`, the renderer, HTML paste, a page-mode save, a fidelity test for adjacent tables, and `e2e/table-alignment-6277.spec.ts` (an aligned table seeded through IPC, one typo fixed, re-queried after navigating away and back). Gates: full vitest, typecheck, lint, manual-stage hooks and the table and editor Playwright specs (126 tests); the Rust read of the vectors row runs in CI.
