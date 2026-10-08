# Session 1933 — template picker focus ring (#5356)

The user saw a stray blue bar under "Select a template" when opening the
template picker. The picker focuses its first item on open; the item buttons
had no focus styling, so the browser's default outline painted, and the
ScrollArea viewport clipped it on three sides.

What shipped: the item buttons use the app's `focus-ring-visible` with
`[&:focus-visible]:ring-inset`, the idiom the block context menu rows use for
the same reason (`src/components/editor/block-context-menu/menu-row.tsx`).
The ring is a box-shadow drawn inside the button, so the scroll area cannot
clip it, and no shared primitive changed.

Verified: the new test (both classes on every option) went red with the
classes removed (builder, on a copy, restored and `cmp`-checked);
`TemplatePicker.test.tsx` 16 passed; `npm run typecheck` exit 0. Not checked
in a browser.
