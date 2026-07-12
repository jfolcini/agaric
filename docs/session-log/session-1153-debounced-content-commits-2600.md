## Session 1153 — Debounced mid-typing content commits (#2600) (2026-07-12)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-12 |
| **Subagents** | orchestrator-authored + 1 Explore (FE map) + 1 backend build + 1 adversarial review |
| **Items closed** | `#2600` |
| **Items modified** | — |
| **Tests added** | +7 frontend (undo coalescing ×5, debounce hook ×6 — see files) / +2 backend |
| **Files touched** | 15 |

**Summary:** Shrinks the block-granularity "later blur wins" merge window by committing block
content to the op log on a short idle debounce (~700 ms) while typing, in addition to blur.
The engine already applies each `edit_block` op as a character-level `LoroText` diff-splice,
so committing more frequently lets concurrent edits to different regions of the same block
interleave and merge losslessly instead of a stale blur commit reverting a concurrently-arrived
remote edit. Frontend commit-cadence change only — **no data-model change** (invariant-safe).

**Design decisions (veto-able in the PR):**
- **Undo granularity → coalesce to block-level.** A per-block coalesce key (`edit:<blockId>`)
  threads from the `edit` reducer into the undo store; consecutive same-block commits fold into
  ONE undo entry regardless of the 500 ms timed window, so Ctrl+Z still reverts a block edit as
  a single action (no undo regression). The change only *extends* grouping — the legacy
  within-window burst behavior is untouched.
- **Debounce interval 700 ms** trailing; collapses a typing burst into ≤1 op per idle pause,
  keeping op-log growth bounded (backend diff-splice keeps each payload minimal).

**Selection safety:** the roving editor is uncontrolled after mount (its mount effect keys on
`[isFocused, blockId]`, not `content`), so a store `content` change from the commit never
re-feeds the live editor or perturbs the caret; the commit fires from a timer, not inside a
ProseMirror dispatch, so it cannot trip the #1489 DOMObserver→dispatch loop. A new
`RovingEditorHandle.markCommitted` rebases the delta baseline after each commit so blur does not
re-commit the whole block (no duplicate op / undo entry).

**Files touched (this session):**
- `src/hooks/useDebouncedContentCommit.ts` (new)
- `src/hooks/__tests__/useDebouncedContentCommit.test.tsx` (new)
- `src/editor/use-roving-editor.ts` (+`markCommitted`)
- `src/components/editor/EditableBlock.tsx` (wire hook)
- `src/stores/undo.ts` (+`coalesceKey`)
- `src/stores/page-blocks-reducers.ts` (thread `edit:<blockId>`)
- `src/stores/__tests__/undo.test.ts`, `src/stores/__tests__/page-blocks.test.ts` (tests)
- `src-tauri/src/loro/engine/apply.rs` (+`mod convergence_tests`, 2 tests)
- `docs/architecture/editor-and-content.md`, `docs/FEATURE-MAP.md` (docs)
- test-mock updates: `SortableBlock`, `EditableBlock`, `BlockTree.a11y`, `use-block-flush`,
  `useBlockNavigateToLink` (`markCommitted` added to `RovingEditorHandle` mocks)

**Verification:**
- Backend: `cargo nextest run -E 'test(convergence_tests)'` — green (disjoint edits merge
  losslessly `HELLO WORLD`; stale full-text commit clobbers `Hello WORLD`, non-vacuity checked).
- Frontend: `npx vitest run src/components/editor src/hooks src/stores` — 4359 passed; new
  undo-coalescing + debounce-hook tests green; `npx tsc -b` clean.
- Adversarial reviewer re-verified selection safety, no-double-commit, undo soundness, and the
  backend tests against source.

**Verification gap (flagged for maintainer):** the caret-preservation-during-typing property is
verified architecturally + by unit tests, but NOT by driving the real desktop editor (headless
jsdom cannot faithfully model ProseMirror selection). A quick manual type-with-a-second-peer
check on desktop is worthwhile before/at merge.

**Process notes:** the interactive AskUserQuestion tool failed repeatedly in this environment, so
the undo-granularity fork was resolved with the stated default (coalesce) and surfaced in the PR
for veto rather than blocking.
