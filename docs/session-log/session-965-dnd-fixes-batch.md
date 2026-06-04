# Session 965 — DnD fixes batch + date picker; LexoRank staged

**Date:** 2026-06-04
**Scope:** First batch of fixes for the drag-and-drop issues filed from the
session-964 review (#400–#408), plus an unrelated date-picker UI fix the user
flagged. The position-scheme root cause (#400) is intentionally staged as its
own dedicated effort — see "LexoRank deferred" below.

## Shipped in this PR

- **Date picker redesign** (`BlockDatePicker.tsx`). The block-editor date
  picker read as an error state: the autofocused input showed a heavy 3px
  `ring-ring/50` ring (≈ `destructive` in the red theme), the absolute close-X
  overlapped the top-edge input, and today's cell used a pink `bg-accent` +
  `ring-primary/50` blob. Fixed with scoped changes only (no shared-component
  churn): soft border + 2px low-opacity focus ring, a header label that
  reserves room for the close button, and a calm inset-ring "today" marker via
  instance `classNames`. Verified by screenshot.

- **R6 / #405 — announce moves on resolution (a11y).**
  `handleIndent/Dedent/MoveUp/MoveDown` announced success *synchronously*, before
  the store action settled — so a boundary no-op or a backend rejection still
  announced "moved" to screen readers. The store's `indent/dedent/moveUp/moveDown`
  now resolve a success boolean (`true` committed, `false` no-op/caught-error,
  still toasted); the handlers announce the real outcome (and scroll) on
  resolution via a shared `announceMoveResult`, with a distinct "Move failed"
  otherwise. Added `announce.moveFailed`.

- **R8 / #407 — drag-overlay subtree badge.** The overlay was an empty pill
  with no sense of how much a subtree drag moves. Added a count badge (active +
  descendants) and folded the count into the SR live-region announcement.

- **R9 / #408 — wontfix as proposed.** The recommended "always-on low-opacity
  grip" was already tried and reverted (#370/#217-B2 — it painted a grip on
  every row and read as "all rows hovered"). Commented the rationale on #408 and
  left it open for a one-time coach-mark instead.

## LexoRank deferred (#400, plus #401 R2 / #402 R3 / #404 R5 / #406 R7)

The four correctness bugs share one root cause: a gapless 1-based integer
`position` that is never renumbered (see session-964 + `docs/dnd-ux-review.md`).
The chosen cure is a fractional/LexoRank string key. A blast-radius survey found
this is a large, sync-sensitive migration: `position` is a **Loro CRDT field**
(not just a SQL column), changing the `MoveBlock`/`CreateBlock` op payload type
breaks **historical op-log replay** (deserialize failure / silent ordering
corruption on rebuild), and it churns 17 snapshots + ~500 test lines + pagination
cursors + generated bindings. No vetted fractional-index library exists in either
ecosystem. Per that risk it is staged as its own effort (#400), to be done
op-log-backcompat-first with replay fuzzing — NOT rushed into this PR. R5
(optimistic drag path) is folded into that change since it rewrites the same
`handleDragEnd` region.

## Verification

- `oxlint` clean; `tsc -b` clean.
- `vitest run` (touched: page-blocks, useBlockKeyboardHandlers, BlockDndOverlay,
  BlockDatePicker): 173/173.
- Date picker change screenshot-verified via Playwright.
