# Session 1010 — /batch-issues loop: frontend rendering/correctness, batch 11 (2026-06-19)

## What happened

Eleventh batch of the `/loop /batch-issues` run, built in worktree `wt-fe11`
concurrently with backend batch 12 in the main checkout: five frontend
correctness findings from the multi-agent deep review, each on a disjoint file
cluster, built by five parallel subagents and adversarially reviewed by five
different reviewers.

## Shipped

Single PR `fix/fe-rendering-deep-review-1`:

- **#1512** (HIGH) — `renderBlock`'s switch had no `bulletList` case, so a
  bulletList node fell through to `default: return null` and rendered nothing
  at-rest in the static view (same vanishing-content class table.tsx fixed for
  tables). Added `renderBulletListBlock` (`<ul className="list-disc list-inside">`)
  mirroring the orderedList sibling and wired `case 'bulletList':` into `renderBlock`.
- **#1534** (LOW) — `renderBlockquoteChild` handled only paragraph/heading and
  dropped any other child (nested list/code/task/blockquote), while
  `parseBlockquote` recurses through full block dispatch. Now recurses through
  `renderBlock` for unhandled child types, with a `MAX_BLOCKQUOTE_DEPTH = 16`
  guard threaded through nested blockquotes (bail placed *after* paragraph/heading
  handling so normal-depth content never truncates).
- **#1533** (LOW) — `renderRichContent` emitted block-level elements
  (h1-h6, ol/ul, table, pre, blockquote) inside the inline `<span>`/`<p>` wrappers
  of the two preview callers (HistoryItemCore line-clamp, DiffDisplay diff span) —
  invalid DOM that also defeats `line-clamp-2`. Added an opt-in `inline?: boolean`
  mode that downgrades blocks to inline-only nodes (text/span/inline marks/inline
  `<code>`); the default path is byte-identical. Both preview callers pass
  `inline: true`.
- **#1525** (MEDIUM) — `QueryExpressionPills` keyed pills by `prop-${pf.key}` /
  `tag-${tag}` with no dedup, so a range (`property:due>=X property:due<=Y`) or
  repeated tag collapsed to identical React keys. Keys are now data-derived with a
  per-base occurrence counter (`prop-${key}-${op}-${value}` + `#N` suffix for true
  dups) — unique AND compliant with the repo's `react/no-array-index-key` lint gate.
- **#1539** (LOW) — `DonePanel` within-group recency sort used
  `b.id.localeCompare(a.id)` (locale/collation-sensitive) to approximate ULID
  order; replaced with a binary codepoint comparison for deterministic
  most-recent-first.
- **#1540** (LOW) — `DuePanel` source-count breakdown classified each block by
  date equality, miscounting a block whose `due_date === scheduled_date === date`.
  Source selection happens in backend SQL (`agendaSource`) and the client receives
  a flat untagged `BlockRow[]`, so true per-source attribution would need a
  backend/IPC change (out of scope). Took the issue-sanctioned fallback: documented
  the breakdown as a date-equality heuristic in priority order (due > scheduled >
  property), with the three buckets mutually exclusive and summing to the visible
  count.
- **#1532** (LOW) — the desktop delete `GutterButton` bound `onDelete` on both
  `onPointerDown` and `onClick`, firing it twice per mouse interaction (no-op the
  second time only because the block id was already gone). Bound the action to a
  single `onClick` (preserving keyboard Enter/Space), with `onPointerDown` doing
  only `stopPropagation` + `preventDefault` for focus retention — mirroring the
  history button.

## Review pass

Five adversarial reviewers, three real CI-gate catches:
- **#1525 reviewer** found the builder's index-based keys (`prop-${i}-…`) violated
  the repo's enforced `react/no-array-index-key: "error"` oxlint rule (hard CI
  failure); reworked to data-derived keys with an occurrence counter.
- **#1539/#1540 reviewer** found `[...blocks].reverse()` in a new test violated
  `unicorn(no-array-reverse)`; fixed to `toReversed()`. Also independently verified
  the #1540 fallback was the only correct client-side option (BlockRow has no
  source tag).
- **#1512/#1534 reviewer** traced the blockquote depth guard for escape paths and
  over-truncation — confirmed sound (the only blockquote→blockquote channel threads
  depth; lists contain only paragraphs).
- **#1533 reviewer** confirmed the default render path is character-for-character
  identical and `renderBlockInline` covers every block type with inline-valid output.
- **#1532 reviewer** confirmed the single-event binding mirrors the history button,
  keyboard activation is intact, and the mobile delete variant never had the bug.

## Notes

- Files: `RichContentRenderer.tsx` (+ `marks/block.tsx`, `marks/blockquote.tsx`),
  `HistoryItemCore.tsx`, `DiffDisplay.tsx`, `query/QueryResult.tsx`,
  `agenda/DonePanel.helpers.ts`, `agenda/DuePanel.tsx`,
  `editor/BlockGutterControls.tsx` (+ their tests, plus new
  `marks/__tests__/list-blockquote.test.tsx`). Frontend-only, no Rust/codegen.
- Built in worktree `wt-fe11`; pushed serially with backend batch 12 to avoid
  concurrent heavy pre-push (OOM).
