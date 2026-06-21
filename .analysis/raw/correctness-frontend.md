# Correctness — Frontend (TypeScript/React)

## Summary
I audited the riskiest frontend logic for correctness bugs: the in-page-find
matcher, markdown parse/serialize round-trip, block keyboard boundary handling
(backspace merge / delete / IME), the undo/redo store with optimistic
reconciliation, the page-blocks structural-move core (indent/dedent/moveBlocks),
the search-query DSL projection + glob validation, and agenda sorting/grouping.

This area is extraordinarily mature. Nearly every hotspot I examined carries an
explicit issue reference (#710-x, #725, #914, #1077, #1437, #1513, etc.) and a
guard for the exact failure mode I would have flagged (length-changing Unicode
folds, zero-width regex matches, mid-flight reconciliation, IME keyCode 229,
cross-node image seams, leading-block-marker re-parse drift). I found **no
CRITICAL or HIGH correctness bugs**. The findings below are genuine but
low-severity edge cases or round-trip gaps that only manifest under narrow
conditions.

### Count by severity
- CRITICAL: 0
- HIGH: 0
- MEDIUM: 1
- LOW: 3

---

### [MEDIUM] List item with multiple leading paragraphs does not round-trip
- **Location**: src/editor/markdown-serialize.ts:709-725 (`serializeListItem`), src/editor/markdown-parse/parser.ts:374-400 (`collectListItem`), 469-487 (`buildListItem`)
- **Evidence**: `serializeListItem` emits the marker (`- ` / `N. `) on the first
  line only and joins every child with `\n` (`return ${marker}${lines.join('\n')}`).
  A non-list child (a second paragraph in the item, or a multi-line paragraph
  produced by a hard break) is serialized via `serializeParagraph` with **no
  indentation**. On reparse, `collectListItem` only collects subsequent lines as
  nested item content when `leadingIndent(line) > 0` (parser.ts:385); an
  unindented continuation line therefore is NOT attached to the item.
  `buildListItem` (parser.ts:481-485) further keeps only `bulletList`/`orderedList`
  among the nested blocks — any nested non-list block is dropped outright.
- **Problem**: A list item whose PM content is `[paragraph, paragraph]` (or a
  paragraph containing a `hardBreak`) serializes to two lines, only the first of
  which carries/keeps the list marker. The reparse turns the second line into a
  separate top-level paragraph, breaking serialize→parse→serialize idempotence.
- **Impact**: Potential structural drift on blur for list items carrying more
  than a single inline paragraph. Whether this is reachable depends on whether
  the block schema permits a `listItem` to hold multiple paragraphs / hard
  breaks; in the single-paragraph-per-block model it may be unreachable.
- **Fix**: Either indent continuation lines of a list item by `LIST_NEST_INDENT`
  in `serializeListItem` (and have `collectListItem` re-attach indented
  non-list continuation lines as item paragraphs), or assert the schema
  guarantees one paragraph per `listItem` and add a round-trip test pinning it.
- **Confidence**: medium — the serialize/parse asymmetry is real in the code;
  reachability depends on the PM schema I did not fully enumerate.
- **Effort**: M

---

### [LOW] `formatRepeatLabel` custom-interval regex omits the yearly unit
- **Location**: src/lib/repeat-utils.ts:27 (`/^(\d+)([dwm])$/`)
- **Evidence**: Named intervals include `yearly` (line 23), but the custom
  numeric-interval branch only matches `d|w|m`. A value like `+2y` (every 2
  years) fails the regex and falls through to `return value`, rendering the raw
  token `+2y` instead of a localized "every 2 years" label.
- **Problem**: Display-only inconsistency: yearly is a first-class named repeat
  but has no custom-N counterpart in the label formatter.
- **Impact**: A user-entered `Ny` repeat property shows the raw string rather
  than a friendly label. No data corruption (this is purely a label fn).
- **Fix**: Add `y` to the unit character class and a `repeat.everyYears` i18n key
  in the `unitKey` ternary — only if the backend repeat grammar accepts `Ny`.
- **Confidence**: low — depends on whether the repeat grammar even allows `Ny`;
  may be intentionally unsupported.
- **Effort**: S

---

### [LOW] `expandBraces` is dead parity code; cap handling differs subtly from doc
- **Location**: src/lib/search-query/glob-validate.ts:141-161
- **Evidence**: The header comment (lines 96-104) states this "currently has no
  production caller" and exists only as a Rust-parity reference pinned by tests.
  The cap loop breaks the outer loop when `next.length > EXPANSION_CAP`, then
  truncates via `next.slice(0, EXPANSION_CAP)`.
- **Problem**: Not a runtime bug (no production caller). The only correctness
  risk is silent divergence from the Rust expander if the backend's truncation
  boundary (`>` vs `>=`, when the cap is hit on a literal vs an alt segment)
  ever differs. The TS truncates the cartesian product *during* alt expansion
  and again per-segment, which could yield a different first-N ordering than a
  backend that expands fully then truncates once.
- **Impact**: None today (dead code). Future drift risk only if a chip-side
  preview consumer is built and the orderings disagree.
- **Fix**: Either delete the unused export or extend the parity test to assert
  identical *ordering* at the cap boundary against a Rust-generated corpus.
- **Confidence**: low — currently unreachable; flagged for parity-drift risk.
- **Effort**: S

---

### [LOW] `moveBlocks` consecutive-slot assumption when moved items are already under the target parent
- **Location**: src/stores/page-blocks.ts:1072-1110
- **Evidence**: `moveBlocks` issues one `moveBlock(id, newParentId, newIndex + k)`
  per ordered id, relying on "the backend's `move_block` slot excludes the block
  being moved, so once block[k] is parked at slot `newIndex + k`, moving
  block[k+1] to slot `newIndex + k + 1` drops it immediately after." This
  reasoning is sound when the moved blocks come from *outside* the destination
  parent. When some moved ids were already children of `newParentId` at
  positions *before* `newIndex`, each such removal shifts the destination
  siblings, and the per-item `newIndex + k` target may not yield the intended
  contiguous run before the final `load()` reconciles.
- **Problem**: Possible transient mis-ordering during a multi-select move whose
  selection overlaps the destination parent's existing children. A full
  `get().load()` runs afterward, so the *final* FE tree matches the backend —
  the user only sees the authoritative result.
- **Impact**: At worst the moved run lands in an order the user didn't intend
  (backend slot arithmetic), not a crash or data loss; reload guarantees FE/BE
  consistency. Likely already correct given how the backend computes dense
  ranks, but the index math depends on backend semantics I could not verify
  from the frontend alone.
- **Fix**: Verify the backend `move_block` slot semantics for the
  same-parent-reorder case; if affected, compute per-item target indices that
  account for already-removed earlier siblings, or move via a single batch IPC.
- **Confidence**: low — depends on backend slot semantics; FE reload masks any
  drift. Noted for the backend-correctness validator to cross-check.
- **Effort**: M

---

## Cross-dimension notes
- None significant. The backspace/IME handling (use-block-keyboard.ts) and the
  undo positional re-anchoring (undo.ts `reanchorAfterRemoteOps`) interact with
  backend op-log indexing; the multi-move and undo-group findings above are the
  only places where FE correctness hinges on backend slot/op-log semantics worth
  a backend cross-check.

## Areas reviewed
- src/lib/in-page-find/matcher.ts — literal/regex scan, Unicode fold offset
  mapping, whole-word surrogate handling, chunked walker. **Robust, no issues.**
- src/editor/markdown-serialize.ts — escaping, mark transitions, link/image
  seams, table/list serialization, leading-block-marker escape. **Robust;** one
  list-item round-trip gap (MEDIUM above).
- src/editor/markdown-parse/parser.ts — block dispatch, list nesting/dedent,
  inline scanner ordering, unclosed-mark revert. **Robust, no issues.**
- src/editor/use-block-keyboard.ts — boundary arrows, Enter/Backspace, IME
  keyCode 229, beforeinput fallback, suggestion-popup/query-hint guards,
  destroyed-editor cleanup. **Robust, no issues.**
- src/stores/undo.ts — optimistic depth, redoGroupSizes clamp invariant,
  in-progress guards, remote-op re-anchor. **Robust, no issues.**
- src/stores/page-blocks.ts — `applyStructuralMove` recompute-at-commit core,
  indent depth guard, `moveBlocks` (LOW above).
- src/lib/block-tree-ops.ts — `planSplit`, `findPrevSiblingAt`,
  `computeIndentedBlocks`. **Robust, no issues.**
- src/lib/agenda-sort.ts — sort key chains, date grouping/overdue logic,
  chronological group ordering. **Robust, no issues.**
- src/lib/search-query/to-search-filter.ts + glob-validate.ts — AST projection,
  comma split, brace expansion. **Robust;** dead-code parity note (LOW).
- src/lib/repeat-utils.ts — label formatting (LOW above).

## Areas NOT reviewed (coverage gaps)
- src/lib/filters/model.ts (44k) — read only the discriminated-union header;
  the per-vocabulary conversion helpers (BacklinkFilter / FilterPrimitive /
  GraphFilter / Ast projection) and their CompareOp/DatePredicate mappings were
  not exhaustively verified for lossy conversions. Recommend a focused pass.
- src/editor/extensions/* (block-link, block-ref, tag-ref pickers, picker-plugin)
  — ProseMirror plugin state/decoration logic not reviewed.
- src/lib/date-utils.ts / parse-date.ts — date math not deep-reviewed (agenda
  date comparisons assume YYYY-MM-DD, which holds).
- Drag fractional-indexing in useBlockDnD.ts and graph simulation hooks — not
  reviewed.
- src/stores/tabs.ts (676 lines) / navigation.ts — active-tab index management
  not reviewed in depth.
