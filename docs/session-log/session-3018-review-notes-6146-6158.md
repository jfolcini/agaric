# Session 3018 — Review notes from #6146 to #6158 and earlier

Set out to clear the non-blocking notes the reviewers left on the PRs merged in the 10-28 sweep. Each note was treated as a hypothesis: premise-checked, then done, dropped with evidence, or deferred to the Rust lane. Three builders worked on disjoint files, one per commit, and one reviewer read all three.

**Done:**
- **Ordinals count only blocks that show a marker.** This applies in block mode (`styleOf`), page mode (`page-lists` `marked`) and the Markdown preview. A heading that still stores a list style no longer takes a number from the run.
- **Page mode's switch reads the blocker fresh** (`changeMode`), rather than from a render-time closure.
- **Enter on a focused selection-bubble button works in block mode.** The keyboard hook now handles only keys aimed at the editor or its container.
- **Code-block colours come from theme tokens.** This covers keyword, built-in, comment, name and section, which github.css or the old dark palette had put under 4.5:1 on `bg-muted`. `block-syntax-reveal.spec.ts` drops its axe exclusion.
- **Deletions:**
  - page mode's `[data-page-block]::after` clearfix (the layout is identical without it);
  - the real-backend twin `page-mode-markdown-return.e2e.ts`;
  - the wdio driver-gate guard (`extract-zip` is gone from the lockfile).
- The mock throws on an unknown `FilterExpr` node.
- The save-cost harness asserts that its cap is `PAGE_MODE_BLOCK_CAP`.
- The `[[` picker folds NFC through `normalizeTagName`.
- A failed linking pass in an import warns through `data.importLinkingFailed`.
- `page-toolbar`'s items are a `Map`.

**Dropped, with what was checked:**
- **The `setPageGroupSpace` move:** `revert.ts` calls it, and `shared.ts` imports `revert.ts`, so the move makes an import cycle.
- **Inlining `placementFor`:** it would raise `BlockRefPeek`'s complexity past the cap.
- **The `role="tab"` override:** dnd-kit sets `role=button`, so the override is needed.
- **The `dndAccessibility` memo:** both callers build it inline.
- **`afterFlush`:** `load()` never rejects.
- **"Redundant" list-style clears:** none is redundant. Each covers a path the page store's `edit` does not reach.
- **The rest:** `followup-deferred.md` lists the items that were speculative, accepted in review, or already tracked elsewhere.

**Deferred to the Rust lane:** the tag-name ASCII fast path, the unwired `restore_all_deleted_inner`, a destination name check on cross-space moves, a stale `handle_create_page` comment, the repeat-until boundary fixture, a lockfile duplicate fold, and an MCP same-space move short-circuit.

**Filed:**
- **#6159:** the keyboard cannot operate the selection bubble.
- **#6160:** `--muted-foreground` on `--muted` is under 4.5:1 in Solarized Dark, Dracula and One Dark Pro. The token move made code comments use that pair.

**Traps:**
- The bubble guard's `currentTarget` clause only matters to unit tests, which dispatch on the container. The container never holds focus.
- In dark themes, `this`/`self` now takes the variable colour, because a later dark rule has the same specificity. It still passes contrast; it is handed to #6160, which reworks these selectors.

**Suites:**
- vitest over `src/` (23,585 tests);
- typecheck and lint;
- the manual-stage hooks;
- Playwright: the keyboard, bubble, syntax-reveal and list-marker specs, every `page-mode-*` spec, and the advanced-query and page-source specs (158).
