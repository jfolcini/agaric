# PEND-17 — Block history sheet: visible diff-nav + restore-with-preview

## TL;DR

Two issues live in the per-block history sheet (`BlockHistorySheet` →
`HistoryPanel` → `BlockHistoryItem` → `DiffDisplay`):

1. **The "Previous change" / "Next change" buttons inside an expanded diff
   appear to do nothing.** They *do* function (counter updates, `scrollIntoView`
   fires) but produce zero visible feedback in the typical case. **Fix, don't
   delete** — they earn their keep on long edits, but need a visible "active
   hunk" treatment and a smarter scroll heuristic.
2. **"Restore to this point" works but is undiscoverable and commits blind.**
   The button is icon-only, the confirm dialog shows only a timestamp, and
   there's no preview of *what content the block will be reset to*. Make
   restore the primary action of an expanded row, and let the user *see* the
   restored content before committing.

Cost: **S–M** (1 day for diff-nav fix + 1–2 days for restore redesign).
Risk: **low** (UI-only; no schema, IPC, or store changes).
Impact: **high** (turns two confusing affordances into something simple,
intuitive, and powerful — without adding new architecture).

## What the user sees today

The "right sidebar" is `BlockHistorySheet` — a side-drawer opened from a
block's gutter / context menu. It renders `HistoryPanel` (per-block scope),
which lists `BlockHistoryItem` rows. Each `edit_block` row offers two
controls: **Diff** (chevron toggle) and **Reset to this point** (rotate-CCW
icon, tooltip-only label).

When the user expands the diff via the chevron, `DiffDisplay` renders the
word-level diff inline as a single `<p>` with coloured `<ins>` / `<del>`
spans. Below that paragraph, the prev/next "change" navigator appears with a
counter ("1 of N changes").

### Why the prev/next buttons appear inert

- **No visual highlight of the active hunk.** All `<ins>` spans share the
  same green background; all `<del>` spans share the same red. The
  `data-hunk-start` attribute is set on the first span of each hunk but is
  never styled. The "current" hunk is indistinguishable from the others.
- **`scrollIntoView({ block: 'nearest' })` is a no-op when the target is
  already on screen.** For the typical short edit in a narrow sheet, the
  whole diff fits in the viewport — the call fires but nothing moves.
- **The counter is the only feedback** — small grey text at the end of a
  button row most people don't read.
- **Single-hunk diffs still show the nav** — clicking shows "1 of 1 changes"
  and disabled buttons, which reads as "broken" to a first-time user.

So the buttons satisfy their tests (`disables prev at first hunk and next at
last hunk`, `scrollIntoView is called`) without satisfying the user. Classic
"green tests, broken UX" gap.

### Why restore feels weak

- **Icon-only on hover.** Discoverability is poor. The visible "Reset" label
  only appears on `pointer:coarse` (touch) — desktop users see only a
  rotate-CCW icon at the right edge.
- **The confirm dialog shows a timestamp, not a preview.** "Restore to this
  version (Mon 14:32)?" — the user has to expand the diff *first*, read the
  delta, then close it and click restore. Two-step verification with mental
  model carry-over.
- **The diff is the wrong mental model for restore.** The expanded diff
  shows the delta *introduced by that op* (vs. the immediately previous
  version). To know "what will the block look like if I restore here?" the
  user has to mentally accumulate every op since. That's hard.
- **No browse-through-versions affordance.** No arrow-key stepping, no live
  preview as you move between rows.

## Recommended fix

Two small, independently-shippable changes. Neither requires backend work or
store changes.

### Part A — Make diff-nav visible and honest

1. **Highlight the active hunk.** Add a `ring-2 ring-ring/60 rounded-sm` (or
   equivalent semantic-token treatment — `--ring`) on the spans belonging to
   the current hunk. Update the ref/state contract to track *all* spans of a
   hunk, not just its first span, and apply the ring to the contiguous run.
   Use the existing `data-hunk-start` + a new `data-hunk-active` attribute so
   the styling is purely CSS-driven and trivially testable.
2. **Scroll only when needed.** Before calling `scrollIntoView`, check
   whether the active span's bounding rect is inside the nearest scrollable
   ancestor. Skip the call when fully visible. (Cheap: one
   `getBoundingClientRect` + one walk-up to find the scroll container.)
3. **Hide the nav for trivial diffs.** When `hunkStarts.length < 2`, render
   nothing — there's nothing to navigate. (One-liner: `hasHunks &&
   hunkStarts.length > 1`.)
4. **Keep the counter, move it to the left of the buttons.** "1 of 5
   changes  ← Prev  Next →" reads more naturally than "← Prev  Next →  1 of
   5". This is a 2-line JSX swap.

Tests to add (a11y + UX):

- Active hunk receives the ring; previous active hunk loses it.
- Single-hunk diff renders no nav.
- `scrollIntoView` is **not** called when the target span is already in view
  (use a `getBoundingClientRect` mock).

### Part B — Restore with preview

Redesign `BlockHistoryItem` so the row itself is the expansion target:

1. **Click the row → expand.** Replace the dual icon-buttons (Diff + Reset)
   with one click target. Expanded state shows a panel containing:
   - **Top**: a single primary `Button` — `Restore this version` — with the
     timestamp inline. This is the only commit affordance.
   - **Middle**: the block's content **as it would look if restored**,
     rendered read-only via the existing `RichContentRenderer`. The user
     sees the actual content, not just a delta.
   - **Bottom**: a small segmented control (`ToggleGroup`) — `Just this
     change` / `Compared to current`. The first is today's behaviour
     (single-step diff). The second computes a cumulative diff from the
     historical content vs. the live block content and renders via the same
     `DiffDisplay`. This is the missing piece — *what would change if I
     restore?*
2. **Keyboard browse.** With a row focused, `↓` / `↑` move through versions
   and auto-expand the focused one (collapse the previous). `Enter` triggers
   restore (still goes through the existing `ConfirmDialog` for the irreversible
   moment). `Esc` collapses. This turns the sheet into a true "browse
   versions" tool.
3. **Drop the standalone confirm dialog for restore-from-preview.** When the
   user is staring at the restored content with a primary `Restore this
   version` button, a separate "Are you sure?" modal is redundant. Keep the
   existing toast-with-Undo (`history.revertedSuccessfully` + `action.undo`)
   as the safety net — it's already implemented and reversibility is the
   right defence here, not a confirm wall.
4. **Keep the existing IPC.** `editBlock(blockId, parsed.to_text)` already
   does the right thing. The "compared to current" diff is a pure-frontend
   compute on top of the same `DiffSpan[]` shape — reuse the existing
   `computeEditDiff` Tauri command if a backend variant is needed, or fold a
   client-side word-diff if not (the dependency cost should be checked
   first; if a word-diff lib isn't already in the bundle, add a backend
   command instead).

### What gets deleted

- The `Diff` chevron toggle on each row (replaced by row-click expansion).
- The standalone `Reset to this point` icon button (replaced by the in-panel
  primary button).
- The `ConfirmDialog` for the panel-flow restore (toast-with-Undo is the
  safety net; the dialog stays for any other restore entry points).

### What stays

- `useHistoryDiffToggle` hook contract (still used for cache + loading
  state).
- `DiffDisplay` component (still rendered, just inside the new panel layout).
- The toast-with-Undo flow (`HistoryPanel.handleRestore` already snapshots
  and offers Undo — this is exactly the right reversibility signal).
- The non-reversible row treatment (lock icon + opacity).

## Why not delete the prev/next buttons?

Considered. Rejected because:

- For long edits (paragraph rewrites, refactored content blocks) the nav is
  legitimately useful — there's no other way to jump between distant changes
  in a multi-hundred-span diff without manually scrolling.
- Keyboard / SR users have no other way to traverse hunks; deleting the nav
  removes their only programmatic affordance.
- The fix is small (~50 LOC + a few tests). The cost-to-fix ratio beats
  delete-and-rebuild-later.

## Why not a master/detail two-pane layout?

Considered. Rejected because:

- The sheet is narrow (`w-3/4 sm:w-80` ≈ 320 px on desktop). A two-pane
  split inside it is cramped.
- Block-level history is small: most blocks have 5–50 entries, not
  thousands. A linear list with in-place expansion fits the data shape.
- A full-page `HistoryView` already exists for the global op log — that's
  where a two-pane preview would land if we ever wanted one. The per-block
  sheet should stay focused.

## Out of scope

- **Multi-version compare** ("show diff between version 3 and version 7").
  Real ask, but premature for a single-block sheet — file separately if the
  full-page `HistoryView` ever needs it.
- **Branch / fork from a prior version.** Logseq doesn't have it, Notion
  doesn't have it, and our op-log model would need a new op type. Would
  require explicit user approval per [Architectural Stability](../AGENTS.md#architectural-stability).
- **Cross-block "restore page to this point in time".** That's the global
  `HistoryView` revert flow, which already exists.

## Cost / Risk / Impact

| Slice | Cost | Risk | Impact |
| --- | --- | --- | --- |
| A — diff-nav fix | S (~1 day, ~50 LOC + tests) | low (CSS + bounding-rect check) | medium (turns inert UI into honest UI) |
| B — restore-with-preview | S–M (1–2 days, ~150 LOC + tests + i18n) | low (no schema / no IPC / no store) | high (restore becomes simple, intuitive, powerful) |

**Recommended order:** ship A first (small, self-contained, fixes the
immediate confusion), then B as a separate PR (larger, reviewable on its
own merit). They don't share code paths and don't need to land together.

## Open questions for the user

1. **Diff library for "Compared to current"** — is there an existing
   word-diff utility in the bundle, or should this go through a new backend
   `compute_block_vs_current_diff` Tauri command? Backend is the safer
   default (consistent with `computeEditDiff` already there).
2. **Keep the `ConfirmDialog` for non-preview restore entry points?** Today
   `BlockContextMenu` and the gutter shortcut may also surface restore. If
   so, those keep the confirm dialog. If not, the dialog can be deleted
   entirely.
3. **Default diff mode in the new panel** — `Just this change` (matches
   today's behaviour, lower migration cost) or `Compared to current` (more
   useful for the restore decision)? Recommendation: `Compared to current`,
   because the panel's purpose *is* the restore decision.
