# Agaric — Multi-Agent Deep-Analysis: Global Summary

Eight Opus 4.8 analysis agents (one per dimension) audited the codebase; eight
independent Opus validators then re-checked every finding against the actual code for
hallucinations, exaggerations, already-handled cases, and better approaches. Only
validator-confirmed findings appear below, at validator-corrected severities.

## Headline

**The product is genuinely state-of-the-art in engineering rigor.** Zero CRITICAL
findings. **One HIGH** (a UX safety issue with a trivial fix). Everything else is
MEDIUM/LOW polish. This is the expected shape for a codebase with 1100+ logged sessions,
dozens of prior deep-review passes, fuzzing, proptests, benches, and strict lint/a11y gates.

The validation pass earned its keep: it **killed several false positives** that the raw
pass (or its sub-agents) produced — see "What validation rejected" — so the list below is
high-trust.

Tally (validated, file-worthy): **HIGH 1 · MEDIUM 8 · LOW ~12**.

---

## Recommended to file as issues

### HIGH

**H1 — Destructive tag-delete dialog focuses "Delete" and bypasses i18n** · *ux*
- `src/components/TagList.tsx:390-400` calls the shared `ConfirmDialog` via its legacy
  string path with hardcoded English ("Delete tag?" / "Cancel" / "Delete") and **omits
  `variant="destructive"`**. In `ConfirmDialog.tsx:193-194`, non-destructive means the
  **action (Delete) button gets `autoFocus`** — so a reflex Enter confirms.
- `handleDeleteTag` (`TagList.tsx:126-143`) does `deleteBlock` → `purgeBlock` (hard purge):
  **no undo, no success toast — irreversible.**
- Fix: route through the i18n `ConfirmDialog` API with `t()` strings + `variant="destructive"`
  (flips focus to Cancel), matching every other destructive dialog. Effort: S.

### MEDIUM

**M1 — `restore_block_inner` can create a live orphan under a still-deleted parent** · *correctness (backend)*
- `src-tauri/src/commands/blocks/crud.rs:1037-1083` validates existence/deleted-state but
  **never checks parent liveness**. Reachable via pure UI: delete a child (T1), later delete
  its parent (T2 — cascade skips the already-deleted child, so the child becomes a trash
  root); restoring the child yields a **live block under an invisible, still-deleted parent**
  (`list_children` filters `deleted_at IS NULL`). Same gap in the op-replay projection path.
- Fix: on restore, walk up to the nearest live ancestor (or restore the ancestor chain),
  in both the command and projection paths. Add a regression test. Effort: M.

**M2 — List-item multi-paragraph / hard-break content lost on markdown round-trip** · *correctness (frontend)*
- `ListItem` (default `paragraph block*`) and `HardBreak` are both enabled
  (`src/editor/use-roving-editor.ts:459,467`). A `listItem > paragraph[text, hardBreak, text]`
  (Shift+Enter inside a list) serializes to `"- foo\nbar"`; on reparse, `collectListItem`
  (`src/editor/markdown-parse/parser.ts:385`) ignores the unindented continuation, so `bar`
  splits out as a top-level paragraph and the hard break is lost. The #1333 hardBreak
  property test only covers top-level paragraphs, so this is uncovered.
- Fix: serialize continuation lines with list-item indentation (or a hard-break marker the
  parser re-attaches); extend the round-trip property test to nested list items. Effort: M.

**M3 — tauri-mock parity is structural-only; backend filter/sort/cursor semantics can drift silently** · *maintainability / testing*
- `src/lib/tauri-mock/handlers.ts` (~3.9k lines) reimplements backend filter/sort/cursor
  logic for tests, but `scripts/check-tauri-mock-parity.mjs` only diffs **IPC handler names**
  (bindings vs HANDLERS keys) — handler **behaviour is never compared**. A backend semantics
  change leaves the mock (and the e2e/unit suites built on it) stale and green.
- Fix: add behavioural conformance (shared fixtures/golden vectors exercised against both, or
  a contract test) for the highest-value handlers (pagination cursors, filter eval, sort).
  Effort: M-L. (Good candidate for an issue even if deferred.)

**M4 — Recurrence date-math has zero property-test coverage** · *testing*
- `src-tauri/src/recurrence/parser.rs` is pure, invariant-rich date arithmetic (monotonic
  shift, sticky month-end clamp, euclid month-wrap, i64-overflow guards) but has **only ~28
  example tests and no proptest** (verified: no `proptest!` near it, no regression dir entry).
  It's the one stated-invariant area that didn't get the proptest treatment its peers did.
- Fix: add a proptest (random interval/mode/anchor → assert monotonicity, clamp invariants,
  no panic/overflow). Effort: M. **Strongest testing finding.**

**M5 — Batch restore/purge fails silently** · *ux / robustness*
- `src/components/TrashView.tsx:175-196,232-248`: batch restore/purge `catch` only
  `logger.warn`, then clears selection unconditionally — **no `notify.error`, no live-region
  announce** — while the single-item paths in the same file (`:141`, `:158`) do surface errors.
- Fix: surface a toast + announcement on batch failure; don't clear selection on error. S.

**M6 — DonePanel load failure is indistinguishable from "empty"** · *ux*
- `src/components/.../DonePanel.tsx:93-97,138-141,269`: a thrown load leaves blocks empty and
  renders `null`, identical to a legitimately empty panel — a silent failure.
- Fix: add an error state (retry affordance) distinct from the empty state. S.

**M7 — README dead anchor (uncaught by link checks)** · *docs*
- `README.md:181` links `docs/BUILD.md#android-builds`; BUILD.md only has `#android` and
  `#android-release-signing`. The md-link hook strips fragments and `lychee.toml` has no
  `include_fragments`, so **anchor drift is unguarded** by CI.
- Fix: correct the anchor; consider enabling fragment checking. S.

**M8 — FEATURE-MAP stale source paths** · *docs*
- `docs/FEATURE-MAP.md:23,25` cite `src/editor/StaticBlock.tsx` / `EditableBlock.tsx`; both
  live at `src/components/editor/`. Fix: update paths. S.

### Notable LOW (file if doing a polish pass)

- **L1 — Per-keystroke full-document markdown serialize** of the active block
  (`src/editor/use-roving-editor.ts:558`). The one FE perf item the React Compiler does **not**
  neutralize, on an interactive path. Fix: rAF-coalesce. *(perf; best FE perf candidate)*
- **L2 — `formatRepeatLabel` omits the `y` unit** (`src/lib/repeat-*`): `+2y` renders raw
  though backend supports yearly. Trivial display fix. *(correctness FE)*
- **L3 — `projection.rs` hand-rolls reserved-key→column match arms** instead of reusing the
  existing drift-tested `reserved_key_blocks_column` helper (`recovery.rs:589`); a missing arm
  fails at replay/undo time, not compile time. Fix: reuse the helper. *(maintainability)*
- **L4 — FTS rank keyset: relative-epsilon `WHERE` band vs exact `ORDER BY rank, id`** can
  skip/duplicate a row across a page boundary (`fts/search/fetch.rs:151-152` vs `:265`). Only
  for bm25 ranks differing by <1e-9 exactly at a boundary — vanishingly rare, deliberate
  #1598 trade-off. File as an optional consistency note. *(correctness BE)*
- **L5 — Recurrence `n*7` weekly shift unchecked** (`recurrence/parser.rs:113`) while m/y arms
  use checked math. Proper fix bounds `n` at parse time. *(correctness BE; benign under threat model)*
- **L6 — LIKE … ESCAPE '\\' defeats the range optimization** on tag-prefix lookups
  (`tag_query/resolve.rs:96`). Downgraded to LOW: `tags_cache` is bounded by user vocabulary
  (tens-hundreds of rows, NOCASE-indexed) — microseconds, doesn't scale with vault. Good-first-issue. *(perf)*
- **L7 — Attachment export N+1 IPC** (`export-graph.ts:166`), export-only. *(perf)*
- **L8 — `blockActions` context bag rebuilt via inline arrows** (`use-block-tree-context-bags.ts`)
  — likely neutralized by the React Compiler (confirmed ON, `compilationMode: 'infer'`). *(perf)*
- **L9 — `DateBucket` correlated op_log subquery** (`engine.rs:1180`); clean fix templated by
  `SortJoins::sql`. *(perf)*
- **L10 — Tag-inheritance materialized depth off-by-one** at the `depth<100` boundary (≥101-deep
  single-tag chains): the `#[ignore]`d test at `tag_query/resolve/tests.rs:1485` masks this.
  NOT a production dual-path bug (`resolve_expr_cte` is test-only); cosmetic. Fix the bound +
  un-ignore, or document. *(testing/correctness)*
- **L11 — `formatRelativeTime` test reads a second live clock** (`format-relative-time.test.ts:113`)
  → minute/midnight straddle flake. Fix: stub the clock once. *(testing)*
- **L12 — QrScanner announces raw untranslated error text** via `aria-live="assertive"`
  (`QrScanner.tsx:103,128`) in pairing. *(ux/i18n)*
- **BlockTree.tsx god-component** (1067 lines) vs the documented ~500-line convention
  (`AGENTS.md:239`); clean extraction seam (overlay `useState`). Healthy-code refactor, optional. *(maintainability)*

---

## Cross-cutting themes (worth a small dedicated sweep)

1. **Silent failure on secondary/batch IPC paths** while single-item paths surface errors
   (M5 TrashView batch, M6 DonePanel). A short consistency sweep of batch handlers would pay off.
2. **Two-implementations, one-enforced-structurally** parity risk: the tauri-mock behavioural
   gap (M3) and the projection.rs reserved-key mapping duplication (L3) are the same anti-pattern.
3. **Content-fidelity edge in markdown round-trip** (M2) — the highest-value correctness item.
4. **Property-test coverage** is strong overall; recurrence (M4) is the one notable hole.
5. **Doc drift** is minor and localized (two paths, one anchor, two stale AGENTS.md literals
   — the latter are change-controlled, maintainer-awareness only).

---

## What validation rejected (so you can trust the list above)

- Robustness raw sub-agents' "no error boundaries" and "JSON.parse crashes" **HIGH** claims —
  **false**: `ErrorBoundary`/`FeatureErrorBoundary` exist, every flagged `JSON.parse` is in a
  try/catch with a safe default, the lone production `unwrap` is provably unreachable.
- "Production duplication in `cache/agenda.rs`" — **false**: those are `#[cfg(test)]` helpers.
- "No central reserved-key mapping table exists" — **false**: it exists (`recovery.rs:589`,
  drift-tested); the real (smaller) issue is projection.rs not reusing it (L3).
- "aria-modal pickers lack a Tab focus-trap" — **false**: `TemplatePicker` traps via
  `trapTabFocus`; `JournalCalendarDropdown` is intentionally not `aria-modal`.
- "`expandBraces` parity divergence" — **false**: documented intentional dead parity code.
- "Ignored test masks a production tag-query bug" — **reframed**: test-only path, cosmetic
  off-by-one (L10), not a product-visible dual-path divergence.
- Several perf items dropped as oracle-only paths or documented accepted trade-offs.

---

## Suggested issue grouping (if filing)

- **One HIGH issue**: H1 (tag-delete dialog).
- **Correctness**: M1, M2 (+ optionally L4, L5).
- **Testing**: M4 (proptest), M3 (mock parity — could be testing or maintainability).
- **UX silent-failure sweep**: M5 + M6 (one issue) + L12.
- **Docs**: M7 + M8 (one issue).
- **Perf polish** (optional, one issue): L1 (top), L6, L7, L9.
- **Maintainability** (optional): L3, BlockTree split.
