# Session 1000 — Format + Turn into toolbar split, bullet lists (#1960, #1959)

Editor formatting-UX work, stacked on the #1958 Format-popover PR (#1961).

## Shipped

Two distinct always-visible toolbar buttons replace the scattered formatting controls:

- **Format** (`Type` icon) — inline mark toggles (bold/italic/code/strike/highlight/
  underline), reachable at the caret with no selection (and on touch). Unchanged from #1958.
- **Turn into** (`Pilcrow` icon, NEW) — a structural block-type menu that **replaces** the
  standalone Heading / Code block / Callout / Blockquote / Ordered-list / Divider toolbar
  buttons (redundant with a single menu). One-shot: pick an entry → the block converts via a
  new `TURN_INTO_BLOCK` event → `convertBlockContent` + `applyContentEdit` (same path as the
  slash `/turn-*` family and the context-menu Turn-into) → popover closes. The rich sub-pickers
  the removed buttons carried are preserved as **contextual** controls inside the menu, reusing
  `CodeLanguageSelector` (when the block is code) and `CalloutTypeSelector` (when it's a callout).

- **Unordered (bullet) lists (#1959)** folded in: `'bullet-list'` added to `BlockTypeToken` +
  `convertBlockContent` / `detectBlockType` / `turnIdToBlockType`, surfaced in the slash menu
  (`/bullet-list`, `turn-bullet-list`), the context-menu Turn-into group, and the Turn into menu.
  The serializer already round-tripped bullets; this was the missing UI + conversion plumbing.

- **Scrollable, viewport-capped menus**: the shared `PopoverContent` now adds
  `overflow-y-auto overscroll-contain` to its existing `max-h-[calc(100dvh-4rem)]`, so every
  popover scrolls with wheel/touch and never overflows the viewport.

- **`onCallout` made idempotent**: strips any existing block marker before applying, so changing
  an existing callout's type replaces the marker instead of nesting `> [!X] > [!Y] …`.

## Notes

- New component `src/components/editor-toolbar/TurnIntoMenu.tsx`; the dead
  `renderHeading/CodeBlock/CalloutButton` renderers were removed (the selector components they
  used live on, reused by `TurnIntoMenu`).
- Affected e2e specs (toolbar-structural-inserts, callout-picker, toolbar-controls,
  mermaid-roundtrip, keyboard-shortcuts, toolbar-and-blocks) rewritten to drive the Turn into
  menu. The contextual code-language / callout-type pickers need the caret in the block on
  re-open (the active-state read is rAF-coalesced, #1489), so those flows settle briefly first.
- Stacked on `feat/editor-format-popover-bubble-placement` (#1961); retarget to `main` after it
  merges.
