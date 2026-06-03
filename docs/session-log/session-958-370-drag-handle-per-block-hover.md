# Session 958 — #370 block drag handle: restore per-block hover

**Date:** 2026-06-03
**Scope:** Fix the block gutter drag handle so it reveals on per-block hover only,
instead of being painted on every row at all times.

## Symptom

Reported by the user:

1. Drag-handle grip marks were visible on **every** block even when nothing was
   hovered.
2. Hovering one block "felt like hovering all blocks" — there was no clear
   single-row target, because every row already showed its grip.

## Root cause

`src/components/BlockGutterControls.tsx` — the desktop `dragHandle` deliberately
overrode the shared at-rest hidden state with
`opacity-30 pointer-events-auto`. Every other gutter control uses
`GUTTER_BUTTON_BASE` (`opacity-0 pointer-events-none`, revealed only via
`group-hover:` / `group-focus-within:` / `.block-active`). The override was an
intentional discoverability tweak from #217 (B2) — "teach the reorder affordance
without shouting" — but in practice it painted a grip on every row permanently,
defeating the per-block hover model and adding persistent gutter chrome.

Hover itself was already per-block (each `.sortable-block` is its own Tailwind
`group`); the always-on `opacity-30` just masked that scope.

## Fix

Removed the `opacity-30 pointer-events-auto` override so the desktop drag handle
inherits `GUTTER_BUTTON_BASE` — hidden at rest, revealed on `group-hover` /
`group-focus-within` / `.block-active`, matching every other gutter control
(Notion/Craft/Obsidian-style calm-at-rest, reveal-on-hover). Touch is unchanged
(it renders `touchDragHandle` and keeps the `.block-active` reveal). Keyboard
reorder shortcut, AT `aria-keyshortcuts`, and the context-menu focus-fallback
(`data-context-trigger`) are all preserved.

## Verification

- Updated 3 unit tests that asserted the old `opacity-30` at-rest behaviour to
  assert the new hidden-at-rest / hover-reveal contract
  (`BlockGutterControls.test.tsx`, `SortableBlock.test.tsx` ×2).
- `vitest run` on BlockGutterControls, SortableBlock, mobile-a11y-216 suites:
  245 pass / 0 fail.
- `tsc` clean; `oxlint` clean on changed files.
